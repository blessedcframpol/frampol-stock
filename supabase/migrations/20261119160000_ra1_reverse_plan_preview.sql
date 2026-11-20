-- RA1: richer reverse/restore plans (current→after, age, blocked_by) + audit reason on inventory writes.
-- Read-only plan changes; reverse_quick_scan_batch write logic unchanged except app.audit_reason.
SET lock_timeout = '5s';

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
  v_after_pool text;
  v_cur_status text;
  v_cur_location text;
  v_cur_client text;
  v_cur_assigned text;
  v_cur_pool text;
  v_movement_type text;
  v_batch_age integer;
  v_blocked jsonb := NULL;
  v_block_batch text;
  v_block_serial text;
  v_block_type text;
  v_block_date text;
BEGIN
  IF (SELECT public.get_my_role()) IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'reverse_restore_plan: forbidden';
  END IF;

  SELECT min(t.type),
         (CURRENT_DATE - min(left(t.date, 10)::date))::integer
  INTO v_movement_type, v_batch_age
  FROM public.transactions AS t
  WHERE t.batch_id = p_batch_id
    AND t.type IS DISTINCT FROM 'Reversal';

  SELECT later.batch_id, orig.serial_number, later.type, left(later.date, 10)
  INTO v_block_batch, v_block_serial, v_block_type, v_block_date
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

  IF v_block_batch IS NOT NULL THEN
    v_blocked := jsonb_build_object(
      'batchId', v_block_batch,
      'serial', v_block_serial,
      'type', v_block_type,
      'date', v_block_date
    );
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
    v_after_pool := rec.previous_stock_pool;

    SELECT item.status, item.location, item.client, item.assigned_to, item.stock_pool
    INTO v_cur_status, v_cur_location, v_cur_client, v_cur_assigned, v_cur_pool
    FROM public.inventory_items AS item
    WHERE item.serial_number = rec.serial_number
      AND item.deleted_at IS NULL
    ORDER BY item.id
    LIMIT 1;

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
      'converted', v_converted,
      'current', CASE
        WHEN v_cur_status IS NULL THEN NULL
        ELSE jsonb_build_object(
          'status', v_cur_status,
          'location', v_cur_location,
          'client', v_cur_client,
          'assignedTo', v_cur_assigned,
          'stockPool', v_cur_pool
        )
      END,
      'after', CASE
        WHEN v_soft THEN NULL
        ELSE jsonb_build_object(
          'status', v_status,
          'location', v_location,
          'client', v_client,
          'assignedTo', v_assigned,
          'stockPool', v_after_pool
        )
      END
    ));
  END LOOP;

  RETURN jsonb_build_object(
    'batchId', p_batch_id,
    'movementType', v_movement_type,
    'batchAgeDays', v_batch_age,
    'blockedBy', v_blocked,
    'rows', v_rows
  );
END;
$$;

COMMENT ON FUNCTION public.reverse_restore_plan(text) IS
  'RA1: what reverse would write, with current→after per serial, batchAgeDays, and blockedBy when a later active batch exists. Flat row fields unchanged for reverse_quick_scan_batch.';

REVOKE ALL ON FUNCTION public.reverse_restore_plan(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_restore_plan(text) TO authenticated, service_role;

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
  v_after_pool text;
  v_cur_status text;
  v_cur_location text;
  v_cur_client text;
  v_cur_assigned text;
  v_cur_pool text;
  v_movement_type text;
  v_batch_age integer;
  v_blocked jsonb := NULL;
  v_block_batch text;
  v_block_serial text;
  v_block_type text;
  v_block_date text;
BEGIN
  IF (SELECT public.get_my_role()) IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'restore_batch_plan: forbidden';
  END IF;

  SELECT kind INTO v_kind FROM public.batch_reversals WHERE batch_id = p_batch_id;
  IF v_kind IS NULL THEN
    RAISE EXCEPTION 'restore_batch_plan: batch % is not reversed', p_batch_id;
  END IF;

  SELECT min(t.type),
         (CURRENT_DATE - min(left(t.date, 10)::date))::integer
  INTO v_movement_type, v_batch_age
  FROM public.transactions AS t
  WHERE t.batch_id = p_batch_id
    AND t.type IS DISTINCT FROM 'Reversal';

  SELECT later.batch_id, orig.serial_number, later.type, left(later.date, 10)
  INTO v_block_batch, v_block_serial, v_block_type, v_block_date
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

  IF v_block_batch IS NOT NULL THEN
    v_blocked := jsonb_build_object(
      'batchId', v_block_batch,
      'serial', v_block_serial,
      'type', v_block_type,
      'date', v_block_date
    );
  END IF;

  IF v_kind = 'void' THEN
    RETURN jsonb_build_object(
      'batchId', p_batch_id,
      'kind', 'void',
      'movementType', v_movement_type,
      'batchAgeDays', v_batch_age,
      'blockedBy', v_blocked,
      'rows', '[]'::jsonb
    );
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
    v_after_pool := rec.after_stock_pool;

    SELECT item.status, item.location, item.client, item.assigned_to, item.stock_pool
    INTO v_cur_status, v_cur_location, v_cur_client, v_cur_assigned, v_cur_pool
    FROM public.inventory_items AS item
    WHERE item.serial_number = rec.serial_number
    ORDER BY item.deleted_at NULLS FIRST, item.id
    LIMIT 1;

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
      'returnDate', v_return,
      'current', CASE
        WHEN v_cur_status IS NULL THEN NULL
        ELSE jsonb_build_object(
          'status', v_cur_status,
          'location', v_cur_location,
          'client', v_cur_client,
          'assignedTo', v_cur_assigned,
          'stockPool', v_cur_pool
        )
      END,
      'after', jsonb_build_object(
        'status', v_status,
        'location', v_location,
        'client', v_client,
        'assignedTo', v_assigned,
        'stockPool', v_after_pool
      )
    ));
  END LOOP;

  RETURN jsonb_build_object(
    'batchId', p_batch_id,
    'kind', v_kind,
    'movementType', v_movement_type,
    'batchAgeDays', v_batch_age,
    'blockedBy', v_blocked,
    'rows', v_rows
  );
END;
$$;

COMMENT ON FUNCTION public.restore_batch_plan(text) IS
  'RA1: what restore would write, with current→after per serial, batchAgeDays, and blockedBy. Flat row fields unchanged for restore_batch.';

REVOKE ALL ON FUNCTION public.restore_batch_plan(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_batch_plan(text) TO authenticated, service_role;


-- Write path: stamp audit reason on inventory UPDATEs (logic otherwise unchanged).
CREATE OR REPLACE FUNCTION public.reverse_quick_scan_batch(p_batch_id text, p_reason text, p_return_location text DEFAULT NULL::text, p_confirmed jsonb DEFAULT '[]'::jsonb, p_entered jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $ra1rev$
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
    item.return_date AS locked_return,
    item.stock_pool AS locked_pool,
    (
      SELECT src.previous_stock_pool
      FROM public.transactions AS src
      WHERE src.id = plan."transactionId"
    ) AS restore_pool
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
  PERFORM set_config('app.audit_reason', btrim(p_reason), true);

  UPDATE public.inventory_items AS item
  SET
    status = final.restore_status,
    location = final.restore_location,
    client = final.restore_client,
    assigned_to = final.restore_assigned,
    poc_out_date = final.restore_poc,
    return_date = final.restore_return,
    stock_pool = COALESCE(final.restore_pool, item.stock_pool)
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
    previous_assigned_to, previous_poc_out_date, previous_return_date, previous_stock_pool,
    after_status, after_location, after_client, after_assigned_to, after_poc_out_date, after_return_date,
    after_stock_pool,
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
    final.locked_pool,
    final.restore_status,
    final.restore_location,
    final.restore_client,
    final.restore_assigned,
    final.restore_poc,
  final.restore_return,
    CASE WHEN final.restore_status IS NULL THEN NULL ELSE COALESCE(final.restore_pool, final.locked_pool) END,
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

  PERFORM public.reopen_inspection_cases(p_batch_id, btrim(p_reason));

  RETURN jsonb_build_object(
    'ok', true,
    'batch_id', p_batch_id,
    'reversal_batch_id', v_reversal_batch,
    'reversed_count', v_count
  );
END;
$ra1rev$;


CREATE OR REPLACE FUNCTION public.restore_batch(p_batch_id text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $ra1res$
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
    PERFORM set_config('app.audit_reason', btrim(p_reason), true);

    UPDATE public.inventory_items AS item
    SET
      status = plan.status,
      location = COALESCE(plan.location, item.location),
      client = plan.client,
      assigned_to = plan."assignedTo",
      poc_out_date = plan."pocOutDate",
      return_date = plan."returnDate",
      deleted_at = NULL,
      stock_pool = COALESCE(
        (SELECT src.after_stock_pool FROM public.transactions AS src WHERE src.id = plan."transactionId"),
        item.stock_pool
      )
    FROM _restore_final AS plan
    WHERE item.id = (
      SELECT candidate.id
      FROM public.inventory_items AS candidate
      WHERE candidate.serial_number = plan.serial
      ORDER BY candidate.deleted_at NULLS FIRST, candidate.id
      LIMIT 1
    );

    PERFORM public.reclose_inspection_cases(p_batch_id);
  END IF;

  INSERT INTO public.batch_restores (batch_id, restored_at, restore_reason, restored_by)
  VALUES (p_batch_id, now(), btrim(p_reason), (SELECT auth.uid())::text);

  SELECT count(*)::integer INTO v_count
  FROM public.transactions
  WHERE batch_id = p_batch_id
    AND type IS DISTINCT FROM 'Reversal';

  RETURN jsonb_build_object('ok', true, 'batch_id', p_batch_id, 'kind', v_kind, 'restored_count', v_count);
END;
$ra1res$;

