-- Group transactions into history batches in the database, then page the groups.
-- A limit applied to raw transaction rows splits a batch (the 1,000-row cap returned
-- 4 of 20 rows for BATCH-1782196092906-k93oad3). Grouping first keeps every batch whole.
-- The key matches getTransactionOrderGroupKey: batch_id, else legacy Sale/POC/Rentals
-- on type + invoice + date, else one row.

BEGIN;

CREATE OR REPLACE FUNCTION public.transaction_batch_page(p_limit integer, p_offset integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH keyed AS (
    SELECT
      t.id,
      left(t.date, 10) AS sort_date,
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
      ) AS is_reversed
    FROM public.transactions AS t
  ),
  grouped AS (
    SELECT
      batch_key,
      bool_or(is_reversed) AS is_reversed,
      max(sort_date) AS sort_date,
      array_agg(id ORDER BY sort_date DESC, id DESC) AS transaction_ids
    FROM keyed
    GROUP BY batch_key
  ),
  page AS (
    SELECT
      batch_key,
      transaction_ids,
      row_number() OVER (
        ORDER BY is_reversed ASC, sort_date DESC, batch_key ASC
      ) AS ordinality
    FROM grouped
    ORDER BY is_reversed ASC, sort_date DESC, batch_key ASC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 0), 100)
    OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*)::int FROM grouped),
    'batches', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'batchKey', page.batch_key,
            'transactionIds', to_jsonb(page.transaction_ids)
          )
          ORDER BY page.ordinality
        )
        FROM page
      ),
      '[]'::jsonb
    )
  );
$$;

COMMENT ON FUNCTION public.transaction_batch_page(integer, integer) IS
  'One page of complete transaction batches plus the total batch count. Rows are grouped before the limit, so a batch is never split.';

REVOKE ALL ON FUNCTION public.transaction_batch_page(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transaction_batch_page(integer, integer) TO authenticated, service_role;

COMMIT;
