-- Dispatched rows are dispatch batches, grouped with the same key as transaction history.
-- A search stays grouped when the needle hits a batch-level field on any serial in the
-- dispatch (product, client, invoice, movement, batch id). It breaks into serial rows
-- only when the needle hits serial numbers and no batch-level field in that dispatch.
-- Each serial row still carries the whole batch's lines, so the drawer needs no extra query.
-- No search, and a one-serial dispatch, are both grain "batch".

BEGIN;

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
      latest.status,
      coalesce(nullif(btrim(latest.assigned_to), ''), '') AS assigned_to,
      latest.product_name,
      latest.invoice_number,
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
      batch_meta.lines
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
      batch_meta.lines
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

COMMIT;
