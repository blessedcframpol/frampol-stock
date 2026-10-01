-- Filtered pages for Transaction history and Dispatched.
-- Counts are grouped in SQL (date and search applied, movement filter not applied to the
-- chip counts) so the UI never derives a total from the rows on the current page.
-- History order is business date desc, then recorded time desc, nulls last.
-- The previous 2-argument function is replaced; extra arguments default to null.

BEGIN;

DROP FUNCTION IF EXISTS public.transaction_batch_page(integer, integer);

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
        SELECT movement, count(*)::int AS n FROM scoped GROUP BY movement
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
      txn.type AS txn_type,
      txn.date AS txn_date,
      txn.created_at,
      txn.client_id,
      txn.client AS txn_client,
      txn.invoice_number,
      live.client,
      live.assigned_to,
      live.date_added,
      live.poc_out_date
    FROM live
    LEFT JOIN public.transactions AS txn
      ON txn.serial_number = live.serial_number
     AND txn.type IN ('Sale', 'POC Out', 'Rentals', 'Dispose')
    ORDER BY live.serial_number, left(txn.date, 10) DESC NULLS LAST, txn.created_at DESC NULLS LAST, txn.id DESC
  ),
  shaped AS (
    SELECT
      latest.id,
      latest.serial_number,
      latest.product_name,
      latest.invoice_number,
      latest.created_at,
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
      ) AS client_display
    FROM latest
    LEFT JOIN public.clients AS client ON client.id = latest.client_id
  ),
  scoped AS (
    SELECT shaped.*
    FROM shaped
    CROSS JOIN params
    WHERE (params.from_day IS NULL OR shaped.date_out >= params.from_day)
      AND (params.to_day IS NULL OR shaped.date_out <= params.to_day)
      AND (
        params.needle IS NULL
        OR strpos(lower(shaped.serial_number), params.needle) > 0
        OR strpos(lower(shaped.product_name), params.needle) > 0
        OR strpos(lower(shaped.client_display), params.needle) > 0
        OR strpos(lower(coalesce(shaped.invoice_number, '')), params.needle) > 0
        OR strpos(lower(coalesce(shaped.movement, '')), params.needle) > 0
      )
  ),
  filtered AS (
    SELECT scoped.*
    FROM scoped
    CROSS JOIN params
    WHERE params.movement IS NULL OR scoped.movement = params.movement
  ),
  page AS (
    SELECT *
    FROM filtered
    ORDER BY date_out DESC NULLS LAST, created_at DESC NULLS LAST, id ASC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 24), 0), 100)
    OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*)::int FROM filtered),
    'counts', COALESCE(
      (SELECT jsonb_object_agg(coalesce(movement, ''), n) FROM (
        SELECT movement, count(*)::int AS n FROM scoped GROUP BY movement
      ) AS counted),
      '{}'::jsonb
    ),
    'rows', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', page.id,
            'serialNumber', page.serial_number,
            'productName', page.product_name,
            'movement', page.movement,
            'clientDisplay', page.client_display,
            'invoiceNumber', page.invoice_number,
            'dateOut', page.date_out,
            'recordedAt', page.created_at
          )
          ORDER BY page.date_out DESC NULLS LAST, page.created_at DESC NULLS LAST, page.id ASC
        )
        FROM page
      ),
      '[]'::jsonb
    )
  );
$$;

COMMENT ON FUNCTION public.dispatched_page(integer, integer, text, text, text, text) IS
  'One page of live dispatched serials. Client display prefers clients via the latest outbound client_id, then the stored text. Counts ignore the movement filter.';

REVOKE ALL ON FUNCTION public.dispatched_page(integer, integer, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dispatched_page(integer, integer, text, text, text, text) TO authenticated, service_role;

COMMIT;
