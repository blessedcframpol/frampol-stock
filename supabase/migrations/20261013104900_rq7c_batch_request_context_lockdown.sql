-- RQ7c: lock down batch_request_context; expose via batch_request_context_for only.
-- No BEGIN/COMMIT: rehearse and apply wrap their own transactions.

CREATE OR REPLACE FUNCTION public.batch_request_context_for(p_batch_ids text[])
RETURNS TABLE (
  batch_id text,
  request_id uuid,
  request_number text,
  requester_name text,
  atlas_task_url text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    brc.batch_id,
    brc.request_id,
    brc.request_number,
    brc.requester_name,
    brc.atlas_task_url
  FROM public.batch_request_context AS brc
  INNER JOIN public.stock_requests AS sr ON sr.id = brc.request_id
  WHERE brc.batch_id = ANY(coalesce(p_batch_ids, ARRAY[]::text[]))
    AND (
      coalesce((SELECT public.get_my_role())::text, '') IN ('admin', 'accounts', 'viewer')
      OR sr.created_by IS NOT DISTINCT FROM (SELECT auth.uid())
    );
$$;

COMMENT ON FUNCTION public.batch_request_context_for(text[]) IS
  'Request context for movement batches visible to admin/accounts/viewer or the request owner.';

REVOKE ALL ON FUNCTION public.batch_request_context_for(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.batch_request_context_for(text[]) TO authenticated, service_role;

REVOKE ALL ON public.batch_request_context FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.batch_request_context TO service_role;

COMMENT ON VIEW public.batch_request_context IS
  'Internal view for batch_request_context_for (DEFINER). Not granted to authenticated.';


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
    ORDER BY live.serial_number, left(txn.date, 10) DESC NULLS LAST, txn.created_at DESC NULLS LAST, txn.id DESC
  ),
  shaped AS (
    SELECT
      latest.id,
      latest.serial_number,
      latest.status,
      coalesce(nullif(btrim(latest.assigned_to), ''), '') AS assigned_to,
      latest.product_name,
      CASE
        WHEN latest.txn_type IN ('Sale', 'Rentals') THEN coalesce(
          CASE inv.status
            WHEN 'invoiced' THEN inv.invoice_number
            WHEN 'pending' THEN 'Invoice pending'
            WHEN 'legacy_unreviewed' THEN '00000 — unreviewed'
            WHEN 'not_invoiced' THEN CASE inv.approval
              WHEN 'awaiting' THEN 'Awaiting approval'
              ELSE 'Not invoiced'
            END
            ELSE NULL
          END,
          '—'
        )
        ELSE latest.invoice_number
      END AS invoice_number,
      latest.created_by,
      latest.delivery_note_url,
      latest.created_at,
      latest.batch_id,
      coalesce(nullif(btrim(latest.batch_id), ''), latest.txn_id, latest.id) AS request_batch_id,
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
    LEFT JOIN public.batch_invoices AS inv
      ON inv.batch_id = coalesce(nullif(btrim(latest.batch_id), ''), latest.txn_id)
  ),
  flagged AS (
    SELECT
      shaped.*,
      brc.request_number,
      brc.requester_name,
      brc.atlas_task_url,
      brc.request_id,
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
          OR strpos(lower(coalesce(brc.request_number, '')), params.needle) > 0
          OR strpos(lower(coalesce(brc.requester_name, '')), params.needle) > 0
        )
      ) AS batch_field_hit
    FROM shaped
    CROSS JOIN params
    LEFT JOIN LATERAL (
      SELECT
        f.request_number,
        f.requester_name,
        f.atlas_task_url,
        f.request_id
      FROM public.batch_request_context_for(ARRAY[shaped.request_batch_id]) AS f
      LIMIT 1
    ) AS brc ON true
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
      (
        array_agg(
          flagged.request_number
          ORDER BY flagged.date_out DESC NULLS LAST, flagged.created_at DESC NULLS LAST, flagged.id ASC
        ) FILTER (WHERE flagged.request_number IS NOT NULL)
      )[1] AS request_number,
      (
        array_agg(
          flagged.requester_name
          ORDER BY flagged.date_out DESC NULLS LAST, flagged.created_at DESC NULLS LAST, flagged.id ASC
        ) FILTER (WHERE flagged.requester_name IS NOT NULL)
      )[1] AS requester_name,
      (
        array_agg(
          flagged.atlas_task_url
          ORDER BY flagged.date_out DESC NULLS LAST, flagged.created_at DESC NULLS LAST, flagged.id ASC
        ) FILTER (WHERE nullif(btrim(flagged.atlas_task_url), '') IS NOT NULL)
      )[1] AS atlas_task_url,
      (
        array_agg(
          flagged.request_id
          ORDER BY flagged.date_out DESC NULLS LAST, flagged.created_at DESC NULLS LAST, flagged.id ASC
        ) FILTER (WHERE flagged.request_id IS NOT NULL)
      )[1] AS request_id,
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
      batch_meta.delivery_note_url,
      batch_meta.request_number,
      batch_meta.requester_name,
      batch_meta.atlas_task_url,
      batch_meta.request_id
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
      batch_meta.delivery_note_url,
      batch_meta.request_number,
      batch_meta.requester_name,
      batch_meta.atlas_task_url,
      batch_meta.request_id
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
            'requestNumber', page.request_number,
            'requestedBy', page.requester_name,
            'atlasTaskUrl', page.atlas_task_url,
            'requestId', page.request_id,
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

REVOKE ALL ON FUNCTION public.dispatched_page(integer, integer, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispatched_page(integer, integer, text, text, text, text) TO authenticated, service_role;
