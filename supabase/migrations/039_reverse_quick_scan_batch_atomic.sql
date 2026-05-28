-- Atomic quick-scan batch reversal with idempotent reporting.
-- SECURITY INVOKER so caller RLS policies still apply.

-- Scoped reversal-only signal in status trigger:
-- Disposed -> In Stock is only allowed when app.quick_scan_reversal = 'on'.
CREATE OR REPLACE FUNCTION public.inventory_items_guard_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;
  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
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
  ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid inventory status transition: % -> %', OLD.status, NEW.status;
END;
$$;

COMMENT ON FUNCTION public.inventory_items_guard_status_transition() IS
  'Allows defined status transitions; Disposed->In Stock is allowed only with app.quick_scan_reversal=on (atomic quick-scan reversal).';

CREATE OR REPLACE FUNCTION public.reverse_quick_scan_batch(
  p_batch_id text,
  p_entries jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_requested_count integer := 0;
  v_reversed_count integer := 0;
  v_already_reversed_count integer := 0;
  v_failed_count integer := 0;
  v_reversed_serials text[] := ARRAY[]::text[];
  v_already_reversed_serials text[] := ARRAY[]::text[];
  v_failed_serials text[] := ARRAY[]::text[];
BEGIN
  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' OR jsonb_array_length(p_entries) = 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'No planned reversal entries provided.',
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
    (tx.id IS NOT NULL) AS txn_exists,
    CASE
      WHEN p.entry_kind NOT IN ('full', 'transfer') THEN false
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
      WHEN p.entry_kind NOT IN ('full', 'transfer') THEN false
      WHEN i.id IS NULL THEN false
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
      WHEN p.entry_kind NOT IN ('full', 'transfer') THEN 'Unsupported entry kind'
      WHEN i.id IS NULL THEN 'Inventory item no longer exists'
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
  WHERE i.id = a.inventory_id;

  DELETE FROM public.transactions tx
  USING _qs_reverse_apply a
  WHERE a.transaction_id IS NOT NULL
    AND tx.id = a.transaction_id;

  SELECT count(*), COALESCE(array_agg(serial ORDER BY serial), ARRAY[]::text[])
  INTO v_reversed_count, v_reversed_serials
  FROM _qs_reverse_apply;

  RETURN jsonb_build_object(
    'ok', true,
    'batch_id', p_batch_id,
    'requested_count', v_requested_count,
    'reversed_count', v_reversed_count,
    'already_reversed_count', v_already_reversed_count,
    'failed_count', 0,
    'reversed_serials', to_jsonb(v_reversed_serials),
    'already_reversed_serials', to_jsonb(v_already_reversed_serials),
    'failed_serials', to_jsonb(v_failed_serials)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.reverse_quick_scan_batch(text, jsonb) TO authenticated;
