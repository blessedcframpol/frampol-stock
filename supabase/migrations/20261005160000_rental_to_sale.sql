-- Convert a rented kit to a sale in one Sale movement.
-- The rental period is stored on that sale. Reverse restores Rented, the rental pool, the client, and the return date.

BEGIN;

CREATE OR REPLACE FUNCTION public.movement_result_status(p_status text, p_type text)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_next text;
BEGIN
  v_next := CASE p_status
    WHEN 'In Stock' THEN CASE p_type
      WHEN 'Sale' THEN 'Sold'
      WHEN 'POC Out' THEN 'POC'
      WHEN 'Rentals' THEN 'Rented'
      WHEN 'Dispose' THEN 'Disposed'
      WHEN 'Transfer' THEN 'In Stock'
      WHEN 'Remediation Loaner Issue' THEN 'Sold'
      ELSE NULL
    END
    WHEN 'Sold' THEN CASE p_type
      WHEN 'Sale Return' THEN 'RMA Hold'
      WHEN 'Decommissioned' THEN 'Pending Inspection'
      ELSE NULL
    END
    WHEN 'POC' THEN CASE p_type
      WHEN 'Sale' THEN 'Sold'
      WHEN 'POC Return' THEN 'In Stock'
      WHEN 'Decommissioned' THEN 'Pending Inspection'
      WHEN 'Transfer' THEN 'POC'
      ELSE NULL
    END
    WHEN 'Rented' THEN CASE p_type
      WHEN 'Sale' THEN 'Sold'
      WHEN 'Rental Return' THEN 'Pending Inspection'
      WHEN 'Decommissioned' THEN 'Pending Inspection'
      WHEN 'Transfer' THEN 'Rented'
      ELSE NULL
    END
    WHEN 'Maintenance' THEN CASE p_type
      WHEN 'Inbound' THEN 'In Stock'
      WHEN 'Dispose' THEN 'Disposed'
      WHEN 'Transfer' THEN 'Maintenance'
      ELSE NULL
    END
    WHEN 'RMA Hold' THEN CASE p_type
      WHEN 'Inbound' THEN 'In Stock'
      WHEN 'Dispose' THEN 'Disposed'
      WHEN 'Transfer' THEN 'RMA Hold'
      ELSE NULL
    END
    WHEN 'Pending Inspection' THEN CASE p_type
      WHEN 'Inspection Pass' THEN 'In Stock'
      WHEN 'Inspection Fail' THEN 'RMA Hold'
      WHEN 'Dispose' THEN 'Disposed'
      WHEN 'Transfer' THEN 'Pending Inspection'
      ELSE NULL
    END
    ELSE NULL
  END;

  IF v_next IS NULL THEN
    RAISE EXCEPTION 'Invalid movement: % from %', p_type, p_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_next;
END;
$$;

COMMENT ON FUNCTION public.movement_result_status(text, text) IS
  'Resulting inventory status for a movement. Sale from Rented is Sold. Twin of lib/movement-transitions.mjs.';

CREATE OR REPLACE FUNCTION public.reversal_predecessors(p_type text)
RETURNS TABLE (status text)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT pair.status
  FROM (VALUES
    ('In Stock', 'Sale'),
    ('POC', 'Sale'),
    ('Rented', 'Sale'),
    ('In Stock', 'POC Out'),
    ('In Stock', 'Rentals'),
    ('In Stock', 'Dispose'),
    ('Maintenance', 'Dispose'),
    ('RMA Hold', 'Dispose'),
    ('Pending Inspection', 'Dispose'),
    ('In Stock', 'Transfer'),
    ('POC', 'Transfer'),
    ('Rented', 'Transfer'),
    ('Maintenance', 'Transfer'),
    ('RMA Hold', 'Transfer'),
    ('Pending Inspection', 'Transfer'),
    ('In Stock', 'Remediation Loaner Issue'),
    ('POC', 'POC Return'),
    ('Rented', 'Rental Return'),
    ('Sold', 'Sale Return'),
    ('Sold', 'Decommissioned'),
    ('POC', 'Decommissioned'),
    ('Rented', 'Decommissioned'),
    ('Maintenance', 'Inbound'),
    ('RMA Hold', 'Inbound'),
    ('Pending Inspection', 'Inspection Pass'),
    ('Pending Inspection', 'Inspection Fail')
  ) AS pair(status, movement)
  WHERE pair.movement = p_type;
$$;

CREATE OR REPLACE FUNCTION public.stamp_rental_to_sale()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_vendor text;
  v_start date;
  v_end date;
  v_sale date;
  v_today date;
  v_days integer;
BEGIN
  IF NEW.type = 'Sale'
     AND COALESCE(NEW.metadata ->> 'converted_from', '') = 'Rentals'
     AND NEW.previous_status IS DISTINCT FROM 'Rented' THEN
    RAISE EXCEPTION 'Convert to sale is only for a rented kit'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.type IS DISTINCT FROM 'Sale' OR NEW.previous_status IS DISTINCT FROM 'Rented' THEN
    RETURN NEW;
  END IF;

  SELECT line.vendor
  INTO v_vendor
  FROM public.inventory_items AS item
  JOIN public.product_lines AS line ON line.id = item.product_id
  WHERE item.serial_number = NEW.serial_number
    AND item.deleted_at IS NULL
  ORDER BY item.id
  LIMIT 1;

  IF COALESCE(v_vendor, '') IS DISTINCT FROM 'Starlink' THEN
    RAISE EXCEPTION 'Convert to sale is only for Starlink kits (%)', NEW.serial_number
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT substring(txn.date FROM 1 FOR 10)::date
  INTO v_start
  FROM public.active_transactions AS txn
  WHERE txn.serial_number = NEW.serial_number
    AND txn.type = 'Rentals'
  ORDER BY txn.date DESC, txn.id DESC
  LIMIT 1;

  IF v_start IS NULL THEN
    RAISE EXCEPTION 'Convert to sale needs the rental start'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.metadata ->> 'rental_end' IS NULL OR NEW.metadata ->> 'rental_end' !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'Rental end date is required'
      USING ERRCODE = 'check_violation';
  END IF;

  BEGIN
    v_end := (NEW.metadata ->> 'rental_end')::date;
  EXCEPTION
    WHEN invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION 'Rental end date is required'
        USING ERRCODE = 'check_violation';
  END;

  v_today := (now() AT TIME ZONE 'Africa/Harare')::date;
  IF v_end < v_start OR v_end > v_today THEN
    RAISE EXCEPTION 'Rental end date must be between the rental start and today'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.date !~ '^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$' THEN
    RAISE EXCEPTION 'Sale date must be a business-date midnight'
      USING ERRCODE = 'check_violation';
  END IF;
  v_sale := substring(NEW.date FROM 1 FOR 10)::date;
  IF v_sale < v_end THEN
    RAISE EXCEPTION 'Sale date cannot be before the rental end date'
      USING ERRCODE = 'check_violation';
  END IF;

  v_days := (v_end - v_start) + 1;

  NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb) || jsonb_build_object(
    'converted_from', 'Rentals',
    'rental_start', to_char(v_start, 'YYYY-MM-DD'),
    'rental_end', to_char(v_end, 'YYYY-MM-DD'),
    'rental_days', v_days
  );
  NEW.after_status := 'Sold';
  NEW.after_client := NEW.previous_client;
  NEW.after_assigned_to := NEW.previous_assigned_to;
  NEW.after_return_date := NULL;

  UPDATE public.inventory_items AS item
  SET
    status = 'Sold',
    client = NEW.previous_client,
    assigned_to = NEW.previous_assigned_to,
    return_date = NULL
  WHERE item.serial_number = NEW.serial_number
    AND item.deleted_at IS NULL;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.stamp_rental_to_sale() IS
  'Sale from Rented records the rental period, keeps the client, and clears the return date. The pool stays in the before-image.';

DROP TRIGGER IF EXISTS tr_transactions_rental_to_sale ON public.transactions;
CREATE TRIGGER tr_transactions_rental_to_sale
  BEFORE INSERT ON public.transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_rental_to_sale();

REVOKE ALL ON FUNCTION public.stamp_rental_to_sale() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stamp_rental_to_sale() TO authenticated, service_role;

COMMIT;
