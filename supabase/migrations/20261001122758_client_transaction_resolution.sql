-- One resolution of a transaction to a directory client.
-- Requested as migration 062. Version 062 is already
-- 062_product_lines_update_denied.sql, and 063/064 are applied, so this
-- file is the applied version 20261001122758, which sorts after
-- 20261001104902_client_sale_dispatch_counts.sql.
--
-- client_id wins when that id is in public.clients. Text is used only when
-- client_id is null and lower(trim(client)) equals exactly one directory key.
-- A client_id that is not in the directory is dangling and is not re-matched
-- by text. The sale-count function is rebuilt on this view. It stays
-- SECURITY INVOKER: the previous function is invoker with search_path=public,
-- and the view is security_invoker so transactions and clients RLS still apply.

BEGIN;

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
  txn.batch_key
FROM txn
LEFT JOIN text_span ON text_span.txn_id = txn.id;

COMMENT ON VIEW public.client_transaction_resolution IS
  'One row per transaction. client_id wins when it is a directory id. Null client_id with client Internal is method internal, not a directory match. Other null ids match text only against exactly one directory key. Dangling ids are not re-matched by text.';

REVOKE ALL ON public.client_transaction_resolution FROM PUBLIC, anon;
GRANT SELECT ON public.client_transaction_resolution TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.client_transactions(p_client_id text)
RETURNS TABLE (
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
  created_by uuid,
  created_at timestamptz,
  batch_key text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    transactions.id,
    transactions.type,
    transactions.serial_number,
    transactions.item_name,
    transactions.client,
    transactions.date,
    transactions.client_id,
    transactions.invoice_number,
    transactions.notes,
    transactions.from_location,
    transactions.to_location,
    transactions.assigned_to,
    transactions.disposal_reason,
    transactions.authorised_by,
    transactions.batch_id,
    transactions.delivery_note_url,
    transactions.metadata,
    transactions.created_by,
    transactions.created_at,
    resolution.batch_key
  FROM public.client_transaction_resolution AS resolution
  JOIN public.transactions ON transactions.id = resolution.transaction_id
  WHERE resolution.resolved_client_id = p_client_id
  ORDER BY transactions.date DESC, transactions.created_at DESC NULLS LAST, transactions.id DESC;
$$;

COMMENT ON FUNCTION public.client_transactions(text) IS
  'Transactions resolved to this directory client, newest business date first. Reads client_transaction_resolution.';

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
  SELECT
    resolution.resolved_client_id AS client_id,
    count(DISTINCT resolution.batch_key)::integer AS orders,
    count(*)::integer AS units,
    true AS reliable
  FROM public.client_transaction_resolution AS resolution
  JOIN public.transactions ON transactions.id = resolution.transaction_id
  WHERE transactions.type = 'Sale'
    AND resolution.resolved_client_id IS NOT NULL
  GROUP BY resolution.resolved_client_id;
$$;

COMMENT ON FUNCTION public.client_sale_dispatch_counts() IS
  'Sale dispatch batches and serials per resolved client, from client_transaction_resolution. reliable is true; unresolved sales are omitted.';

CREATE OR REPLACE FUNCTION public.client_last_activity()
RETURNS TABLE (
  client_id text,
  last_activity_date text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    resolution.resolved_client_id AS client_id,
    max(left(transactions.date, 10)) AS last_activity_date
  FROM public.client_transaction_resolution AS resolution
  JOIN public.transactions ON transactions.id = resolution.transaction_id
  WHERE resolution.resolved_client_id IS NOT NULL
  GROUP BY resolution.resolved_client_id;
$$;

COMMENT ON FUNCTION public.client_last_activity() IS
  'Latest business date among transactions resolved to each directory client. Internal and unresolved rows are not a client''s activity.';

-- Default privileges grant EXECUTE to anon. REVOKE FROM PUBLIC does not remove that direct grant.
REVOKE ALL ON FUNCTION public.client_transactions(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.client_sale_dispatch_counts() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.client_last_activity() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.client_transactions(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.client_sale_dispatch_counts() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.client_last_activity() TO authenticated, service_role;

COMMIT;
