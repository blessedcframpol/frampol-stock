-- Movement transitions are enforced in the database.
-- public.movement_result_status is the twin of lib/movement-transitions.mjs.
-- apply_stock_movement sets app.movement_type so the status trigger checks the
-- same function. A direct status update without that setting still uses the
-- allow-list, which does not include POC → Sold.

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
      ELSE NULL
    END
    WHEN 'Rented' THEN CASE p_type
      WHEN 'Rental Return' THEN 'In Stock'
      WHEN 'Decommissioned' THEN 'Pending Inspection'
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
  'Resulting inventory status for a movement. Raises when the pair is not allowed. Twin of lib/movement-transitions.mjs.';

REVOKE ALL ON FUNCTION public.movement_result_status(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.movement_result_status(text, text) TO authenticated, service_role;

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
  IF v_type IS NOT NULL THEN
    IF NEW.status IS DISTINCT FROM public.movement_result_status(OLD.status, v_type) THEN
      RAISE EXCEPTION 'Invalid movement: % from % to %', v_type, OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (
    (OLD.status = 'In Stock' AND NEW.status IN ('Sold', 'POC', 'Rented', 'Disposed'))
    OR (OLD.status = 'Maintenance' AND NEW.status IN ('In Stock', 'Disposed'))
    OR (OLD.status = 'POC' AND NEW.status IN ('In Stock', 'Pending Inspection'))
    OR (OLD.status = 'Rented' AND NEW.status IN ('In Stock', 'Pending Inspection'))
    OR (OLD.status = 'Sold' AND NEW.status IN ('In Stock', 'RMA Hold', 'Pending Inspection'))
    OR (OLD.status = 'RMA Hold' AND NEW.status IN ('In Stock', 'Disposed', 'Sold'))
    OR (OLD.status = 'Pending Inspection' AND NEW.status IN ('In Stock', 'RMA Hold', 'Disposed'))
    OR (
      OLD.status = 'Disposed'
      AND NEW.status = 'In Stock'
      AND current_setting('app.quick_scan_reversal', true) = 'on'
    )
    OR (
      OLD.status = 'In Stock'
      AND NEW.status IN ('Maintenance', 'RMA Hold')
      AND current_setting('app.quick_scan_reversal', true) = 'on'
    )
  ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid inventory status transition: % -> %', OLD.status, NEW.status;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_stock_movement(
  p_inventory_upserts jsonb,
  p_inventory_inserts jsonb,
  p_transactions jsonb,
  p_outbound_batch jsonb DEFAULT NULL,
  p_kit_inspection jsonb DEFAULT NULL,
  p_remediation_patch jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_type text;
  v_type_count integer;
  rec record;
  v_item_id text;
  v_status text;
  v_written text;
  v_expected text;
BEGIN
  IF p_transactions IS NOT NULL
     AND jsonb_typeof(p_transactions) = 'array'
     AND jsonb_array_length(p_transactions) > 0 THEN
    SELECT count(DISTINCT t.type)::integer
    INTO v_type_count
    FROM jsonb_to_recordset(p_transactions) AS t(type text);

    IF v_type_count > 1 THEN
      RAISE EXCEPTION 'A stock movement has one type'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT t.type
    INTO v_type
    FROM jsonb_to_recordset(p_transactions) AS t(type text)
    LIMIT 1;

    PERFORM set_config('app.movement_type', v_type, true);

    FOR rec IN
      SELECT t.type, t.serial_number
      FROM jsonb_to_recordset(p_transactions) AS t(type text, serial_number text)
    LOOP
      v_item_id := NULL;
      v_status := NULL;
      SELECT item.id, item.status
      INTO v_item_id, v_status
      FROM public.inventory_items AS item
      WHERE item.serial_number = rec.serial_number
        AND item.deleted_at IS NULL
      ORDER BY item.id
      LIMIT 1;

      IF NOT FOUND THEN
        IF rec.type IS DISTINCT FROM 'Inbound' THEN
          RAISE EXCEPTION 'Invalid movement: % requires an existing item (%)', rec.type, rec.serial_number
            USING ERRCODE = 'check_violation';
        END IF;
      ELSE
        v_expected := public.movement_result_status(v_status, rec.type);
        SELECT u.status
        INTO v_written
        FROM jsonb_to_recordset(COALESCE(p_inventory_upserts, '[]'::jsonb)) AS u(id text, serial_number text, status text)
        WHERE u.id = v_item_id OR u.serial_number = rec.serial_number
        LIMIT 1;

        IF v_written IS NULL THEN
          RAISE EXCEPTION 'Movement % is missing the inventory update for %', rec.type, rec.serial_number
            USING ERRCODE = 'check_violation';
        END IF;
        IF v_written IS DISTINCT FROM v_expected THEN
          RAISE EXCEPTION 'Invalid movement: % from % cannot set %', rec.type, v_status, v_written
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END LOOP;
  END IF;

  IF p_inventory_inserts IS NOT NULL
     AND jsonb_typeof(p_inventory_inserts) = 'array'
     AND jsonb_array_length(p_inventory_inserts) > 0 THEN
    IF v_type IS DISTINCT FROM 'Inbound' THEN
      RAISE EXCEPTION 'New inventory rows are only created by Inbound'
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_inventory_inserts) AS i(status text)
      WHERE i.status IS DISTINCT FROM 'In Stock'
    ) THEN
      RAISE EXCEPTION 'Inbound creates In Stock rows'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF p_outbound_batch IS NOT NULL AND jsonb_typeof(p_outbound_batch) = 'object' THEN
    INSERT INTO public.outbound_batches (
      id, type, client, client_id, start_date, end_date, status, invoice_number, created_at
    )
    SELECT
      b.id, b.type, b.client, b.client_id, b.start_date, b.end_date, b.status, b.invoice_number, b.created_at
    FROM jsonb_to_record(p_outbound_batch) AS b(
      id text, type text, client text, client_id text, start_date text, end_date text,
      status text, invoice_number text, created_at text
    );
  END IF;

  IF p_inventory_upserts IS NOT NULL
     AND jsonb_typeof(p_inventory_upserts) = 'array'
     AND jsonb_array_length(p_inventory_upserts) > 0 THEN
    INSERT INTO public.inventory_items (
      id, product_id, serial_number, status, date_added, location, client, notes, assigned_to,
      purchase_date, warranty_end_date, poc_out_date, return_date, assignment_history,
      reserved_for_request_line_id, cloud_key, deleted_at
    )
    SELECT
      i.id, i.product_id, i.serial_number, i.status, i.date_added, i.location, i.client, i.notes, i.assigned_to,
      i.purchase_date, i.warranty_end_date, i.poc_out_date, i.return_date, i.assignment_history,
      i.reserved_for_request_line_id, i.cloud_key, i.deleted_at
    FROM jsonb_to_recordset(p_inventory_upserts) AS i(
      id text, product_id text, serial_number text, status text, date_added text, location text,
      client text, notes text, assigned_to text, purchase_date text, warranty_end_date text,
      poc_out_date text, return_date text, assignment_history jsonb, reserved_for_request_line_id uuid,
      cloud_key text, deleted_at timestamptz
    )
    ON CONFLICT (id) DO UPDATE
    SET
      product_id = EXCLUDED.product_id,
      serial_number = EXCLUDED.serial_number,
      status = EXCLUDED.status,
      date_added = EXCLUDED.date_added,
      location = EXCLUDED.location,
      client = EXCLUDED.client,
      notes = EXCLUDED.notes,
      assigned_to = EXCLUDED.assigned_to,
      purchase_date = EXCLUDED.purchase_date,
      warranty_end_date = EXCLUDED.warranty_end_date,
      poc_out_date = EXCLUDED.poc_out_date,
      return_date = EXCLUDED.return_date,
      assignment_history = EXCLUDED.assignment_history,
      reserved_for_request_line_id = EXCLUDED.reserved_for_request_line_id,
      cloud_key = EXCLUDED.cloud_key,
      deleted_at = EXCLUDED.deleted_at;
  END IF;

  IF p_inventory_inserts IS NOT NULL
     AND jsonb_typeof(p_inventory_inserts) = 'array'
     AND jsonb_array_length(p_inventory_inserts) > 0 THEN
    INSERT INTO public.inventory_items (
      id, product_id, serial_number, status, date_added, location, client, notes, assigned_to,
      purchase_date, warranty_end_date, poc_out_date, return_date, assignment_history,
      reserved_for_request_line_id, cloud_key, deleted_at
    )
    SELECT
      i.id, i.product_id, i.serial_number, i.status, i.date_added, i.location, i.client, i.notes, i.assigned_to,
      i.purchase_date, i.warranty_end_date, i.poc_out_date, i.return_date, i.assignment_history,
      i.reserved_for_request_line_id, i.cloud_key, i.deleted_at
    FROM jsonb_to_recordset(p_inventory_inserts) AS i(
      id text, product_id text, serial_number text, status text, date_added text, location text,
      client text, notes text, assigned_to text, purchase_date text, warranty_end_date text,
      poc_out_date text, return_date text, assignment_history jsonb, reserved_for_request_line_id uuid,
      cloud_key text, deleted_at timestamptz
    )
    ON CONFLICT (serial_number) WHERE deleted_at IS NULL AND serial_number IS NOT NULL
    DO NOTHING;
  END IF;

  IF p_transactions IS NOT NULL
     AND jsonb_typeof(p_transactions) = 'array'
     AND jsonb_array_length(p_transactions) > 0 THEN
    INSERT INTO public.transactions (
      id, type, serial_number, item_name, client, date, client_id, invoice_number, notes,
      from_location, to_location, assigned_to, disposal_reason, authorised_by, batch_id,
      delivery_note_url, metadata, created_by
    )
    SELECT
      t.id, t.type, t.serial_number, t.item_name, t.client, t.date, t.client_id, t.invoice_number, t.notes,
      t.from_location, t.to_location, t.assigned_to, t.disposal_reason, t.authorised_by, t.batch_id,
      t.delivery_note_url, t.metadata, t.created_by
    FROM jsonb_to_recordset(p_transactions) AS t(
      id text, type text, serial_number text, item_name text, client text, date text, client_id text,
      invoice_number text, notes text, from_location text, to_location text, assigned_to text,
      disposal_reason text, authorised_by text, batch_id text, delivery_note_url text, metadata jsonb,
      created_by uuid
    );
  END IF;

  IF p_kit_inspection IS NOT NULL AND jsonb_typeof(p_kit_inspection) = 'object' THEN
    INSERT INTO public.kit_inspections (
      inventory_item_id, serial_number, inspector_name, outcome, condition_notes,
      attachment_urls, transaction_id, created_by
    )
    SELECT
      k.inventory_item_id, k.serial_number, k.inspector_name, k.outcome, k.condition_notes,
      COALESCE(k.attachment_urls, '{}'::text[]), k.transaction_id, k.created_by
    FROM jsonb_to_record(p_kit_inspection) AS k(
      inventory_item_id text, serial_number text, inspector_name text, outcome text,
      condition_notes text, attachment_urls text[], transaction_id text, created_by uuid
    );
  END IF;

  IF p_remediation_patch IS NOT NULL AND jsonb_typeof(p_remediation_patch) = 'object' THEN
    UPDATE public.remediation_cases rc
    SET
      loaner_inventory_item_id = r.loaner_inventory_item_id,
      loaner_serial = r.loaner_serial,
      updated_at = COALESCE(r.updated_at, now())
    FROM jsonb_to_record(p_remediation_patch) AS r(
      id uuid, loaner_inventory_item_id text, loaner_serial text, updated_at timestamptz
    )
    WHERE rc.id = r.id;
  END IF;
END;
$$;

CREATE TABLE public.holding_extensions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id text NOT NULL REFERENCES public.inventory_items (id) ON DELETE CASCADE,
  serial_number text NOT NULL,
  holding_type text NOT NULL CHECK (holding_type IN ('POC', 'Rental')),
  previous_date text,
  new_date text NOT NULL,
  reason text NOT NULL,
  extended_by uuid NOT NULL REFERENCES public.profiles (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.holding_extensions IS
  'Audit row each time a POC or rental return date is extended. No cap and no counter.';

ALTER TABLE public.holding_extensions ENABLE ROW LEVEL SECURITY;

CREATE POLICY holding_extensions_select
  ON public.holding_extensions
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY holding_extensions_insert
  ON public.holding_extensions
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.get_my_role()) IN ('admin', 'technicians'));

REVOKE ALL ON TABLE public.holding_extensions FROM PUBLIC, anon;
GRANT SELECT, INSERT ON TABLE public.holding_extensions TO authenticated;
GRANT ALL ON TABLE public.holding_extensions TO service_role;

CREATE OR REPLACE FUNCTION public.extend_holding(
  p_item_id text,
  p_new_date text,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_item public.inventory_items%ROWTYPE;
  v_type text;
BEGIN
  v_role := public.get_my_role();
  IF v_role IS DISTINCT FROM 'admin' AND v_role IS DISTINCT FROM 'technicians' THEN
    RAISE EXCEPTION 'Not allowed to extend a holding'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_new_date IS NULL OR p_new_date !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'New date must be YYYY-MM-DD'
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(coalesce(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'A reason is required'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT *
  INTO v_item
  FROM public.inventory_items
  WHERE id = p_item_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Item not found'
      USING ERRCODE = 'no_data_found';
  END IF;
  IF v_item.status NOT IN ('POC', 'Rented') THEN
    RAISE EXCEPTION 'Only POC and rental holdings can be extended'
      USING ERRCODE = 'check_violation';
  END IF;

  v_type := CASE WHEN v_item.status = 'POC' THEN 'POC' ELSE 'Rental' END;

  UPDATE public.inventory_items
  SET return_date = p_new_date
  WHERE id = p_item_id;

  INSERT INTO public.holding_extensions (
    item_id, serial_number, holding_type, previous_date, new_date, reason, extended_by
  )
  VALUES (
    v_item.id,
    v_item.serial_number,
    v_type,
    NULLIF(btrim(coalesce(v_item.return_date, '')), ''),
    p_new_date,
    btrim(p_reason),
    auth.uid()
  );
END;
$$;

COMMENT ON FUNCTION public.extend_holding(text, text, text) IS
  'Updates a POC or rental return date and writes a holding_extensions audit row. Admin and technicians only.';

REVOKE ALL ON FUNCTION public.extend_holding(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.extend_holding(text, text, text) TO authenticated, service_role;

COMMIT;
