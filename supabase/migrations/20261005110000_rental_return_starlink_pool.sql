-- Rental Return lands in Pending Inspection and stays in the rental group.
-- The rental group and Rentals are Starlink only.
-- Change group accepts In Stock or Rented kits, one kit or many, in one call.

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
  'Resulting inventory status for a movement. Rental Return is Pending Inspection. Twin of lib/movement-transitions.mjs.';

CREATE OR REPLACE FUNCTION public.reversal_pair_allowed(p_current text, p_original_type text, p_restore text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_next text;
BEGIN
  IF p_original_type IS NULL OR p_original_type = 'Reversal' OR p_restore IS NULL THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.reversal_predecessors(p_original_type) AS predecessor
    WHERE predecessor.status = p_restore
  ) THEN
    RETURN false;
  END IF;
  -- A rental return still restores to Rented. Newer returns are Pending Inspection.
  -- Returns already recorded as In Stock stay reversible to Rented.
  IF p_original_type = 'Rental Return'
     AND p_restore = 'Rented'
     AND p_current IN ('Pending Inspection', 'In Stock') THEN
    RETURN true;
  END IF;
  BEGIN
    v_next := public.movement_result_status(p_restore, p_original_type);
  EXCEPTION
    WHEN check_violation THEN
      RETURN false;
  END;
  RETURN v_next IS NOT DISTINCT FROM p_current;
END;
$$;

COMMENT ON FUNCTION public.reversal_pair_allowed(text, text, text) IS
  'True when restoring p_restore is a legal predecessor of the original movement and yields the current status. A rental return may currently be Pending Inspection or, for an older return, In Stock.';

CREATE OR REPLACE FUNCTION public.inventory_items_guard_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_type text;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;
  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  v_type := NULLIF(current_setting('app.movement_type', true), '');
  IF v_type IS NULL THEN
    RAISE EXCEPTION 'Invalid inventory status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_type = 'Reversal' THEN
    IF NOT public.reversal_pair_allowed(
      OLD.status,
      NULLIF(current_setting('app.reversal_original_type', true), ''),
      NEW.status
    ) THEN
      RAISE EXCEPTION 'Invalid reversal: % from % to %',
        NULLIF(current_setting('app.reversal_original_type', true), ''),
        OLD.status,
        NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF v_type = 'Rentals' AND NOT EXISTS (
    SELECT 1
    FROM public.product_lines AS line
    WHERE line.id = NEW.product_id
      AND line.vendor = 'Starlink'
  ) THEN
    RAISE EXCEPTION 'Rentals is only for Starlink kits (%)', NEW.serial_number
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status IS DISTINCT FROM public.movement_result_status(OLD.status, v_type) THEN
    RAISE EXCEPTION 'Invalid movement: % from % to %', v_type, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.change_stock_pool(p_item_id text, p_pool text, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_item public.inventory_items%ROWTYPE;
  v_vendor text;
BEGIN
  IF (SELECT public.get_my_role()) IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'change_stock_pool: admin only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_pool IS NULL OR p_pool NOT IN ('sale', 'rental', 'demo') THEN
    RAISE EXCEPTION 'change_stock_pool: pool must be sale, rental, or demo'
      USING ERRCODE = 'check_violation';
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 15 THEN
    RAISE EXCEPTION 'change_stock_pool: reason must be at least 15 characters'
      USING ERRCODE = 'check_violation';
  END IF;
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'change_stock_pool: admin only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT *
  INTO v_item
  FROM public.inventory_items
  WHERE id = p_item_id
    AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'change_stock_pool: item not found'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_item.status NOT IN ('In Stock', 'Rented') THEN
    RAISE EXCEPTION 'change_stock_pool: only an In Stock or Rented kit can change group'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_item.stock_pool = p_pool THEN
    RAISE EXCEPTION 'change_stock_pool: kit is already %', p_pool
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT line.vendor
  INTO v_vendor
  FROM public.product_lines AS line
  WHERE line.id = v_item.product_id;

  IF p_pool = 'rental' AND v_vendor IS DISTINCT FROM 'Starlink' THEN
    RAISE EXCEPTION 'change_stock_pool: the rental group is only for Starlink kits'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.inventory_items
  SET stock_pool = p_pool
  WHERE id = v_item.id;

  INSERT INTO public.stock_pool_changes (
    inventory_item_id, serial_number, from_pool, to_pool, reason, changed_by
  )
  VALUES (v_item.id, v_item.serial_number, v_item.stock_pool, p_pool, btrim(p_reason), auth.uid());
END;
$$;

COMMENT ON FUNCTION public.change_stock_pool(text, text, text) IS
  'Admin changes the group of an In Stock or Rented kit. The rental group is Starlink only. Appends one stock_pool_changes row.';

CREATE OR REPLACE FUNCTION public.change_stock_pools(p_item_ids text[], p_pool text, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_id text;
  v_count integer;
BEGIN
  SELECT count(*)::integer
  INTO v_count
  FROM (SELECT DISTINCT btrim(id) AS id FROM unnest(COALESCE(p_item_ids, ARRAY[]::text[])) AS id) AS chosen
  WHERE chosen.id <> '';

  IF v_count < 1 THEN
    RAISE EXCEPTION 'change_stock_pools: choose at least one kit'
      USING ERRCODE = 'check_violation';
  END IF;

  FOR v_id IN
    SELECT chosen.id
    FROM (SELECT DISTINCT btrim(id) AS id FROM unnest(p_item_ids) AS id) AS chosen
    WHERE chosen.id <> ''
    ORDER BY chosen.id
  LOOP
    PERFORM public.change_stock_pool(v_id, p_pool, p_reason);
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.change_stock_pools(text[], text, text) IS
  'Admin changes the group of several In Stock or Rented kits with one reason. All kits update, or none do. One history row per kit.';

REVOKE ALL ON FUNCTION public.change_stock_pools(text[], text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.change_stock_pools(text[], text, text) TO authenticated, service_role;

COMMIT;
