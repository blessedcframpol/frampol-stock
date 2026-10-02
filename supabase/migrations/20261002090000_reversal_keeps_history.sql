-- Reversal keeps the original rows. Restore status comes from previous_status.
-- A void marks a no-effect Inbound batch without touching stock.

ALTER TABLE public.transactions
  ADD COLUMN reverses_transaction_id text;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_reverses_transaction_id_fkey
  FOREIGN KEY (reverses_transaction_id) REFERENCES public.transactions (id);

COMMENT ON COLUMN public.transactions.reverses_transaction_id IS
  'Set on a Reversal row. Points at the original transaction that stayed in the ledger.';

ALTER TABLE public.batch_reversals
  ADD COLUMN kind text NOT NULL DEFAULT 'reversal';

ALTER TABLE public.batch_reversals
  ADD CONSTRAINT batch_reversals_kind_check
  CHECK (kind IN ('reversal', 'void'));

COMMENT ON COLUMN public.batch_reversals.kind IS
  'reversal restores stock. void marks a no-effect Inbound batch and changes no inventory.';

CREATE FUNCTION public.transaction_record_time(p_id text, p_created_at timestamptz, p_date text)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT coalesce(
    p_created_at,
    CASE
      WHEN p_id ~ '^TXN-[0-9]{10}'
        THEN to_timestamp((substring(p_id from '^TXN-([0-9]{10,})'))::bigint / 1000.0)
      ELSE NULL
    END,
    p_date::timestamptz
  );
$$;

CREATE FUNCTION public.reversal_predecessors(p_type text)
RETURNS TABLE (status text)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT pair.status
  FROM (VALUES
    ('In Stock', 'Sale'),
    ('POC', 'Sale'),
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

CREATE FUNCTION public.reversal_pair_allowed(p_current text, p_original_type text, p_restore text)
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
  'True when restoring p_restore is a legal predecessor of the original movement and yields the current status.';

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

  IF NEW.status IS DISTINCT FROM public.movement_result_status(OLD.status, v_type) THEN
    RAISE EXCEPTION 'Invalid movement: % from % to %', v_type, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.inventory_items_guard_status_transition() IS
  'Status changes require app.movement_type. Reversal is checked against the inverse table. There is no allow-list for an update with no movement mode.';

DROP TRIGGER IF EXISTS tr_transactions_guard_quick_scan_reversal_order ON public.transactions;
DROP FUNCTION IF EXISTS public.guard_quick_scan_reversal_order();

DROP FUNCTION IF EXISTS public.reverse_quick_scan_batch(text, jsonb);
DROP FUNCTION IF EXISTS public.reverse_quick_scan_batch(text, jsonb, jsonb);
DROP FUNCTION IF EXISTS public.reverse_quick_scan_batch(text, jsonb, jsonb, text);

CREATE FUNCTION public.reverse_quick_scan_batch(
  p_batch_id text,
  p_reason text,
  p_return_location text DEFAULT NULL,
  p_confirmed jsonb DEFAULT '[]'::jsonb
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
  IF EXISTS (SELECT 1 FROM public.batch_reversals WHERE batch_id = p_batch_id) THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: batch % is already reversed', p_batch_id;
  END IF;

  SELECT count(*)::integer, count(DISTINCT type)::integer, min(type)
  INTO v_count, v_type_count, v_type
  FROM public.transactions
  WHERE batch_id = p_batch_id;

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
   AND NOT EXISTS (
     SELECT 1 FROM public.batch_reversals AS reversal WHERE reversal.batch_id = later.batch_id
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
  ORDER BY later.batch_id
  LIMIT 1;

  IF v_later_batch IS NOT NULL THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: % is blocked by later batch %', v_later_serial, v_later_batch;
  END IF;

  CREATE TEMP TABLE _rev_rows ON COMMIT DROP AS
  SELECT
    t.id,
    t.type,
    t.serial_number,
    t.item_name,
    t.client,
    t.client_id,
    t.invoice_number,
    t.from_location,
    t.to_location,
    t.previous_status,
    t.previous_status_source,
    public.transaction_record_time(t.id, t.created_at, t.date) AS record_time,
    row_number() OVER (
      PARTITION BY t.serial_number
      ORDER BY public.transaction_record_time(t.id, t.created_at, t.date), t.id
    ) AS ordinal
  FROM public.transactions AS t
  WHERE t.batch_id = p_batch_id;

  IF EXISTS (
    SELECT 1
    FROM _rev_rows AS row
    WHERE row.previous_status_source = 'unknown'
      AND row.previous_status IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_to_recordset(COALESCE(p_confirmed, '[]'::jsonb)) AS confirmed(transaction_id text, status text)
        WHERE confirmed.transaction_id = row.id
          AND confirmed.status IS NOT NULL
          AND btrim(confirmed.status) <> ''
      )
  ) THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: an unknown previous status must be confirmed';
  END IF;

  CREATE TEMP TABLE _rev_apply ON COMMIT DROP AS
  SELECT
    row.id,
    row.serial_number,
    row.previous_status_source,
    CASE
      WHEN row.previous_status IS NULL THEN NULL
      WHEN row.previous_status_source = 'unknown' THEN confirmed.status
      ELSE row.previous_status
    END AS restore_status,
    row.ordinal,
    item.status AS locked_status
  FROM _rev_rows AS row
  JOIN public.inventory_items AS item
    ON item.serial_number = row.serial_number
   AND item.deleted_at IS NULL
  LEFT JOIN jsonb_to_recordset(COALESCE(p_confirmed, '[]'::jsonb)) AS confirmed(transaction_id text, status text)
    ON confirmed.transaction_id = row.id
   AND row.previous_status_source = 'unknown';

  IF EXISTS (
    SELECT 1
    FROM _rev_apply AS apply
    JOIN public.inventory_items AS item
      ON item.serial_number = apply.serial_number
     AND item.deleted_at IS NULL
    WHERE apply.ordinal = 1
      AND apply.restore_status IS NOT NULL
      AND NOT public.reversal_pair_allowed(item.status, v_type, apply.restore_status)
  ) THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: confirmed status is not a legal predecessor of %', v_type;
  END IF;

  IF (SELECT count(*) FROM _rev_apply) IS DISTINCT FROM (SELECT count(*) FROM _rev_rows) THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: an inventory row is missing';
  END IF;

  PERFORM set_config('app.movement_type', 'Reversal', true);
  PERFORM set_config('app.reversal_original_type', v_type, true);

  UPDATE public.inventory_items AS item
  SET
    status = apply.restore_status,
    location = CASE
      WHEN v_type = 'Transfer' THEN COALESCE(NULLIF(btrim(src.from_location), ''), item.location)
      WHEN v_type IN ('Sale', 'POC Out', 'Rentals', 'Dispose')
           AND NULLIF(btrim(COALESCE(p_return_location, '')), '') IS NOT NULL
        THEN btrim(p_return_location)
      ELSE item.location
    END,
    client = CASE
      WHEN v_type IN ('Sale', 'POC Out', 'Rentals', 'Dispose') THEN NULL
      ELSE item.client
    END,
    assigned_to = CASE
      WHEN v_type IN ('Sale', 'POC Out', 'Rentals', 'Dispose') THEN NULL
      ELSE item.assigned_to
    END,
    poc_out_date = CASE
      WHEN v_type IN ('POC Out', 'Rentals') THEN NULL
      ELSE item.poc_out_date
    END,
    return_date = CASE
      WHEN v_type IN ('POC Out', 'Rentals') THEN NULL
      ELSE item.return_date
    END
  FROM _rev_apply AS apply
  JOIN _rev_rows AS src ON src.id = apply.id
  WHERE item.serial_number = apply.serial_number
    AND item.deleted_at IS NULL
    AND apply.ordinal = 1
    AND apply.restore_status IS NOT NULL;

  UPDATE public.inventory_items AS item
  SET deleted_at = now()
  FROM _rev_apply AS apply
  WHERE item.serial_number = apply.serial_number
    AND item.deleted_at IS NULL
    AND apply.ordinal = 1
    AND apply.restore_status IS NULL;

  v_tz := 'Africa/Harare';
  v_date := to_char((now() AT TIME ZONE v_tz)::date, 'YYYY-MM-DD') || 'T00:00:00.000Z';
  v_reversal_batch := 'BATCH-REV-' || ((extract(epoch FROM clock_timestamp()) * 1000)::bigint)::text;

  INSERT INTO public.transactions (
    id, type, serial_number, item_name, client, date, client_id, invoice_number, notes,
    from_location, to_location, batch_id, metadata, created_by,
    previous_status, previous_status_source, reverses_transaction_id
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
      'restoreStatus', apply.restore_status,
      'serialNumbers', jsonb_build_array(src.serial_number),
      'itemCount', 1,
      'returnLocation', NULLIF(btrim(COALESCE(p_return_location, '')), '')
    ),
    auth.uid(),
    apply.locked_status,
    'recorded',
    src.id
  FROM _rev_rows AS src
  JOIN _rev_apply AS apply ON apply.id = src.id;

  INSERT INTO public.batch_reversals (batch_id, reversed_at, reversal_reason, reversed_by, kind)
  VALUES (p_batch_id, now(), btrim(p_reason), (SELECT auth.uid())::text, 'reversal');

  RETURN jsonb_build_object(
    'ok', true,
    'batch_id', p_batch_id,
    'reversal_batch_id', v_reversal_batch,
    'reversed_count', v_count
  );
END;
$$;

COMMENT ON FUNCTION public.reverse_quick_scan_batch(text, text, text, jsonb) IS
  'Admin reversal. Original rows stay. One Reversal row per original, linked by reverses_transaction_id. Restore status is previous_status, or the admin confirmation when that source is unknown.';

CREATE FUNCTION public.void_batch(p_batch_id text, p_reason text)
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
  IF EXISTS (SELECT 1 FROM public.batch_reversals WHERE batch_id = p_batch_id) THEN
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
  VALUES (p_batch_id, now(), btrim(p_reason), (SELECT auth.uid())::text, 'void');

  RETURN jsonb_build_object('ok', true, 'batch_id', p_batch_id, 'voided_count', v_count);
END;
$$;

COMMENT ON FUNCTION public.void_batch(text, text) IS
  'Admin void for an Inbound batch whose every row had previous_status In Stock, so the receipt changed nothing. No inventory update.';

REVOKE ALL ON FUNCTION public.transaction_record_time(text, timestamptz, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reversal_predecessors(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reversal_pair_allowed(text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reverse_quick_scan_batch(text, text, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.void_batch(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transaction_record_time(text, timestamptz, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reversal_predecessors(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reversal_pair_allowed(text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reverse_quick_scan_batch(text, text, text, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.void_batch(text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.transaction_batch_page(
  p_limit integer,
  p_offset integer,
  p_movement text DEFAULT NULL,
  p_from text DEFAULT NULL,
  p_to text DEFAULT NULL,
  p_search text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH params AS (
    SELECT
      NULLIF(lower(btrim(coalesce(p_search, ''))), '') AS needle,
      CASE WHEN p_from ~ '^\d{4}-\d{2}-\d{2}$' THEN p_from ELSE NULL END AS from_day,
      CASE WHEN p_to ~ '^\d{4}-\d{2}-\d{2}$' THEN p_to ELSE NULL END AS to_day,
      NULLIF(btrim(coalesce(p_movement, '')), '') AS movement
  ),
  keyed AS (
    SELECT
      t.id,
      t.type,
      t.created_at,
      left(t.date, 10) AS sort_day,
      CASE
        WHEN t.batch_id IS NOT NULL AND t.batch_id <> '' THEN 'b:' || t.batch_id
        WHEN t.type IN ('Sale', 'POC Out', 'Rentals')
          THEN 'l:' || t.type || ':' || COALESCE(t.invoice_number, '') || ':' || t.date
        ELSE 'u:' || t.id
      END AS batch_key,
      (
        t.batch_id IS NOT NULL
        AND t.batch_id <> ''
        AND EXISTS (
          SELECT 1
          FROM public.batch_reversals AS reversal
          WHERE reversal.batch_id = t.batch_id
        )
      ) AS is_reversed,
      (
        params.needle IS NULL
        OR strpos(lower(coalesce(t.serial_number, '')), params.needle) > 0
        OR strpos(lower(coalesce(t.item_name, '')), params.needle) > 0
        OR strpos(lower(coalesce(t.client, '')), params.needle) > 0
        OR strpos(lower(coalesce(t.invoice_number, '')), params.needle) > 0
        OR strpos(lower(coalesce(t.type, '')), params.needle) > 0
        OR strpos(lower(coalesce(t.batch_id, '')), params.needle) > 0
        OR strpos(lower(coalesce(t.notes, '')), params.needle) > 0
      ) AS row_matches
    FROM public.transactions AS t
    CROSS JOIN params
  ),
  grouped AS (
    SELECT
      batch_key,
      bool_or(is_reversed) AS is_reversed,
      max(sort_day) AS sort_date,
      max(created_at) AS recorded_at,
      bool_or(row_matches) AS matches_search,
      (array_agg(type ORDER BY sort_day DESC, created_at DESC NULLS LAST, id DESC))[1] AS movement,
      array_agg(id ORDER BY sort_day DESC, created_at DESC NULLS LAST, id DESC) AS transaction_ids
    FROM keyed
    GROUP BY batch_key
  ),
  enriched AS (
    SELECT
      grouped.*,
      (
        SELECT reversal.batch_id
        FROM public.transactions AS reversal
        WHERE reversal.type = 'Reversal'
          AND grouped.batch_key LIKE 'b:%'
          AND reversal.metadata ->> 'reversedBatchId' = substr(grouped.batch_key, 3)
        ORDER BY reversal.created_at DESC NULLS LAST, reversal.id DESC
        LIMIT 1
      ) AS reversed_by_batch_id
    FROM grouped
  ),
  scoped AS (
    SELECT enriched.*
    FROM enriched
    CROSS JOIN params
    WHERE (params.from_day IS NULL OR enriched.sort_date >= params.from_day)
      AND (params.to_day IS NULL OR enriched.sort_date <= params.to_day)
      AND (params.needle IS NULL OR enriched.matches_search)
  ),
  filtered AS (
    SELECT scoped.*
    FROM scoped
    CROSS JOIN params
    WHERE params.movement IS NULL OR scoped.movement = params.movement
  ),
  page AS (
    SELECT
      batch_key,
      transaction_ids,
      reversed_by_batch_id,
      row_number() OVER (
        ORDER BY sort_date DESC, recorded_at DESC NULLS LAST, batch_key ASC
      ) AS ordinality
    FROM filtered
    ORDER BY sort_date DESC, recorded_at DESC NULLS LAST, batch_key ASC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 0), 100)
    OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*)::int FROM filtered),
    'counts', COALESCE(
      (SELECT jsonb_object_agg(movement, n) FROM (
        SELECT movement, count(*)::int AS n FROM scoped WHERE NOT coalesce(is_reversed, false) AND movement IS DISTINCT FROM 'Reversal' GROUP BY movement
      ) AS counted),
      '{}'::jsonb
    ),
    'batches', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'batchKey', page.batch_key,
            'transactionIds', to_jsonb(page.transaction_ids),
            'reversedByBatchId', page.reversed_by_batch_id
          )
          ORDER BY page.ordinality
        )
        FROM page
      ),
      '[]'::jsonb
    )
  );
$$;

COMMENT ON FUNCTION public.transaction_batch_page(integer, integer, text, text, text, text) IS
  'One page of complete transaction batches, the filtered total, and movement counts for the same date and search. Rows are grouped before the limit.';

REVOKE ALL ON FUNCTION public.transaction_batch_page(integer, integer, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transaction_batch_page(integer, integer, text, text, text, text) TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.dispatched_page(
  p_limit integer,
  p_offset integer,
  p_movement text DEFAULT NULL,
  p_from text DEFAULT NULL,
  p_to text DEFAULT NULL,
  p_search text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH params AS (
    SELECT
      NULLIF(lower(btrim(coalesce(p_search, ''))), '') AS needle,
      CASE WHEN p_from ~ '^\d{4}-\d{2}-\d{2}$' THEN p_from ELSE NULL END AS from_day,
      CASE WHEN p_to ~ '^\d{4}-\d{2}-\d{2}$' THEN p_to ELSE NULL END AS to_day,
      NULLIF(btrim(coalesce(p_movement, '')), '') AS movement
  ),
  live AS (
    SELECT
      item.id,
      item.serial_number,
      item.status,
      item.client,
      item.assigned_to,
      item.date_added,
      item.poc_out_date,
      line.product_name
    FROM public.inventory_items AS item
    LEFT JOIN public.product_lines AS line ON line.id = item.product_id
    WHERE item.deleted_at IS NULL
      AND item.status IN ('Sold', 'POC', 'Rented', 'Disposed', 'Maintenance')
  ),
  latest AS (
    SELECT DISTINCT ON (live.serial_number)
      live.id,
      live.serial_number,
      live.status,
      coalesce(nullif(btrim(live.product_name), ''), '—') AS product_name,
      txn.id AS txn_id,
      txn.batch_id,
      txn.type AS txn_type,
      txn.date AS txn_date,
      txn.created_at,
      txn.client_id,
      txn.client AS txn_client,
      txn.invoice_number,
      txn.created_by,
      txn.delivery_note_url,
      live.client,
      live.assigned_to,
      live.date_added,
      live.poc_out_date
    FROM live
    LEFT JOIN public.transactions AS txn
      ON txn.serial_number = live.serial_number
     AND txn.type IN ('Sale', 'POC Out', 'Rentals', 'Dispose')
     AND NOT EXISTS (
       SELECT 1 FROM public.batch_reversals AS reversal
       WHERE reversal.batch_id = txn.batch_id
     )
    ORDER BY live.serial_number, left(txn.date, 10) DESC NULLS LAST, txn.created_at DESC NULLS LAST, txn.id DESC
  ),
  shaped AS (
    SELECT
      latest.id,
      latest.serial_number,
      latest.status,
      coalesce(nullif(btrim(latest.assigned_to), ''), '') AS assigned_to,
      latest.product_name,
      latest.invoice_number,
      latest.created_by,
      latest.delivery_note_url,
      latest.created_at,
      latest.batch_id,
      coalesce(
        latest.txn_type,
        CASE latest.status
          WHEN 'Sold' THEN 'Sale'
          WHEN 'POC' THEN 'POC Out'
          WHEN 'Rented' THEN 'Rentals'
          WHEN 'Disposed' THEN 'Dispose'
          ELSE NULL
        END
      ) AS movement,
      coalesce(left(latest.txn_date, 10), left(latest.poc_out_date, 10), left(latest.date_added, 10)) AS date_out,
      coalesce(
        nullif(btrim(concat_ws(' - ', nullif(btrim(client.name), ''), nullif(btrim(client.company), ''))), ''),
        nullif(btrim(latest.assigned_to), ''),
        nullif(btrim(latest.client), ''),
        nullif(btrim(latest.txn_client), ''),
        '—'
      ) AS client_display,
      CASE
        WHEN latest.batch_id IS NOT NULL AND latest.batch_id <> '' THEN 'b:' || latest.batch_id
        WHEN latest.txn_type IN ('Sale', 'POC Out', 'Rentals')
          THEN 'l:' || latest.txn_type || ':' || COALESCE(latest.invoice_number, '') || ':' || latest.txn_date
        ELSE 'u:' || COALESCE(latest.txn_id, latest.id)
      END AS batch_key
    FROM latest
    LEFT JOIN public.clients AS client ON client.id = latest.client_id
  ),
  flagged AS (
    SELECT
      shaped.*,
      (
        params.needle IS NOT NULL
        AND strpos(lower(shaped.serial_number), params.needle) > 0
      ) AS serial_hit,
      (
        params.needle IS NOT NULL
        AND (
          strpos(lower(shaped.product_name), params.needle) > 0
          OR strpos(lower(shaped.client_display), params.needle) > 0
          OR strpos(lower(coalesce(shaped.invoice_number, '')), params.needle) > 0
          OR strpos(lower(coalesce(shaped.movement, '')), params.needle) > 0
          OR strpos(lower(coalesce(shaped.batch_id, '')), params.needle) > 0
        )
      ) AS batch_field_hit
    FROM shaped
    CROSS JOIN params
  ),
  names AS (
    SELECT
      batch_key,
      array_agg(DISTINCT product_name ORDER BY product_name) AS product_names
    FROM flagged
    GROUP BY batch_key
  ),
  batch_meta AS (
    SELECT
      flagged.batch_key,
      bool_or(flagged.batch_field_hit) AS batch_level_match,
      count(*)::int AS item_count,
      max(flagged.date_out) AS date_out,
      max(flagged.created_at) AS recorded_at,
      (array_agg(flagged.movement ORDER BY flagged.date_out DESC NULLS LAST, flagged.created_at DESC NULLS LAST, flagged.id ASC))[1] AS movement,
      (array_agg(flagged.client_display ORDER BY flagged.date_out DESC NULLS LAST, flagged.created_at DESC NULLS LAST, flagged.id ASC))[1] AS client_display,
      NULLIF(string_agg(DISTINCT NULLIF(btrim(flagged.invoice_number), ''), ', '), '') AS invoice_number,
      (
        array_agg(
          flagged.created_by
          ORDER BY flagged.date_out DESC NULLS LAST, flagged.created_at DESC NULLS LAST, flagged.id ASC
        ) FILTER (WHERE flagged.created_by IS NOT NULL)
      )[1] AS created_by,
      (
        array_agg(
          flagged.delivery_note_url
          ORDER BY flagged.date_out DESC NULLS LAST, flagged.created_at DESC NULLS LAST, flagged.id ASC
        ) FILTER (WHERE nullif(btrim(flagged.delivery_note_url), '') IS NOT NULL)
      )[1] AS delivery_note_url,
      CASE
        WHEN names.product_names IS NULL OR cardinality(names.product_names) = 0 THEN '—'
        WHEN cardinality(names.product_names) = 1 THEN names.product_names[1]
        WHEN cardinality(names.product_names) = 2 THEN names.product_names[1] || ', ' || names.product_names[2]
        ELSE names.product_names[1] || ' +' || (cardinality(names.product_names) - 1)::text || ' more'
      END AS product_name,
      jsonb_agg(
        jsonb_build_object(
          'serialNumber', flagged.serial_number,
          'status', flagged.status,
          'assignedTo', NULLIF(flagged.assigned_to, '')
        )
        ORDER BY flagged.serial_number
      ) AS lines
    FROM flagged
    JOIN names ON names.batch_key = flagged.batch_key
    GROUP BY flagged.batch_key, names.product_names
  ),
  batch_rows AS (
    SELECT
      batch_meta.batch_key AS id,
      'batch'::text AS grain,
      batch_meta.batch_key,
      NULL::text AS serial_number,
      batch_meta.product_name,
      batch_meta.movement,
      batch_meta.client_display,
      batch_meta.invoice_number,
      batch_meta.item_count,
      batch_meta.date_out,
      batch_meta.recorded_at,
      batch_meta.lines,
      batch_meta.created_by,
      batch_meta.delivery_note_url
    FROM batch_meta
    CROSS JOIN params
    WHERE (params.from_day IS NULL OR batch_meta.date_out >= params.from_day)
      AND (params.to_day IS NULL OR batch_meta.date_out <= params.to_day)
      AND (params.needle IS NULL OR batch_meta.batch_level_match)
  ),
  serial_rows AS (
    SELECT
      flagged.id,
      'serial'::text AS grain,
      flagged.batch_key,
      flagged.serial_number,
      flagged.product_name,
      flagged.movement,
      flagged.client_display,
      flagged.invoice_number,
      batch_meta.item_count,
      flagged.date_out,
      flagged.created_at AS recorded_at,
      batch_meta.lines,
      batch_meta.created_by,
      batch_meta.delivery_note_url
    FROM flagged
    JOIN batch_meta ON batch_meta.batch_key = flagged.batch_key
    CROSS JOIN params
    WHERE params.needle IS NOT NULL
      AND NOT batch_meta.batch_level_match
      AND flagged.serial_hit
      AND (params.from_day IS NULL OR flagged.date_out >= params.from_day)
      AND (params.to_day IS NULL OR flagged.date_out <= params.to_day)
  ),
  candidates AS (
    SELECT * FROM batch_rows
    UNION ALL
    SELECT * FROM serial_rows
  ),
  filtered AS (
    SELECT candidates.*
    FROM candidates
    CROSS JOIN params
    WHERE params.movement IS NULL OR candidates.movement = params.movement
  ),
  page AS (
    SELECT *
    FROM filtered
    ORDER BY date_out DESC NULLS LAST, recorded_at DESC NULLS LAST, id ASC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 24), 0), 100)
    OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*)::int FROM filtered),
    'resultKind', CASE
      WHEN (SELECT count(*) FROM filtered WHERE grain = 'serial') = 0 THEN 'batch'
      WHEN (SELECT count(*) FROM filtered WHERE grain = 'batch') = 0 THEN 'serial'
      ELSE 'mixed'
    END,
    'counts', COALESCE(
      (SELECT jsonb_object_agg(coalesce(movement, ''), n) FROM (
        SELECT movement, count(*)::int AS n FROM candidates GROUP BY movement
      ) AS counted),
      '{}'::jsonb
    ),
    'rows', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', page.id,
            'grain', page.grain,
            'batchKey', page.batch_key,
            'serialNumber', page.serial_number,
            'productName', page.product_name,
            'movement', page.movement,
            'clientDisplay', page.client_display,
            'invoiceNumber', page.invoice_number,
            'itemCount', page.item_count,
            'dateOut', page.date_out,
            'recordedAt', page.recorded_at,
            'createdBy', page.created_by,
            'deliveryNoteUrl', page.delivery_note_url,
            'lines', page.lines
          )
          ORDER BY page.date_out DESC NULLS LAST, page.recorded_at DESC NULLS LAST, page.id ASC
        )
        FROM page
      ),
      '[]'::jsonb
    )
  );
$$;

COMMENT ON FUNCTION public.dispatched_page(integer, integer, text, text, text, text) IS
  'One page of live dispatches, grouped like transaction history. Serial-only searches return matching serials, each with the batch lines for the drawer. Counts ignore the movement filter.';

REVOKE ALL ON FUNCTION public.dispatched_page(integer, integer, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dispatched_page(integer, integer, text, text, text, text) TO authenticated, service_role;



CREATE OR REPLACE FUNCTION public.client_transactions(p_client_id text)
RETURNS TABLE (
  id text, type text, serial_number text, item_name text, client text, date text,
  client_id text, invoice_number text, notes text, from_location text, to_location text,
  assigned_to text, disposal_reason text, authorised_by text, batch_id text,
  delivery_note_url text, metadata jsonb, created_by uuid, created_at timestamptz, batch_key text
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  SELECT
    transactions.id, transactions.type, transactions.serial_number, transactions.item_name,
    transactions.client, transactions.date, transactions.client_id, transactions.invoice_number,
    transactions.notes, transactions.from_location, transactions.to_location, transactions.assigned_to,
    transactions.disposal_reason, transactions.authorised_by, transactions.batch_id,
    transactions.delivery_note_url, transactions.metadata, transactions.created_by,
    transactions.created_at, resolution.batch_key
  FROM public.client_transaction_resolution AS resolution
  JOIN public.transactions ON transactions.id = resolution.transaction_id
  WHERE resolution.resolved_client_id = p_client_id
    AND transactions.type IS DISTINCT FROM 'Reversal'
    AND NOT EXISTS (
      SELECT 1 FROM public.batch_reversals AS reversal
      WHERE reversal.batch_id = transactions.batch_id
    )
  ORDER BY transactions.date DESC, transactions.created_at DESC NULLS LAST, transactions.id DESC;
$$;

CREATE OR REPLACE FUNCTION public.client_sale_dispatch_counts()
RETURNS TABLE (client_id text, orders integer, units integer, reliable boolean)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  SELECT
    resolution.resolved_client_id AS client_id,
    count(DISTINCT resolution.batch_key)::integer AS orders,
    count(*)::integer AS units,
    true AS reliable
  FROM public.client_transaction_resolution AS resolution
  JOIN public.transactions ON transactions.id = resolution.transaction_id
  WHERE transactions.type = 'Sale'
    AND resolution.resolved_client_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.batch_reversals AS reversal
      WHERE reversal.batch_id = transactions.batch_id
    )
  GROUP BY resolution.resolved_client_id;
$$;

CREATE OR REPLACE FUNCTION public.client_last_activity()
RETURNS TABLE (client_id text, last_activity_date text)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  SELECT
    resolution.resolved_client_id AS client_id,
    max(left(transactions.date, 10)) AS last_activity_date
  FROM public.client_transaction_resolution AS resolution
  JOIN public.transactions ON transactions.id = resolution.transaction_id
  WHERE resolution.resolved_client_id IS NOT NULL
    AND transactions.type IS DISTINCT FROM 'Reversal'
    AND NOT EXISTS (
      SELECT 1 FROM public.batch_reversals AS reversal
      WHERE reversal.batch_id = transactions.batch_id
    )
  GROUP BY resolution.resolved_client_id;
$$;

REVOKE ALL ON FUNCTION public.client_transactions(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.client_sale_dispatch_counts() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.client_last_activity() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.client_transactions(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.client_sale_dispatch_counts() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.client_last_activity() TO authenticated, service_role;
