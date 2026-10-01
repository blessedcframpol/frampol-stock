-- Sale dispatches per directory client.
-- One order is one batch, using the same key as Dispatched and transaction history:
--   b:<batch_id>, or l:Sale:<invoice>:<date> when the legacy row has no batch.
-- Units are the Sale rows in those batches (one 9-serial sale is 1 order, 9 units).
-- A row with client_id is that client. A row with a null client_id counts only when
-- the stored client text matches exactly one directory record. Ambiguous text, or a
-- batch that resolves to more than one client, marks those clients unreliable so the
-- list does not print a number.

BEGIN;

CREATE OR REPLACE FUNCTION public.client_sale_dispatch_counts()
RETURNS TABLE (
  client_id text,
  orders integer,
  units integer,
  reliable boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
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
  sales AS (
    SELECT
      txn.id,
      txn.client_id AS stored_client_id,
      CASE
        WHEN txn.batch_id IS NOT NULL AND txn.batch_id <> '' THEN 'b:' || txn.batch_id
        ELSE 'l:Sale:' || coalesce(txn.invoice_number, '') || ':' || txn.date
      END AS batch_key,
      lower(btrim(coalesce(txn.client, ''))) AS client_text
    FROM public.transactions AS txn
    WHERE txn.type = 'Sale'
  ),
  text_hits AS (
    SELECT sales.id AS txn_id, keys.id AS matched_id
    FROM sales
    JOIN keys ON keys.key = sales.client_text
    WHERE sales.client_text <> ''
      AND sales.client_text NOT IN (SELECT placeholders.value FROM placeholders)
  ),
  text_span AS (
    SELECT text_hits.txn_id, count(DISTINCT text_hits.matched_id)::integer AS match_count
    FROM text_hits
    GROUP BY text_hits.txn_id
  ),
  resolved AS (
    SELECT
      sales.id,
      sales.batch_key,
      CASE
        WHEN sales.stored_client_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM directory WHERE directory.id = sales.stored_client_id)
          THEN sales.stored_client_id
        WHEN sales.stored_client_id IS NULL AND text_span.match_count = 1
          THEN (
            SELECT text_hits.matched_id
            FROM text_hits
            WHERE text_hits.txn_id = sales.id
            LIMIT 1
          )
        ELSE NULL
      END AS resolved_id,
      (sales.stored_client_id IS NULL AND coalesce(text_span.match_count, 0) > 1) AS ambiguous
    FROM sales
    LEFT JOIN text_span ON text_span.txn_id = sales.id
  ),
  mixed AS (
    SELECT resolved.batch_key
    FROM resolved
    WHERE resolved.resolved_id IS NOT NULL
    GROUP BY resolved.batch_key
    HAVING count(DISTINCT resolved.resolved_id) > 1
  ),
  ambiguous_clients AS (
    SELECT DISTINCT text_hits.matched_id AS client_id
    FROM resolved
    JOIN text_hits ON text_hits.txn_id = resolved.id
    WHERE resolved.ambiguous
    UNION
    SELECT resolved.resolved_id
    FROM resolved
    JOIN mixed ON mixed.batch_key = resolved.batch_key
    WHERE resolved.resolved_id IS NOT NULL
  ),
  counted AS (
    SELECT
      resolved.resolved_id AS client_id,
      count(DISTINCT resolved.batch_key)::integer AS orders,
      count(*)::integer AS units
    FROM resolved
    WHERE resolved.resolved_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM mixed WHERE mixed.batch_key = resolved.batch_key)
      AND NOT EXISTS (
        SELECT 1 FROM ambiguous_clients WHERE ambiguous_clients.client_id = resolved.resolved_id
      )
    GROUP BY resolved.resolved_id
  ),
  listed AS (
    SELECT counted.client_id FROM counted
    UNION
    SELECT ambiguous_clients.client_id FROM ambiguous_clients
  )
  SELECT
    listed.client_id,
    CASE WHEN ambiguous_clients.client_id IS NULL THEN counted.orders ELSE NULL END AS orders,
    CASE WHEN ambiguous_clients.client_id IS NULL THEN counted.units ELSE NULL END AS units,
    (ambiguous_clients.client_id IS NULL) AS reliable
  FROM listed
  LEFT JOIN counted ON counted.client_id = listed.client_id
  LEFT JOIN ambiguous_clients ON ambiguous_clients.client_id = listed.client_id;
$$;

COMMENT ON FUNCTION public.client_sale_dispatch_counts() IS
  'Sale dispatch batches and serials per client. Null orders means the match was ambiguous.';

REVOKE ALL ON FUNCTION public.client_sale_dispatch_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.client_sale_dispatch_counts() TO authenticated, service_role;

COMMIT;
