-- One definition of a transaction that still counts.
-- active_transactions excludes Reversal rows and any row in a reversed or voided batch.
-- History chips, dispatches, client counts, and the app read this view.

CREATE OR REPLACE VIEW public.active_transactions
WITH (security_invoker = true) AS
SELECT transactions.*
FROM public.transactions
WHERE transactions.type IS DISTINCT FROM 'Reversal'
  AND NOT EXISTS (
    SELECT 1
    FROM public.batch_reversals AS reversal
    WHERE reversal.batch_id = transactions.batch_id
  );

COMMENT ON VIEW public.active_transactions IS
  'Transactions that still count. A Reversal row is excluded. A row in a reversed or voided batch is excluded.';

REVOKE ALL ON public.active_transactions FROM PUBLIC, anon;
GRANT SELECT ON public.active_transactions TO authenticated, service_role;

CREATE OR REPLACE VIEW public.client_transaction_resolution
WITH (security_invoker = true) AS
WITH placeholders(value) AS (
  VALUES ('n/a'), ('na'), ('n.a'), ('n.a.'), ('none'), ('-'), ('null'), ('')
),
directory AS (
  SELECT
    clients.id,
    btrim(coalesce(clients.name, '')) AS name,
    btrim(coalesce(clients.company, '')) AS company
  FROM public.clients
),
keys AS (
  SELECT directory.id, lower(directory.name) AS key
  FROM directory
  WHERE directory.name <> ''
    AND lower(directory.name) NOT IN (SELECT placeholders.value FROM placeholders)
  UNION
  SELECT directory.id, lower(directory.company)
  FROM directory
  WHERE directory.company <> ''
    AND lower(directory.company) NOT IN (SELECT placeholders.value FROM placeholders)
  UNION
  SELECT directory.id, lower(directory.name) || ' - ' || lower(directory.company)
  FROM directory
  WHERE directory.name <> '' AND directory.company <> ''
  UNION
  SELECT
    directory.id,
    lower(
      CASE
        WHEN directory.name = '' THEN directory.company
        WHEN directory.company = '' OR lower(directory.company) = lower(directory.name) THEN directory.name
        ELSE directory.name || ' - ' || directory.company
      END
    )
  FROM directory
  WHERE CASE
      WHEN directory.name = '' THEN directory.company
      WHEN directory.company = '' OR lower(directory.company) = lower(directory.name) THEN directory.name
      ELSE directory.name || ' - ' || directory.company
    END <> ''
    AND lower(
      CASE
        WHEN directory.name = '' THEN directory.company
        WHEN directory.company = '' OR lower(directory.company) = lower(directory.name) THEN directory.name
        ELSE directory.name || ' - ' || directory.company
      END
    ) NOT IN (SELECT placeholders.value FROM placeholders)
),
txn AS (
  SELECT
    transactions.id,
    transactions.client_id AS stored_client_id,
    btrim(coalesce(transactions.client, '')) AS client_label,
    lower(btrim(coalesce(transactions.client, ''))) AS client_text,
    CASE
      WHEN transactions.batch_id IS NOT NULL AND transactions.batch_id <> '' THEN 'b:' || transactions.batch_id
      WHEN transactions.type IN ('Sale', 'POC Out', 'Rentals')
        THEN 'l:' || transactions.type || ':' || coalesce(transactions.invoice_number, '') || ':' || transactions.date
      ELSE 'u:' || transactions.id
    END AS batch_key
  FROM public.transactions
),
text_hits AS (
  SELECT txn.id AS txn_id, keys.id AS matched_id
  FROM txn
  JOIN keys ON keys.key = txn.client_text
  WHERE txn.stored_client_id IS NULL
    AND txn.client_label <> 'Internal'
    AND txn.client_text <> ''
    AND txn.client_text NOT IN (SELECT placeholders.value FROM placeholders)
),
text_span AS (
  SELECT
    text_hits.txn_id,
    count(DISTINCT text_hits.matched_id)::integer AS match_count,
    min(text_hits.matched_id) AS only_id
  FROM text_hits
  GROUP BY text_hits.txn_id
)
SELECT
  txn.id AS transaction_id,
  CASE
    WHEN txn.stored_client_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM directory WHERE directory.id = txn.stored_client_id)
      THEN txn.stored_client_id
    WHEN txn.stored_client_id IS NULL AND txn.client_label = 'Internal'
      THEN NULL
    WHEN txn.stored_client_id IS NULL AND text_span.match_count = 1
      THEN text_span.only_id
    ELSE NULL
  END AS resolved_client_id,
  CASE
    WHEN txn.stored_client_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM directory WHERE directory.id = txn.stored_client_id)
      THEN 'client_id'
    WHEN txn.stored_client_id IS NULL AND txn.client_label = 'Internal'
      THEN 'internal'
    WHEN txn.stored_client_id IS NULL AND text_span.match_count = 1
      THEN 'text'
    ELSE 'unresolved'
  END AS method,
  CASE
    WHEN txn.stored_client_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM directory WHERE directory.id = txn.stored_client_id)
      THEN 'dangling_client_id'
    WHEN txn.stored_client_id IS NULL AND txn.client_label = 'Internal'
      THEN NULL
    WHEN txn.stored_client_id IS NULL AND coalesce(text_span.match_count, 0) > 1
      THEN 'ambiguous_text'
    WHEN txn.stored_client_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM directory WHERE directory.id = txn.stored_client_id)
      THEN NULL
    WHEN txn.stored_client_id IS NULL AND text_span.match_count = 1
      THEN NULL
    ELSE 'no_match'
  END AS unresolved_reason,
  txn.batch_key,
  NOT EXISTS (
    SELECT 1 FROM public.active_transactions AS active
    WHERE active.id = txn.id
  ) AS is_reversed
FROM txn
LEFT JOIN text_span ON text_span.txn_id = txn.id;


COMMENT ON VIEW public.client_transaction_resolution IS
  'One row per transaction, including reversed ones. is_reversed is true when the row is not in active_transactions. client_id wins when it is a directory id. Null client_id with client Internal is method internal, not a directory match. Other null ids match text only against exactly one directory key. Dangling ids are not re-matched by text.';

REVOKE ALL ON public.client_transaction_resolution FROM PUBLIC, anon;
GRANT SELECT ON public.client_transaction_resolution TO authenticated, service_role;

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
  JOIN public.active_transactions AS transactions ON transactions.id = resolution.transaction_id
  WHERE resolution.resolved_client_id = p_client_id
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
  JOIN public.active_transactions AS transactions ON transactions.id = resolution.transaction_id
  WHERE transactions.type = 'Sale'
    AND resolution.resolved_client_id IS NOT NULL
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
  JOIN public.active_transactions AS transactions ON transactions.id = resolution.transaction_id
  WHERE resolution.resolved_client_id IS NOT NULL
  GROUP BY resolution.resolved_client_id;
$$;

COMMENT ON FUNCTION public.client_transactions(text) IS
  'Transactions resolved to this directory client, excluding reversed, voided, and Reversal rows via active_transactions.';
COMMENT ON FUNCTION public.client_sale_dispatch_counts() IS
  'Sale orders and units per directory client. Reads active_transactions, so reversed and voided sales are not counted.';
COMMENT ON FUNCTION public.client_last_activity() IS
  'Latest business date of an active transaction resolved to each directory client.';

REVOKE ALL ON FUNCTION public.client_transactions(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.client_sale_dispatch_counts() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.client_last_activity() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.client_transactions(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.client_sale_dispatch_counts() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.client_last_activity() TO authenticated, service_role;


DROP FUNCTION IF EXISTS public.transaction_batch_page(integer, integer, text, text, text, text);

CREATE FUNCTION public.transaction_batch_page(
  p_limit integer,
  p_offset integer,
  p_movement text DEFAULT NULL,
  p_from text DEFAULT NULL,
  p_to text DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_active_only boolean DEFAULT false
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
      EXISTS (
        SELECT 1 FROM public.active_transactions AS active
        WHERE active.id = t.id
      ) AS is_active,
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
      bool_and(is_active) AS is_active,
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
    WHERE (
        params.movement IS NULL
        OR (params.movement = 'Reversed' AND NOT scoped.is_active)
        OR (
          params.movement IS DISTINCT FROM 'Reversed'
          AND scoped.is_active
          AND scoped.movement = params.movement
        )
      )
      AND (NOT coalesce(p_active_only, false) OR scoped.is_active)
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
        SELECT movement, count(*)::int AS n FROM scoped WHERE is_active GROUP BY movement
        UNION ALL
        SELECT 'Reversed'::text, count(*)::int FROM scoped WHERE NOT is_active
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

COMMENT ON FUNCTION public.transaction_batch_page(integer, integer, text, text, text, text, boolean) IS
  'One page of complete transaction batches. Movement chips count active_transactions. Reversed counts batches the view leaves out. All is their sum.';

REVOKE ALL ON FUNCTION public.transaction_batch_page(integer, integer, text, text, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transaction_batch_page(integer, integer, text, text, text, text, boolean) TO authenticated, service_role;

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
    LEFT JOIN public.active_transactions AS txn
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
