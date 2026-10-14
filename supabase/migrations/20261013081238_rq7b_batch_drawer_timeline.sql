-- RQ7b: batch movement history for the shared drawer timeline (SECURITY INVOKER + RLS).
-- No BEGIN/COMMIT: rehearse and apply wrap their own transactions.

CREATE OR REPLACE FUNCTION public.batch_movement_history(p_batch_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH batch AS (
    SELECT nullif(btrim(coalesce(p_batch_id, '')), '') AS id
  ),
  req AS (
    SELECT brc.request_id
    FROM batch
    JOIN public.batch_request_context AS brc ON brc.batch_id = batch.id
    WHERE batch.id IS NOT NULL
  ),
  issued_txn AS (
    SELECT
      min(t.created_at) AS at,
      (
        array_agg(t.created_by ORDER BY t.created_at ASC NULLS LAST, t.id ASC)
        FILTER (WHERE t.created_by IS NOT NULL)
      )[1]::text AS actor_id
    FROM batch
    JOIN public.active_transactions AS t
      ON coalesce(nullif(btrim(t.batch_id), ''), t.id) = batch.id
    WHERE batch.id IS NOT NULL
    GROUP BY batch.id
  ),
  request_rows AS (
    SELECT
      sr.created_at AS at,
      sr.created_by::text AS actor_id,
      'requested'::text AS kind,
      'Request submitted'::text AS title,
      sr.request_number AS detail,
      NULL::text AS change_from,
      NULL::text AS change_to,
      NULL::text AS reason
    FROM batch
    JOIN req ON true
    JOIN public.stock_requests AS sr ON sr.id = req.request_id

    UNION ALL

    SELECT
      ev.created_at AS at,
      ev.actor_id::text AS actor_id,
      (CASE ev.event_type
        WHEN 'not_invoiced_approved' THEN 'approval'
        WHEN 'units_issued' THEN 'issued'
        ELSE 'request_event'
      END)::text AS kind,
      (CASE ev.event_type
        WHEN 'submitted' THEN 'Request submitted'
        WHEN 'not_invoiced_approved' THEN '00000 approved'
        WHEN 'units_issued' THEN 'Issued'
        WHEN 'invoice_set' THEN 'Invoice updated on request'
        ELSE replace(ev.event_type, '_', ' ')
      END)::text AS title,
      coalesce(ev.payload->>'batch_id', NULL)::text AS detail,
      NULL::text AS change_from,
      NULL::text AS change_to,
      coalesce(ev.payload->>'reason', ev.payload->>'note')::text AS reason
    FROM batch
    JOIN req ON true
    JOIN public.stock_request_events AS ev ON ev.request_id = req.request_id
    WHERE ev.event_type IN ('submitted', 'not_invoiced_approved', 'units_issued', 'invoice_set')
      AND (
        ev.event_type <> 'units_issued'
        OR coalesce(ev.payload->>'batch_id', '') = batch.id
      )
      AND (
        ev.event_type NOT IN ('invoice_set')
        OR coalesce(ev.payload->>'batch_id', '') = batch.id
        OR coalesce(ev.payload->>'batch_id', '') = ''
      )
  ),
  invoice_rows AS (
    SELECT
      ev.created_at AS at,
      ev.actor_id::text AS actor_id,
      'invoice'::text AS kind,
      CASE
        WHEN ev.old_status IS DISTINCT FROM ev.new_status AND ev.new_status = 'pending' THEN 'Invoice pending'
        WHEN ev.old_status IS DISTINCT FROM ev.new_status AND ev.new_status = 'invoiced' THEN 'Invoice added'
        WHEN coalesce(ev.old_invoice_number, '') IS DISTINCT FROM coalesce(ev.new_invoice_number, '')
          THEN 'Invoice number changed'
        WHEN ev.old_approval IS DISTINCT FROM ev.new_approval AND ev.new_approval = 'approved' THEN '00000 approved'
        WHEN ev.old_approval IS DISTINCT FROM ev.new_approval AND ev.new_approval = 'rejected' THEN '00000 approval rejected'
        ELSE 'Invoice updated'
      END AS title,
      NULL::text AS detail,
      coalesce(ev.old_invoice_number, ev.old_status, 'none') AS change_from,
      coalesce(ev.new_invoice_number, ev.new_status, 'none') AS change_to,
      ev.reason
    FROM batch
    JOIN public.batch_invoice_events AS ev ON ev.batch_id = batch.id
    WHERE batch.id IS NOT NULL
  ),
  reversal_rows AS (
    SELECT
      rev.reversed_at AS at,
      rev.reversed_by::text AS actor_id,
      'reversed'::text AS kind,
      CASE coalesce(rev.kind, 'reversal')
        WHEN 'void' THEN 'Voided'
        ELSE 'Reversed'
      END AS title,
      NULL::text AS detail,
      NULL::text AS change_from,
      NULL::text AS change_to,
      rev.reversal_reason AS reason
    FROM batch
    JOIN public.batch_reversals AS rev ON rev.batch_id = batch.id
    WHERE batch.id IS NOT NULL
  ),
  restore_rows AS (
    SELECT
      res.restored_at AS at,
      res.restored_by::text AS actor_id,
      'restored'::text AS kind,
      'Restored'::text AS title,
      NULL::text AS detail,
      NULL::text AS change_from,
      NULL::text AS change_to,
      res.restore_reason AS reason
    FROM batch
    JOIN public.batch_restores AS res ON res.batch_id = batch.id
    WHERE batch.id IS NOT NULL
  ),
  issued_row AS (
    SELECT
      issued_txn.at,
      issued_txn.actor_id,
      'issued'::text AS kind,
      'Issued'::text AS title,
      NULL::text AS detail,
      NULL::text AS change_from,
      NULL::text AS change_to,
      NULL::text AS reason
    FROM issued_txn
    WHERE issued_txn.at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM request_rows AS rr
        WHERE rr.kind = 'issued'
      )
  ),
  combined AS (
    SELECT * FROM request_rows
    UNION ALL
    SELECT * FROM invoice_rows
    UNION ALL
    SELECT * FROM reversal_rows
    UNION ALL
    SELECT * FROM restore_rows
    UNION ALL
    SELECT * FROM issued_row
  )
  SELECT coalesce(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'at', row.at,
          'actorId', row.actor_id,
          'kind', row.kind,
          'title', row.title,
          'detail', row.detail,
          'changeFrom', row.change_from,
          'changeTo', row.change_to,
          'reason', row.reason
        )
        ORDER BY row.at DESC NULLS LAST
      )
      FROM combined AS row
      WHERE row.at IS NOT NULL
    ),
    '[]'::jsonb
  );
$$;

COMMENT ON FUNCTION public.batch_movement_history(text) IS
  'Timeline rows for a movement batch: request, issue, invoice, reversal, restore. Respects RLS via SECURITY INVOKER.';

REVOKE ALL ON FUNCTION public.batch_movement_history(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.batch_movement_history(text) TO authenticated, service_role;
