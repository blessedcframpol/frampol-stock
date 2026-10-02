-- Lock the current row and write that status. A create writes null.
-- An insert that conflicts writes no transaction: the raise rolls the call back.
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
  v_exists boolean;
  v_inserted integer;
  v_insert_count integer;
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

    CREATE TEMP TABLE _movement_prev (
      serial text PRIMARY KEY,
      previous_status text,
      is_create boolean NOT NULL
    ) ON COMMIT DROP;

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
      LIMIT 1
      FOR UPDATE;

      v_exists := FOUND;

      IF NOT v_exists THEN
        IF rec.type IS DISTINCT FROM 'Inbound' THEN
          RAISE EXCEPTION 'Invalid movement: % requires an existing item (%)', rec.type, rec.serial_number
            USING ERRCODE = 'check_violation';
        END IF;
        INSERT INTO _movement_prev (serial, previous_status, is_create)
        VALUES (rec.serial_number, NULL, true)
        ON CONFLICT (serial) DO NOTHING;
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
        INSERT INTO _movement_prev (serial, previous_status, is_create)
        VALUES (rec.serial_number, v_status, false)
        ON CONFLICT (serial) DO NOTHING;
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
    v_insert_count := jsonb_array_length(p_inventory_inserts);
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
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted IS DISTINCT FROM v_insert_count THEN
      RAISE EXCEPTION 'Inbound insert skipped (% of % rows). The serial is already in stock', v_inserted, v_insert_count
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;

  IF p_transactions IS NOT NULL
     AND jsonb_typeof(p_transactions) = 'array'
     AND jsonb_array_length(p_transactions) > 0 THEN
    IF EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_transactions) AS t(serial_number text)
      WHERE NOT EXISTS (
        SELECT 1 FROM _movement_prev AS prev WHERE prev.serial = t.serial_number
      )
    ) THEN
      RAISE EXCEPTION 'Movement is missing a locked previous status'
        USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO public.transactions (
      id, type, serial_number, item_name, client, date, client_id, invoice_number, notes,
      from_location, to_location, assigned_to, disposal_reason, authorised_by, batch_id,
      delivery_note_url, metadata, created_by, previous_status, previous_status_source
    )
    SELECT
      t.id, t.type, t.serial_number, t.item_name, t.client, t.date, t.client_id, t.invoice_number, t.notes,
      t.from_location, t.to_location, t.assigned_to, t.disposal_reason, t.authorised_by, t.batch_id,
      t.delivery_note_url, t.metadata, t.created_by,
      CASE WHEN prev.is_create THEN NULL ELSE prev.previous_status END,
      'recorded'
    FROM jsonb_to_recordset(p_transactions) AS t(
      id text, type text, serial_number text, item_name text, client text, date text, client_id text,
      invoice_number text, notes text, from_location text, to_location text, assigned_to text,
      disposal_reason text, authorised_by text, batch_id text, delivery_note_url text, metadata jsonb,
      created_by uuid
    )
    JOIN _movement_prev AS prev ON prev.serial = t.serial_number;
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

COMMENT ON FUNCTION public.apply_stock_movement(jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) IS
  'Writes one movement. previous_status comes from the locked inventory row, never the client payload. A create stores null. An Inbound insert that conflicts raises and rolls the call back, so no transaction is kept.';
