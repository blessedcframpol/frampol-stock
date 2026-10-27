-- PF1a2: batch display statuses for request list pages (one round-trip).
-- Same rules as request_display_status; keep the single-id overload for detail pages.

SET lock_timeout = '5s';

-- SECURITY INVOKER (default for LANGUAGE sql, stated explicitly): same access as
-- request_display_status(uuid). Visibility comes from stock_requests / lines RLS
-- (sales/tech: own rows; admin/accounts/viewer: all). A DEFINER copy of that rule
-- would duplicate RQ2 policy and drift; INVOKER stays aligned automatically.

CREATE OR REPLACE FUNCTION public.request_display_statuses(p_request_ids uuid[])
RETURNS TABLE (request_id uuid, status text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH wanted AS (
    SELECT DISTINCT id
    FROM unnest(coalesce(p_request_ids, ARRAY[]::uuid[])) AS id
    WHERE id IS NOT NULL
  ),
  req AS (
    SELECT r.id, r.review_state, r.invoice_status, r.invoice_approval
    FROM public.stock_requests AS r
    INNER JOIN wanted AS w ON w.id = r.id
  ),
  issued_by_line AS (
    SELECT t.request_line_id, count(*)::bigint AS n
    FROM public.active_transactions AS t
    WHERE t.request_line_id IN (
      SELECT line.id
      FROM public.stock_request_lines AS line
      WHERE line.request_id IN (SELECT req.id FROM req)
    )
    GROUP BY t.request_line_id
  ),
  line_counts AS (
    SELECT
      line.request_id,
      coalesce(sum(line.quantity_requested), 0)::bigint AS requested,
      coalesce(
        sum(least(line.quantity_requested, coalesce(ibl.n, 0))),
        0
      )::bigint AS issued
    FROM public.stock_request_lines AS line
    LEFT JOIN issued_by_line AS ibl ON ibl.request_line_id = line.id
    WHERE line.request_id IN (SELECT req.id FROM req)
    GROUP BY line.request_id
  )
  SELECT
    req.id AS request_id,
    CASE
      WHEN req.review_state = 'cancelled' THEN 'cancelled'
      WHEN req.review_state = 'closed' THEN 'closed'
      WHEN req.review_state = 'rejected' THEN 'rejected'
      WHEN req.review_state = 'awaiting_approval' THEN 'awaiting_approval'
      WHEN coalesce(lc.issued, 0) = 0 THEN 'being_reviewed'
      WHEN coalesce(lc.issued, 0) < coalesce(lc.requested, 0) THEN 'partially_issued'
      WHEN req.invoice_status = 'invoiced'
        OR (req.invoice_status = 'not_invoiced' AND req.invoice_approval = 'approved')
        THEN 'completed'
      ELSE 'awaiting_invoice'
    END AS status
  FROM req
  LEFT JOIN line_counts AS lc ON lc.request_id = req.id;
$$;

COMMENT ON FUNCTION public.request_display_statuses(uuid[]) IS
  'Batch of (request_id, status) using the same rules as request_display_status. RLS via SECURITY INVOKER.';

REVOKE ALL ON FUNCTION public.request_display_statuses(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_display_statuses(uuid[]) TO authenticated, service_role;
