-- Exact before-image and after-image on every movement, then reverse and restore.

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS previous_location text,
  ADD COLUMN IF NOT EXISTS previous_client text,
  ADD COLUMN IF NOT EXISTS previous_assigned_to text,
  ADD COLUMN IF NOT EXISTS previous_poc_out_date text,
  ADD COLUMN IF NOT EXISTS previous_return_date text,
  ADD COLUMN IF NOT EXISTS after_status text,
  ADD COLUMN IF NOT EXISTS after_location text,
  ADD COLUMN IF NOT EXISTS after_client text,
  ADD COLUMN IF NOT EXISTS after_assigned_to text,
  ADD COLUMN IF NOT EXISTS after_poc_out_date text,
  ADD COLUMN IF NOT EXISTS after_return_date text;

COMMENT ON COLUMN public.transactions.previous_location IS
  'Location on the locked inventory row before this movement. Null on a create. Never taken from the client payload.';
COMMENT ON COLUMN public.transactions.previous_client IS
  'Client on the locked inventory row before this movement. Null on a create.';
COMMENT ON COLUMN public.transactions.previous_assigned_to IS
  'Assigned-to on the locked inventory row before this movement. Null on a create.';
COMMENT ON COLUMN public.transactions.previous_poc_out_date IS
  'POC-out date on the locked inventory row before this movement. Null on a create.';
COMMENT ON COLUMN public.transactions.previous_return_date IS
  'Return date on the locked inventory row before this movement. Null on a create.';
COMMENT ON COLUMN public.transactions.after_return_date IS
  'Return date on the inventory row after this movement. POC Out and Rentals store the date they wrote. Extend stores its new date on holding_extensions.new_date.';

CREATE TABLE IF NOT EXISTS public.batch_restores (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id text NOT NULL REFERENCES public.batch_reversals (batch_id),
  restored_at timestamptz NOT NULL DEFAULT now(),
  restore_reason text NOT NULL,
  restored_by text
);

COMMENT ON TABLE public.batch_restores IS
  'Append-only restore of a reversed or voided batch. The reversal rows and batch_reversals row stay.';

ALTER TABLE public.batch_restores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin full access batch_restores" ON public.batch_restores;
CREATE POLICY "Admin full access batch_restores"
  ON public.batch_restores FOR ALL
  TO authenticated
  USING ((SELECT public.get_my_role()) = 'admin')
  WITH CHECK ((SELECT public.get_my_role()) = 'admin');

DROP POLICY IF EXISTS "Non-admin read batch_restores" ON public.batch_restores;
CREATE POLICY "Non-admin read batch_restores"
  ON public.batch_restores FOR SELECT
  TO authenticated
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians', 'viewer'));

GRANT SELECT ON public.batch_restores TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.batch_is_currently_reversed(p_batch_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.batch_reversals AS reversal
    WHERE reversal.batch_id = p_batch_id
      AND reversal.reversed_at >= COALESCE(
        (
          SELECT max(restored.restored_at)
          FROM public.batch_restores AS restored
          WHERE restored.batch_id = reversal.batch_id
        ),
        '-infinity'::timestamptz
      )
  );
$$;

COMMENT ON FUNCTION public.batch_is_currently_reversed(text) IS
  'True when the latest reversal or void of this batch is newer than its latest restore.';

REVOKE ALL ON FUNCTION public.batch_is_currently_reversed(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.batch_is_currently_reversed(text) TO authenticated, service_role;

CREATE OR REPLACE VIEW public.active_transactions
WITH (security_invoker = true) AS
SELECT transactions.*
FROM public.transactions AS transactions
WHERE transactions.type IS DISTINCT FROM 'Reversal'
  AND NOT public.batch_is_currently_reversed(transactions.batch_id);

COMMENT ON VIEW public.active_transactions IS
  'Transactions that still count. A Reversal row is excluded. A reversed or voided batch is excluded until it is restored.';

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
  v_location text;
  v_client text;
  v_assigned text;
  v_poc text;
  v_return text;
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
      previous_location text,
      previous_client text,
      previous_assigned_to text,
      previous_poc_out_date text,
      previous_return_date text,
      is_create boolean NOT NULL
    ) ON COMMIT DROP;

    FOR rec IN
      SELECT t.type, t.serial_number
      FROM jsonb_to_recordset(p_transactions) AS t(type text, serial_number text)
    LOOP
      v_item_id := NULL;
      v_status := NULL;
      SELECT item.id, item.status, item.location, item.client, item.assigned_to,
             item.poc_out_date, item.return_date
      INTO v_item_id, v_status, v_location, v_client, v_assigned, v_poc, v_return
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
        INSERT INTO _movement_prev (
          serial, previous_status, previous_location, previous_client, previous_assigned_to,
          previous_poc_out_date, previous_return_date, is_create
        )
        VALUES (rec.serial_number, NULL, NULL, NULL, NULL, NULL, NULL, true)
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
        INSERT INTO _movement_prev (
          serial, previous_status, previous_location, previous_client, previous_assigned_to,
          previous_poc_out_date, previous_return_date, is_create
        )
        VALUES (rec.serial_number, v_status, v_location, v_client, v_assigned, v_poc, v_return, false)
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

    IF EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_transactions) AS t(serial_number text)
      WHERE NOT EXISTS (
        SELECT 1 FROM public.inventory_items AS item WHERE item.serial_number = t.serial_number
      )
    ) THEN
      RAISE EXCEPTION 'Movement is missing the inventory row it just wrote'
        USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO public.transactions (
      id, type, serial_number, item_name, client, date, client_id, invoice_number, notes,
      from_location, to_location, assigned_to, disposal_reason, authorised_by, batch_id,
      delivery_note_url, metadata, created_by, previous_status, previous_status_source,
      previous_location, previous_client, previous_assigned_to, previous_poc_out_date, previous_return_date,
      after_status, after_location, after_client, after_assigned_to, after_poc_out_date, after_return_date
    )
    SELECT
      t.id, t.type, t.serial_number, t.item_name, t.client, t.date, t.client_id, t.invoice_number, t.notes,
      t.from_location, t.to_location, t.assigned_to, t.disposal_reason, t.authorised_by, t.batch_id,
      t.delivery_note_url, t.metadata, t.created_by,
      CASE WHEN prev.is_create THEN NULL ELSE prev.previous_status END,
      'recorded',
      CASE WHEN prev.is_create THEN NULL ELSE prev.previous_location END,
      CASE WHEN prev.is_create THEN NULL ELSE prev.previous_client END,
      CASE WHEN prev.is_create THEN NULL ELSE prev.previous_assigned_to END,
      CASE WHEN prev.is_create THEN NULL ELSE prev.previous_poc_out_date END,
      CASE WHEN prev.is_create THEN NULL ELSE prev.previous_return_date END,
      after_row.status, after_row.location, after_row.client, after_row.assigned_to,
      after_row.poc_out_date, after_row.return_date
    FROM jsonb_to_recordset(p_transactions) AS t(
      id text, type text, serial_number text, item_name text, client text, date text, client_id text,
      invoice_number text, notes text, from_location text, to_location text, assigned_to text,
      disposal_reason text, authorised_by text, batch_id text, delivery_note_url text, metadata jsonb,
      created_by uuid
    )
    JOIN _movement_prev AS prev ON prev.serial = t.serial_number
    JOIN LATERAL (
      SELECT item.status, item.location, item.client, item.assigned_to, item.poc_out_date, item.return_date
      FROM public.inventory_items AS item
      WHERE item.serial_number = t.serial_number
      ORDER BY item.deleted_at NULLS FIRST, item.id
      LIMIT 1
    ) AS after_row ON true;
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
  'Writes one movement. previous_status and the other previous_* fields come from the locked inventory row, never the client payload. A create stores null. after_* is read back from the inventory row after the write. An Inbound insert that conflicts raises and rolls the call back, so no transaction is kept.';

COMMENT ON COLUMN public.holding_extensions.new_date IS
  'The return date Extend wrote. POC Out and Rentals store theirs on transactions.after_return_date.';

CREATE OR REPLACE FUNCTION public.reverse_restore_plan(p_batch_id text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  rec record;
  v_rows jsonb := '[]'::jsonb;
  v_status text;
  v_client text;
  v_assigned text;
  v_location text;
  v_poc text;
  v_return text;
  v_needs jsonb;
  v_image boolean;
  v_soft boolean;
  v_converted boolean;
BEGIN
  IF (SELECT public.get_my_role()) IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'reverse_restore_plan: forbidden';
  END IF;

  FOR rec IN
    SELECT ranked.*
    FROM (
      SELECT
        t.*,
        row_number() OVER (
          PARTITION BY t.serial_number
          ORDER BY public.transaction_record_time(t.id, t.created_at, t.date), t.id
        ) AS ordinal
      FROM public.transactions AS t
      WHERE t.batch_id = p_batch_id
        AND t.type IS DISTINCT FROM 'Reversal'
    ) AS ranked
    WHERE ranked.ordinal = 1
    ORDER BY ranked.id
  LOOP
    v_image := false;
    v_soft := false;
    v_converted := false;
    v_status := NULL;
    v_client := NULL;
    v_assigned := NULL;
    v_location := NULL;
    v_poc := NULL;
    v_return := NULL;
    v_needs := '[]'::jsonb;

    IF rec.previous_status IS NULL THEN
      v_soft := true;
    ELSIF rec.previous_location IS NOT NULL THEN
      v_image := true;
      v_status := rec.previous_status;
      v_location := rec.previous_location;
      v_client := rec.previous_client;
      v_assigned := rec.previous_assigned_to;
      v_poc := rec.previous_poc_out_date;
      v_return := rec.previous_return_date;
      IF rec.previous_status_source = 'unknown' THEN
        v_needs := jsonb_build_array('status');
      END IF;
    ELSIF rec.type IN ('POC Return', 'Rental Return', 'Sale Return') THEN
      v_status := rec.previous_status;
      v_client := NULLIF(btrim(rec.client), '');
      v_assigned := NULLIF(btrim(rec.assigned_to), '');
      v_location := CASE
        WHEN v_status IN ('POC', 'Rented') THEN 'Client Site'
        WHEN v_status = 'Sold' THEN 'Delivered'
        ELSE NULL
      END;
      SELECT left(outbound.date, 10)
      INTO v_poc
      FROM public.transactions AS outbound
      WHERE outbound.serial_number = rec.serial_number
        AND outbound.type IN ('POC Out', 'Rentals')
        AND public.transaction_record_time(outbound.id, outbound.created_at, outbound.date)
            < public.transaction_record_time(rec.id, rec.created_at, rec.date)
        AND NOT public.batch_is_currently_reversed(outbound.batch_id)
      ORDER BY public.transaction_record_time(outbound.id, outbound.created_at, outbound.date) DESC, outbound.id DESC
      LIMIT 1;
      IF v_status IN ('POC', 'Rented') THEN
        v_needs := jsonb_build_array('return_date');
      END IF;
      IF v_location IS NULL THEN
        v_needs := v_needs || jsonb_build_array('location');
      END IF;
      IF rec.previous_status_source = 'unknown' THEN
        v_needs := v_needs || jsonb_build_array('status');
      END IF;
    ELSIF rec.type = 'Sale'
      AND (
        rec.previous_status = 'POC'
        OR COALESCE(rec.metadata ->> 'converted_from', '') = 'POC'
      ) THEN
      v_converted := true;
      v_status := 'POC';
      v_client := NULLIF(btrim(rec.client), '');
      v_assigned := NULLIF(btrim(rec.assigned_to), '');
      v_location := 'Client Site';
      v_poc := NULLIF(btrim(COALESCE(rec.metadata ->> 'poc_out_date', '')), '');
      v_needs := jsonb_build_array('return_date');
    ELSIF rec.type = 'Transfer' THEN
      v_status := rec.previous_status;
      v_location := NULLIF(btrim(rec.from_location), '');
      SELECT item.client, item.assigned_to, item.poc_out_date, item.return_date
      INTO v_client, v_assigned, v_poc, v_return
      FROM public.inventory_items AS item
      WHERE item.serial_number = rec.serial_number
      ORDER BY item.deleted_at NULLS FIRST, item.id
      LIMIT 1;
      IF v_location IS NULL THEN
        v_needs := jsonb_build_array('location');
      END IF;
      IF rec.previous_status_source = 'unknown' THEN
        v_needs := v_needs || jsonb_build_array('status');
      END IF;
    ELSE
      v_status := rec.previous_status;
      IF rec.previous_status_source = 'unknown' THEN
        v_needs := jsonb_build_array('status', 'location');
      ELSE
        v_needs := jsonb_build_array('location');
      END IF;
    END IF;

    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'transactionId', rec.id,
      'serial', rec.serial_number,
      'hasImage', v_image,
      'softDelete', v_soft,
      'status', v_status,
      'client', v_client,
      'assignedTo', v_assigned,
      'location', v_location,
      'pocOutDate', v_poc,
      'returnDate', v_return,
      'needs', v_needs,
      'converted', v_converted
    ));
  END LOOP;

  RETURN jsonb_build_object('batchId', p_batch_id, 'rows', v_rows);
END;
$$;

COMMENT ON FUNCTION public.reverse_restore_plan(text) IS
  'What reverse would write. A recorded before-image is exact. Legacy rows reconstruct only a return holder, a converted-sale client and POC date, or a transfer origin. Other fields are listed in needs.';

REVOKE ALL ON FUNCTION public.reverse_restore_plan(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_restore_plan(text) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.reverse_quick_scan_batch(text, text, text, jsonb);

CREATE FUNCTION public.reverse_quick_scan_batch(
  p_batch_id text,
  p_reason text,
  p_return_location text DEFAULT NULL,
  p_confirmed jsonb DEFAULT '[]'::jsonb,
  p_entered jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_type text;
  v_type_count integer;
  v_tz text;
  v_date text;
  v_reversal_batch text;
  v_later_batch text;
  v_later_serial text;
  v_count integer;
  v_plan jsonb;
BEGIN
  IF (SELECT public.get_my_role()) IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: forbidden';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 15 THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: reason must be at least 15 characters';
  END IF;
  IF p_batch_id IS NULL OR btrim(p_batch_id) = '' THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: batch_id is required';
  END IF;
  IF public.batch_is_currently_reversed(p_batch_id) THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: batch % is already reversed', p_batch_id;
  END IF;

  SELECT count(*)::integer, count(DISTINCT type)::integer, min(type)
  INTO v_count, v_type_count, v_type
  FROM public.transactions
  WHERE batch_id = p_batch_id
    AND type IS DISTINCT FROM 'Reversal';

  IF v_count = 0 THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: no transactions found for %', p_batch_id;
  END IF;
  IF v_type_count <> 1 THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: batch % mixes movement types', p_batch_id;
  END IF;
  IF v_type = 'Reversal' THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: a Reversal cannot be reversed';
  END IF;

  SELECT later.batch_id, orig.serial_number
  INTO v_later_batch, v_later_serial
  FROM public.transactions AS orig
  JOIN public.transactions AS later
    ON later.serial_number = orig.serial_number
   AND later.id <> orig.id
   AND later.type IS DISTINCT FROM 'Reversal'
   AND later.batch_id IS DISTINCT FROM orig.batch_id
   AND NOT public.batch_is_currently_reversed(later.batch_id)
   AND (
     public.transaction_record_time(later.id, later.created_at, later.date)
       > public.transaction_record_time(orig.id, orig.created_at, orig.date)
     OR (
       public.transaction_record_time(later.id, later.created_at, later.date)
         = public.transaction_record_time(orig.id, orig.created_at, orig.date)
       AND later.id > orig.id
     )
   )
  WHERE orig.batch_id = p_batch_id
    AND orig.type IS DISTINCT FROM 'Reversal'
  ORDER BY later.batch_id
  LIMIT 1;

  IF v_later_batch IS NOT NULL THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: % is blocked by later batch %', v_later_serial, v_later_batch;
  END IF;

  v_plan := public.reverse_restore_plan(p_batch_id);

  DROP TABLE IF EXISTS _rev_final;
  CREATE TEMP TABLE _rev_final ON COMMIT DROP AS
  SELECT
    plan."transactionId" AS transaction_id,
    plan.serial,
    plan."softDelete" AS soft_delete,
    plan.needs,
    CASE
      WHEN plan."softDelete" THEN NULL
      WHEN plan.needs @> '["status"]'::jsonb THEN NULLIF(btrim(confirmed.status), '')
      ELSE plan.status
    END AS restore_status,
    plan.client AS restore_client,
    plan."assignedTo" AS restore_assigned,
    CASE
      WHEN plan.needs @> '["location"]'::jsonb THEN COALESCE(
        NULLIF(btrim(entered.location), ''),
        NULLIF(btrim(p_return_location), '')
      )
      ELSE plan.location
    END AS restore_location,
    plan."pocOutDate" AS restore_poc,
    CASE
      WHEN plan.needs @> '["return_date"]'::jsonb THEN NULLIF(btrim(entered.return_date), '')
      ELSE plan."returnDate"
    END AS restore_return,
    item.status AS locked_status,
    item.location AS locked_location,
    item.client AS locked_client,
    item.assigned_to AS locked_assigned,
    item.poc_out_date AS locked_poc,
    item.return_date AS locked_return
  FROM jsonb_to_recordset(COALESCE(v_plan -> 'rows', '[]'::jsonb)) AS plan(
    "transactionId" text,
    serial text,
    "softDelete" boolean,
    status text,
    client text,
    "assignedTo" text,
    location text,
    "pocOutDate" text,
    "returnDate" text,
    needs jsonb
  )
  JOIN public.inventory_items AS item
    ON item.serial_number = plan.serial
   AND item.deleted_at IS NULL
  LEFT JOIN jsonb_to_recordset(COALESCE(p_confirmed, '[]'::jsonb)) AS confirmed(transaction_id text, status text)
    ON confirmed.transaction_id = plan."transactionId"
  LEFT JOIN jsonb_to_recordset(COALESCE(p_entered, '[]'::jsonb)) AS entered(
    transaction_id text,
    location text,
    return_date text
  ) ON entered.transaction_id = plan."transactionId";

  IF (SELECT count(*) FROM _rev_final) IS DISTINCT FROM jsonb_array_length(COALESCE(v_plan -> 'rows', '[]'::jsonb)) THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: an inventory row is missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM _rev_final
    WHERE needs @> '["status"]'::jsonb
      AND restore_status IS NULL
  ) THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: an unknown previous status must be confirmed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM _rev_final AS final
    JOIN public.inventory_items AS item
      ON item.serial_number = final.serial
     AND item.deleted_at IS NULL
    WHERE final.restore_status IS NOT NULL
      AND NOT public.reversal_pair_allowed(item.status, v_type, final.restore_status)
  ) THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: confirmed status is not a legal predecessor of %', v_type;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM _rev_final
    WHERE needs @> '["location"]'::jsonb
      AND (
        restore_location IS NULL
        OR restore_location NOT IN ('Warehouse A', 'Warehouse B', 'Service Center')
      )
  ) THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: location must be entered at reversal';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM _rev_final
    WHERE needs @> '["return_date"]'::jsonb
      AND (restore_return IS NULL OR restore_return !~ '^\d{4}-\d{2}-\d{2}$')
  ) THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: return date must be entered at reversal';
  END IF;

  PERFORM item.id
  FROM public.inventory_items AS item
  JOIN _rev_final AS final ON final.serial = item.serial_number AND item.deleted_at IS NULL
  FOR UPDATE OF item;

  PERFORM set_config('app.movement_type', 'Reversal', true);
  PERFORM set_config('app.reversal_original_type', v_type, true);

  UPDATE public.inventory_items AS item
  SET
    status = final.restore_status,
    location = final.restore_location,
    client = final.restore_client,
    assigned_to = final.restore_assigned,
    poc_out_date = final.restore_poc,
    return_date = final.restore_return
  FROM _rev_final AS final
  WHERE item.serial_number = final.serial
    AND item.deleted_at IS NULL
    AND final.restore_status IS NOT NULL;

  UPDATE public.inventory_items AS item
  SET deleted_at = now()
  FROM _rev_final AS final
  WHERE item.serial_number = final.serial
    AND item.deleted_at IS NULL
    AND final.restore_status IS NULL;

  v_tz := 'Africa/Harare';
  v_date := to_char((now() AT TIME ZONE v_tz)::date, 'YYYY-MM-DD') || 'T00:00:00.000Z';
  v_reversal_batch := 'BATCH-REV-' || ((extract(epoch FROM clock_timestamp()) * 1000)::bigint)::text;

  INSERT INTO public.transactions (
    id, type, serial_number, item_name, client, date, client_id, invoice_number, notes,
    from_location, to_location, batch_id, metadata, created_by,
    previous_status, previous_status_source, previous_location, previous_client,
    previous_assigned_to, previous_poc_out_date, previous_return_date,
    after_status, after_location, after_client, after_assigned_to, after_poc_out_date, after_return_date,
    reverses_transaction_id
  )
  SELECT
    'TXN-REV-' || ((extract(epoch FROM clock_timestamp()) * 1000)::bigint)::text || '-' || row_number() OVER (ORDER BY src.id),
    'Reversal',
    src.serial_number,
    src.item_name,
    COALESCE(src.client, 'Internal'),
    v_date,
    src.client_id,
    src.invoice_number,
    btrim(p_reason),
    src.from_location,
    src.to_location,
    v_reversal_batch,
    jsonb_build_object(
      'reversedBatchId', p_batch_id,
      'originalMovementType', src.type,
      'restoreStatus', final.restore_status,
      'serialNumbers', jsonb_build_array(src.serial_number),
      'itemCount', 1,
      'returnLocation', final.restore_location
    ) || CASE
      WHEN jsonb_strip_nulls(jsonb_build_object(
        'location', CASE WHEN final.needs @> '["location"]'::jsonb THEN final.restore_location END,
        'return_date', CASE WHEN final.needs @> '["return_date"]'::jsonb THEN final.restore_return END
      )) = '{}'::jsonb THEN '{}'::jsonb
      ELSE jsonb_build_object(
        'entered at reversal',
        jsonb_strip_nulls(jsonb_build_object(
          'location', CASE WHEN final.needs @> '["location"]'::jsonb THEN final.restore_location END,
          'return_date', CASE WHEN final.needs @> '["return_date"]'::jsonb THEN final.restore_return END
        ))
      )
    END,
    auth.uid(),
    final.locked_status,
    'recorded',
    final.locked_location,
    final.locked_client,
    final.locked_assigned,
    final.locked_poc,
    final.locked_return,
    final.restore_status,
    final.restore_location,
    final.restore_client,
    final.restore_assigned,
    final.restore_poc,
    final.restore_return,
    src.id
  FROM public.transactions AS src
  JOIN _rev_final AS final ON final.serial = src.serial_number
  WHERE src.batch_id = p_batch_id
    AND src.type IS DISTINCT FROM 'Reversal';

  INSERT INTO public.batch_reversals (batch_id, reversed_at, reversal_reason, reversed_by, kind)
  VALUES (p_batch_id, now(), btrim(p_reason), (SELECT auth.uid())::text, 'reversal')
  ON CONFLICT (batch_id) DO UPDATE
  SET reversed_at = EXCLUDED.reversed_at,
      reversal_reason = EXCLUDED.reversal_reason,
      reversed_by = EXCLUDED.reversed_by,
      kind = EXCLUDED.kind;

  RETURN jsonb_build_object(
    'ok', true,
    'batch_id', p_batch_id,
    'reversal_batch_id', v_reversal_batch,
    'reversed_count', v_count
  );
END;
$$;

COMMENT ON FUNCTION public.reverse_quick_scan_batch(text, text, text, jsonb, jsonb) IS
  'Admin reversal. A recorded before-image is written back exactly. Legacy rows reconstruct only what is deterministic; other fields must be entered and are stored on the Reversal as entered at reversal.';

REVOKE ALL ON FUNCTION public.reverse_quick_scan_batch(text, text, text, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_quick_scan_batch(text, text, text, jsonb, jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.void_batch(p_batch_id text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF (SELECT public.get_my_role()) IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'void_batch: forbidden';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 15 THEN
    RAISE EXCEPTION 'void_batch: reason must be at least 15 characters';
  END IF;
  IF public.batch_is_currently_reversed(p_batch_id) THEN
    RAISE EXCEPTION 'void_batch: batch % is already reversed', p_batch_id;
  END IF;

  SELECT count(*)::integer INTO v_count
  FROM public.transactions
  WHERE batch_id = p_batch_id;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'void_batch: no transactions found for %', p_batch_id;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.transactions
    WHERE batch_id = p_batch_id
      AND (
        type IS DISTINCT FROM 'Inbound'
        OR previous_status IS DISTINCT FROM 'In Stock'
      )
  ) THEN
    RAISE EXCEPTION 'void_batch: this batch changed stock';
  END IF;

  INSERT INTO public.batch_reversals (batch_id, reversed_at, reversal_reason, reversed_by, kind)
  VALUES (p_batch_id, now(), btrim(p_reason), (SELECT auth.uid())::text, 'void')
  ON CONFLICT (batch_id) DO UPDATE
  SET reversed_at = EXCLUDED.reversed_at,
      reversal_reason = EXCLUDED.reversal_reason,
      reversed_by = EXCLUDED.reversed_by,
      kind = EXCLUDED.kind;

  RETURN jsonb_build_object('ok', true, 'batch_id', p_batch_id, 'voided_count', v_count);
END;
$$;

CREATE OR REPLACE FUNCTION public.restore_batch_plan(p_batch_id text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  rec record;
  v_kind text;
  v_rows jsonb := '[]'::jsonb;
  v_status text;
  v_client text;
  v_assigned text;
  v_location text;
  v_poc text;
  v_return text;
  v_exact boolean;
BEGIN
  IF (SELECT public.get_my_role()) IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'restore_batch_plan: forbidden';
  END IF;

  SELECT kind INTO v_kind FROM public.batch_reversals WHERE batch_id = p_batch_id;
  IF v_kind IS NULL THEN
    RAISE EXCEPTION 'restore_batch_plan: batch % is not reversed', p_batch_id;
  END IF;
  IF v_kind = 'void' THEN
    RETURN jsonb_build_object('batchId', p_batch_id, 'kind', 'void', 'rows', '[]'::jsonb);
  END IF;

  FOR rec IN
    SELECT ranked.*
    FROM (
      SELECT
        t.*,
        row_number() OVER (
          PARTITION BY t.serial_number
          ORDER BY public.transaction_record_time(t.id, t.created_at, t.date), t.id
        ) AS ordinal
      FROM public.transactions AS t
      WHERE t.batch_id = p_batch_id
        AND t.type IS DISTINCT FROM 'Reversal'
    ) AS ranked
    WHERE ranked.ordinal = 1
    ORDER BY ranked.id
  LOOP
    v_exact := rec.after_status IS NOT NULL;
    IF v_exact THEN
      v_status := rec.after_status;
      v_location := rec.after_location;
      v_client := rec.after_client;
      v_assigned := rec.after_assigned_to;
      v_poc := rec.after_poc_out_date;
      v_return := rec.after_return_date;
    ELSE
      v_client := NULLIF(btrim(rec.client), '');
      v_assigned := NULLIF(btrim(rec.assigned_to), '');
      v_poc := NULL;
      v_return := NULL;
      v_location := NULLIF(btrim(rec.to_location), '');
      v_status := CASE rec.type
        WHEN 'Sale' THEN 'Sold'
        WHEN 'POC Out' THEN 'POC'
        WHEN 'Rentals' THEN 'Rented'
        WHEN 'POC Return' THEN 'In Stock'
        WHEN 'Rental Return' THEN 'In Stock'
        WHEN 'Sale Return' THEN 'RMA Hold'
        WHEN 'Dispose' THEN 'Disposed'
        WHEN 'Decommissioned' THEN 'Pending Inspection'
        WHEN 'Inspection Pass' THEN 'In Stock'
        WHEN 'Inspection Fail' THEN 'RMA Hold'
        WHEN 'Remediation Loaner Issue' THEN 'Sold'
        WHEN 'Inbound' THEN 'In Stock'
        ELSE rec.previous_status
      END;
      IF rec.type IN ('Sale', 'Remediation Loaner Issue') THEN
        v_location := 'Delivered';
        v_poc := NULLIF(btrim(COALESCE(rec.metadata ->> 'poc_out_date', '')), '');
      ELSIF rec.type IN ('POC Out', 'Rentals') THEN
        v_location := 'Client Site';
        v_poc := left(rec.date, 10);
      ELSIF rec.type IN ('POC Return', 'Rental Return', 'Sale Return', 'Dispose') THEN
        v_client := NULL;
        v_assigned := NULL;
        v_location := COALESCE(NULLIF(btrim(rec.to_location), ''), 'Warehouse A');
      ELSIF rec.type = 'Transfer' THEN
        v_status := rec.previous_status;
        v_location := COALESCE(NULLIF(btrim(rec.to_location), ''), NULLIF(btrim(rec.from_location), ''));
        SELECT item.client, item.assigned_to, item.poc_out_date, item.return_date
        INTO v_client, v_assigned, v_poc, v_return
        FROM public.inventory_items AS item
        WHERE item.serial_number = rec.serial_number
        ORDER BY item.deleted_at NULLS FIRST, item.id
        LIMIT 1;
      END IF;
    END IF;

    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'transactionId', rec.id,
      'serial', rec.serial_number,
      'exact', v_exact,
      'status', v_status,
      'client', v_client,
      'assignedTo', v_assigned,
      'location', v_location,
      'pocOutDate', v_poc,
      'returnDate', v_return
    ));
  END LOOP;

  RETURN jsonb_build_object('batchId', p_batch_id, 'kind', v_kind, 'rows', v_rows);
END;
$$;

COMMENT ON FUNCTION public.restore_batch_plan(text) IS
  'What restore would write. A stored after-image is exact. A void changes no stock.';

REVOKE ALL ON FUNCTION public.restore_batch_plan(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_batch_plan(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.restore_batch(p_batch_id text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_kind text;
  v_type text;
  v_later_batch text;
  v_later_serial text;
  v_plan jsonb;
  v_count integer;
BEGIN
  IF (SELECT public.get_my_role()) IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'restore_batch: forbidden';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 15 THEN
    RAISE EXCEPTION 'restore_batch: reason must be at least 15 characters';
  END IF;
  IF NOT public.batch_is_currently_reversed(p_batch_id) THEN
    RAISE EXCEPTION 'restore_batch: batch % is not reversed', p_batch_id;
  END IF;

  SELECT kind INTO v_kind FROM public.batch_reversals WHERE batch_id = p_batch_id;

  SELECT later.batch_id, orig.serial_number
  INTO v_later_batch, v_later_serial
  FROM public.transactions AS orig
  JOIN public.transactions AS later
    ON later.serial_number = orig.serial_number
   AND later.id <> orig.id
   AND later.batch_id IS DISTINCT FROM orig.batch_id
   AND later.type IS DISTINCT FROM 'Reversal'
   AND NOT public.batch_is_currently_reversed(later.batch_id)
   AND NOT (
     later.type = 'Reversal'
     AND later.reverses_transaction_id = orig.id
   )
   AND (
     public.transaction_record_time(later.id, later.created_at, later.date)
       > public.transaction_record_time(orig.id, orig.created_at, orig.date)
     OR (
       public.transaction_record_time(later.id, later.created_at, later.date)
         = public.transaction_record_time(orig.id, orig.created_at, orig.date)
       AND later.id > orig.id
     )
   )
  WHERE orig.batch_id = p_batch_id
    AND orig.type IS DISTINCT FROM 'Reversal'
  ORDER BY later.batch_id
  LIMIT 1;

  IF v_later_batch IS NOT NULL THEN
    RAISE EXCEPTION 'restore_batch: % is blocked by later batch %', v_later_serial, v_later_batch;
  END IF;

  IF v_kind IS DISTINCT FROM 'void' THEN
    SELECT min(type) INTO v_type
    FROM public.transactions
    WHERE batch_id = p_batch_id
      AND type IS DISTINCT FROM 'Reversal';

    v_plan := public.restore_batch_plan(p_batch_id);

    DROP TABLE IF EXISTS _restore_final;
    CREATE TEMP TABLE _restore_final ON COMMIT DROP AS
    SELECT *
    FROM jsonb_to_recordset(COALESCE(v_plan -> 'rows', '[]'::jsonb)) AS plan(
      "transactionId" text,
      serial text,
      exact boolean,
      status text,
      client text,
      "assignedTo" text,
      location text,
      "pocOutDate" text,
      "returnDate" text
    );

    IF EXISTS (
      SELECT 1
      FROM _restore_final AS plan
      WHERE NOT EXISTS (
        SELECT 1 FROM public.inventory_items AS item WHERE item.serial_number = plan.serial
      )
    ) THEN
      RAISE EXCEPTION 'restore_batch: an inventory row is missing';
    END IF;

    PERFORM item.id
    FROM public.inventory_items AS item
    JOIN _restore_final AS plan ON plan.serial = item.serial_number
    FOR UPDATE OF item;

    PERFORM set_config('app.movement_type', v_type, true);

    UPDATE public.inventory_items AS item
    SET
      status = plan.status,
      location = COALESCE(plan.location, item.location),
      client = plan.client,
      assigned_to = plan."assignedTo",
      poc_out_date = plan."pocOutDate",
      return_date = plan."returnDate",
      deleted_at = NULL
    FROM _restore_final AS plan
    WHERE item.id = (
      SELECT candidate.id
      FROM public.inventory_items AS candidate
      WHERE candidate.serial_number = plan.serial
      ORDER BY candidate.deleted_at NULLS FIRST, candidate.id
      LIMIT 1
    );
  END IF;

  INSERT INTO public.batch_restores (batch_id, restored_at, restore_reason, restored_by)
  VALUES (p_batch_id, now(), btrim(p_reason), (SELECT auth.uid())::text);

  SELECT count(*)::integer INTO v_count
  FROM public.transactions
  WHERE batch_id = p_batch_id
    AND type IS DISTINCT FROM 'Reversal';

  RETURN jsonb_build_object('ok', true, 'batch_id', p_batch_id, 'kind', v_kind, 'restored_count', v_count);
END;
$$;

COMMENT ON FUNCTION public.restore_batch(text, text) IS
  'Append-only restore. Reversal and void rows stay. Restoring a reversal writes the original movement after-image. Restoring a void changes no stock.';

REVOKE ALL ON FUNCTION public.restore_batch(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_batch(text, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
