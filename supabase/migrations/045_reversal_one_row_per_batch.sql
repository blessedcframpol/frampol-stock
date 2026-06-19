-- Reversal ledger: one transaction row per batch (serials listed in metadata), not per serial.

CREATE OR REPLACE FUNCTION public.reverse_quick_scan_batch(
  p_batch_id text,
  p_entries jsonb,
  p_reversal_transactions jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_requested_count integer := 0;
  v_batch_txn_count integer := 0;
  v_plan_txn_count integer := 0;
  v_reversal_txn_count integer := 0;
  v_reversed_count integer := 0;
  v_already_reversed_count integer := 0;
  v_failed_count integer := 0;
  v_remaining_batch_txns integer := 0;
  v_reversed_serials text[] := ARRAY[]::text[];
  v_already_reversed_serials text[] := ARRAY[]::text[];
  v_failed_serials text[] := ARRAY[]::text[];
BEGIN
  IF p_batch_id IS NULL OR btrim(p_batch_id) = '' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'batch_id is required.',
      'failed_count', 0,
      'failed_serials', to_jsonb(v_failed_serials)
    );
  END IF;

  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' OR jsonb_array_length(p_entries) = 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'No planned reversal entries provided.',
      'failed_count', 0,
      'failed_serials', to_jsonb(v_failed_serials)
    );
  END IF;

  IF p_reversal_transactions IS NULL
     OR jsonb_typeof(p_reversal_transactions) <> 'array'
     OR jsonb_array_length(p_reversal_transactions) = 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'Reversal ledger row is required.',
      'failed_count', 0,
      'failed_serials', to_jsonb(v_failed_serials)
    );
  END IF;

  SELECT count(*) INTO v_batch_txn_count
  FROM public.transactions
  WHERE batch_id = p_batch_id;

  IF v_batch_txn_count = 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'No transactions found for this batch.',
      'failed_count', 0,
      'failed_serials', to_jsonb(v_failed_serials)
    );
  END IF;

  SELECT jsonb_array_length(p_reversal_transactions) INTO v_reversal_txn_count;
  IF v_reversal_txn_count <> 1 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', format(
        'Reversal ledger must have exactly one batch row (got %s).',
        v_reversal_txn_count
      ),
      'batch_txn_count', v_batch_txn_count,
      'reversal_txn_count', v_reversal_txn_count,
      'failed_count', 0,
      'failed_serials', to_jsonb(v_failed_serials)
    );
  END IF;

  CREATE TEMP TABLE _qs_reverse_plan (
    serial text NOT NULL,
    entry_kind text NOT NULL,
    inventory_id text NOT NULL,
    transaction_id text,
    reverted_row jsonb NOT NULL,
    expected_status text,
    expected_location text
  ) ON COMMIT DROP;

  INSERT INTO _qs_reverse_plan (serial, entry_kind, inventory_id, transaction_id, reverted_row, expected_status, expected_location)
  SELECT
    e.serial,
    e.entry_kind,
    e.inventory_id,
    e.transaction_id,
    e.reverted_row,
    e.expected_status,
    e.expected_location
  FROM jsonb_to_recordset(p_entries) AS e(
    serial text,
    entry_kind text,
    inventory_id text,
    transaction_id text,
    reverted_row jsonb,
    expected_status text,
    expected_location text
  );

  SELECT count(*) INTO v_requested_count FROM _qs_reverse_plan;

  IF v_requested_count <> v_batch_txn_count THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', format(
        'Reversal plan must cover every transaction in the batch (plan %s, batch %s).',
        v_requested_count,
        v_batch_txn_count
      ),
      'requested_count', v_requested_count,
      'batch_txn_count', v_batch_txn_count,
      'failed_count', 0,
      'failed_serials', to_jsonb(v_failed_serials)
    );
  END IF;

  SELECT count(*) INTO v_plan_txn_count
  FROM _qs_reverse_plan p
  INNER JOIN public.transactions t ON t.id = p.transaction_id AND t.batch_id = p_batch_id;

  IF v_plan_txn_count <> v_batch_txn_count THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'Reversal plan transaction ids do not match this batch.',
      'requested_count', v_requested_count,
      'batch_txn_count', v_batch_txn_count,
      'failed_count', 0,
      'failed_serials', to_jsonb(v_failed_serials)
    );
  END IF;

  CREATE TEMP TABLE _qs_reverse_eval (
    serial text NOT NULL,
    entry_kind text NOT NULL,
    inventory_id text NOT NULL,
    transaction_id text,
    expected_status text,
    expected_location text,
    target_status text,
    target_location text,
    target_client text,
    target_assigned_to text,
    target_poc_out_date text,
    target_return_date text,
    inventory_exists boolean NOT NULL,
    inventory_deleted boolean NOT NULL,
    txn_exists boolean NOT NULL,
    is_already_reversed boolean NOT NULL,
    precondition_ok boolean NOT NULL,
    failure_reason text
  ) ON COMMIT DROP;

  INSERT INTO _qs_reverse_eval (
    serial,
    entry_kind,
    inventory_id,
    transaction_id,
    expected_status,
    expected_location,
    target_status,
    target_location,
    target_client,
    target_assigned_to,
    target_poc_out_date,
    target_return_date,
    inventory_exists,
    inventory_deleted,
    txn_exists,
    is_already_reversed,
    precondition_ok,
    failure_reason
  )
  SELECT
    p.serial,
    p.entry_kind,
    p.inventory_id,
    p.transaction_id,
    p.expected_status,
    p.expected_location,
    p.reverted_row ->> 'status' AS target_status,
    p.reverted_row ->> 'location' AS target_location,
    p.reverted_row ->> 'client' AS target_client,
    p.reverted_row ->> 'assigned_to' AS target_assigned_to,
    p.reverted_row ->> 'poc_out_date' AS target_poc_out_date,
    p.reverted_row ->> 'return_date' AS target_return_date,
    (i.id IS NOT NULL) AS inventory_exists,
    (i.deleted_at IS NOT NULL) AS inventory_deleted,
    (tx.id IS NOT NULL) AS txn_exists,
    CASE
      WHEN p.entry_kind NOT IN ('full', 'transfer', 'delete') THEN false
      WHEN p.entry_kind = 'delete' THEN
        i.id IS NULL
        OR i.deleted_at IS NOT NULL
        OR (p.transaction_id IS NOT NULL AND tx.id IS NULL)
      WHEN i.id IS NULL THEN false
      WHEN p.entry_kind = 'transfer' THEN
        i.location IS NOT DISTINCT FROM (p.reverted_row ->> 'location')
        AND (p.transaction_id IS NULL OR tx.id IS NULL)
      ELSE
        i.status IS NOT DISTINCT FROM (p.reverted_row ->> 'status')
        AND i.location IS NOT DISTINCT FROM (p.reverted_row ->> 'location')
        AND i.client IS NOT DISTINCT FROM (p.reverted_row ->> 'client')
        AND i.assigned_to IS NOT DISTINCT FROM (p.reverted_row ->> 'assigned_to')
        AND i.poc_out_date IS NOT DISTINCT FROM (p.reverted_row ->> 'poc_out_date')
        AND i.return_date IS NOT DISTINCT FROM (p.reverted_row ->> 'return_date')
        AND (p.transaction_id IS NULL OR tx.id IS NULL)
    END AS is_already_reversed,
    CASE
      WHEN p.entry_kind NOT IN ('full', 'transfer', 'delete') THEN false
      WHEN p.entry_kind = 'delete' THEN
        i.id IS NOT NULL
        AND i.deleted_at IS NULL
        AND i.status IS NOT DISTINCT FROM p.expected_status
        AND (p.transaction_id IS NULL OR tx.id IS NOT NULL)
      WHEN i.id IS NULL OR i.deleted_at IS NOT NULL THEN false
      WHEN p.entry_kind = 'transfer' THEN
        (
          p.expected_location IS NULL
          OR btrim(p.expected_location) = ''
          OR i.location IS NOT DISTINCT FROM p.expected_location
        )
        AND (p.transaction_id IS NULL OR tx.id IS NOT NULL)
      ELSE
        i.status IS NOT DISTINCT FROM p.expected_status
        AND (p.transaction_id IS NULL OR tx.id IS NOT NULL)
    END AS precondition_ok,
    CASE
      WHEN p.entry_kind NOT IN ('full', 'transfer', 'delete') THEN 'Unsupported entry kind'
      WHEN p.entry_kind = 'delete' AND i.id IS NULL THEN 'Inventory item no longer exists'
      WHEN p.entry_kind = 'delete' AND i.deleted_at IS NOT NULL THEN 'Inventory item already removed'
      WHEN p.entry_kind <> 'delete' AND i.id IS NULL THEN 'Inventory item no longer exists'
      WHEN p.entry_kind <> 'delete' AND i.deleted_at IS NOT NULL THEN 'Inventory item is in trash'
      WHEN p.entry_kind = 'delete'
           AND i.status IS DISTINCT FROM p.expected_status
        THEN format('Status changed (expected %s, got %s)', p.expected_status, i.status)
      WHEN p.entry_kind = 'transfer'
           AND p.expected_location IS NOT NULL
           AND btrim(p.expected_location) <> ''
           AND i.location IS DISTINCT FROM p.expected_location
        THEN format('Location changed (expected %s, got %s)', p.expected_location, i.location)
      WHEN p.entry_kind = 'full'
           AND i.status IS DISTINCT FROM p.expected_status
        THEN format('Status changed (expected %s, got %s)', p.expected_status, i.status)
      WHEN p.transaction_id IS NOT NULL AND tx.id IS NULL THEN 'Transaction already missing before apply'
      ELSE NULL
    END AS failure_reason
  FROM _qs_reverse_plan p
  LEFT JOIN public.inventory_items i ON i.id = p.inventory_id
  LEFT JOIN public.transactions tx ON tx.id = p.transaction_id;

  CREATE TEMP TABLE _qs_reverse_failures ON COMMIT DROP AS
  SELECT serial, failure_reason
  FROM _qs_reverse_eval
  WHERE NOT is_already_reversed AND NOT precondition_ok;

  SELECT count(*), COALESCE(array_agg(serial ORDER BY serial), ARRAY[]::text[])
  INTO v_failed_count, v_failed_serials
  FROM _qs_reverse_failures;

  IF v_failed_count > 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'batch_id', p_batch_id,
      'requested_count', v_requested_count,
      'batch_txn_count', v_batch_txn_count,
      'reversed_count', 0,
      'already_reversed_count', 0,
      'failed_count', v_failed_count,
      'failed_serials', to_jsonb(v_failed_serials),
      'failed_details',
        COALESCE(
          (
            SELECT jsonb_agg(
              jsonb_build_object('serial', f.serial, 'reason', f.failure_reason)
              ORDER BY f.serial
            )
            FROM _qs_reverse_failures f
          ),
          '[]'::jsonb
        )
    );
  END IF;

  CREATE TEMP TABLE _qs_reverse_already ON COMMIT DROP AS
  SELECT *
  FROM _qs_reverse_eval
  WHERE is_already_reversed;

  SELECT
    count(*),
    COALESCE(array_agg(serial ORDER BY serial), ARRAY[]::text[])
  INTO v_already_reversed_count, v_already_reversed_serials
  FROM _qs_reverse_already;

  CREATE TEMP TABLE _qs_reverse_apply ON COMMIT DROP AS
  SELECT *
  FROM _qs_reverse_eval
  WHERE precondition_ok AND NOT is_already_reversed;

  PERFORM set_config('app.quick_scan_reversal', 'on', true);

  UPDATE public.inventory_items i
  SET
    status = COALESCE(a.target_status, i.status),
    location = COALESCE(a.target_location, i.location),
    client = a.target_client,
    assigned_to = a.target_assigned_to,
    poc_out_date = a.target_poc_out_date,
    return_date = a.target_return_date
  FROM _qs_reverse_apply a
  WHERE i.id = a.inventory_id
    AND a.entry_kind IN ('full', 'transfer');

  UPDATE public.inventory_items i
  SET deleted_at = now()
  FROM _qs_reverse_apply a
  WHERE i.id = a.inventory_id
    AND a.entry_kind = 'delete';

  INSERT INTO public.transactions (
    id,
    type,
    serial_number,
    item_name,
    client,
    date,
    client_id,
    invoice_number,
    notes,
    from_location,
    to_location,
    assigned_to,
    disposal_reason,
    authorised_by,
    batch_id,
    delivery_note_url,
    metadata,
    created_by
  )
  SELECT
    t.id,
    t.type,
    t.serial_number,
    t.item_name,
    t.client,
    t.date,
    t.client_id,
    t.invoice_number,
    t.notes,
    t.from_location,
    t.to_location,
    t.assigned_to,
    t.disposal_reason,
    t.authorised_by,
    t.batch_id,
    t.delivery_note_url,
    t.metadata,
    t.created_by
  FROM jsonb_to_recordset(p_reversal_transactions) AS t(
    id text,
    type text,
    serial_number text,
    item_name text,
    client text,
    date text,
    client_id text,
    invoice_number text,
    notes text,
    from_location text,
    to_location text,
    assigned_to text,
    disposal_reason text,
    authorised_by text,
    batch_id text,
    delivery_note_url text,
    metadata jsonb,
    created_by uuid
  );

  DELETE FROM public.transactions
  WHERE batch_id = p_batch_id;

  SELECT count(*) INTO v_remaining_batch_txns
  FROM public.transactions
  WHERE batch_id = p_batch_id;

  IF v_remaining_batch_txns > 0 THEN
    RAISE EXCEPTION 'Batch reversal left % trailing transaction row(s) for batch %', v_remaining_batch_txns, p_batch_id;
  END IF;

  SELECT count(*), COALESCE(array_agg(serial ORDER BY serial), ARRAY[]::text[])
  INTO v_reversed_count, v_reversed_serials
  FROM _qs_reverse_apply;

  RETURN jsonb_build_object(
    'ok', true,
    'batch_id', p_batch_id,
    'requested_count', v_requested_count,
    'batch_txn_count', v_batch_txn_count,
    'reversed_count', v_reversed_count,
    'already_reversed_count', v_already_reversed_count,
    'remaining_batch_txns', 0,
    'failed_count', 0,
    'reversed_serials', to_jsonb(v_reversed_serials),
    'already_reversed_serials', to_jsonb(v_already_reversed_serials),
    'failed_serials', to_jsonb(v_failed_serials)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.reverse_quick_scan_batch(text, jsonb, jsonb) TO authenticated;
