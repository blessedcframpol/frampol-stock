-- RQ7d: use batch_request_context_for after view lockdown.

CREATE OR REPLACE FUNCTION public.transaction_batch_page(
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
SET search_path TO 'public'
AS $function$
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
      coalesce(nullif(btrim(t.batch_id), ''), t.id) AS request_batch_id,
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
        OR EXISTS (
          SELECT 1
          FROM public.batch_request_context_for(
            ARRAY[coalesce(nullif(btrim(t.batch_id), ''), t.id)]
          ) AS brc
          WHERE strpos(lower(coalesce(brc.request_number, '')), params.needle) > 0
             OR strpos(lower(coalesce(brc.requester_name, '')), params.needle) > 0
        )
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
$function$;

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
    JOIN LATERAL (
      SELECT f.request_id
      FROM public.batch_request_context_for(ARRAY[batch.id]) AS f
      LIMIT 1
    ) AS brc ON true
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
