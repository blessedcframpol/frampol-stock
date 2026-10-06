-- Kit history is one security-invoker function. The panel renders this payload.

BEGIN;

CREATE OR REPLACE FUNCTION public.kit_history(p_item_id text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_item public.inventory_items%ROWTYPE;
  v_product text;
  v_tz text;
  v_today date;
  v_open jsonb;
  v_last jsonb;
  v_placements jsonb := '[]'::jsonb;
  v_timeline jsonb := '[]'::jsonb;
  v_tags text[] := ARRAY[]::text[];
  v_summary text;
  v_links jsonb := '[]'::jsonb;
  v_open_case uuid;
  v_seen_return boolean := false;
  v_sale_count integer := 0;
  v_resold boolean := false;
  v_rental boolean := false;
  v_demo boolean := false;
  v_decommissioned boolean := false;
  v_days integer;
  v_end text;
  v_from text;
  v_on text;
  rec record;
BEGIN
  IF p_item_id IS NULL OR btrim(p_item_id) = '' THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT * INTO v_item
  FROM public.inventory_items
  WHERE id = p_item_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT line.product_name INTO v_product
  FROM public.product_lines AS line
  WHERE line.id = v_item.product_id;

  SELECT coalesce(
    (SELECT settings.timezone FROM public.app_settings AS settings LIMIT 1),
    'Africa/Harare'
  )
  INTO v_tz;
  v_today := (timezone(v_tz, now()))::date;

  FOR rec IN
    SELECT
      txn.id,
      txn.type,
      txn.date,
      txn.client,
      txn.to_location,
      txn.after_location,
      txn.metadata,
      txn.previous_status,
      txn.batch_id,
      public.batch_is_currently_reversed(coalesce(nullif(btrim(txn.batch_id), ''), txn.id)) AS reversed_now,
      EXISTS (
        SELECT 1
        FROM public.batch_reversals AS reversal
        WHERE reversal.batch_id = txn.batch_id
          AND reversal.kind = 'void'
      ) AS was_void
    FROM public.transactions AS txn
    WHERE txn.serial_number = v_item.serial_number
      AND txn.type IS DISTINCT FROM 'Reversal'
    ORDER BY txn.date ASC, txn.created_at ASC NULLS LAST, txn.id ASC
  LOOP
    IF rec.was_void AND rec.reversed_now THEN
      CONTINUE;
    END IF;
    IF rec.reversed_now THEN
      CONTINUE;
    END IF;

    IF rec.type = 'Sale' THEN
      v_sale_count := v_sale_count + 1;
      IF v_seen_return OR v_sale_count >= 2 THEN
        v_resold := true;
      END IF;
      IF v_open IS NOT NULL
         AND v_open->>'kind' IN ('POC', 'Rental')
         AND coalesce(rec.metadata->>'converted_from', '') IN ('POC', 'POC Out', 'Rentals') THEN
        v_from := v_open->>'kind';
        v_open := v_open || jsonb_build_object(
          'kind', 'Sale',
          'changes', (v_open->'changes') || jsonb_build_array(jsonb_build_object(
            'from', v_from,
            'to', 'Sale',
            'at', left(rec.date, 10),
            'at_label', substring(left(rec.date, 10) FROM 9 FOR 2) || '/' || substring(left(rec.date, 10) FROM 6 FOR 2)
          ))
        );
      ELSE
        IF v_open IS NOT NULL THEN
          v_end := left(rec.date, 10);
          v_days := v_end::date - (v_open->>'start')::date;
          v_open := v_open || jsonb_build_object(
            'end', v_end,
            'end_label', substring(v_end FROM 9 FOR 2) || '/' || substring(v_end FROM 6 FOR 2) || '/' || substring(v_end FROM 1 FOR 4),
            'end_short', substring(v_end FROM 9 FOR 2) || '/' || substring(v_end FROM 6 FOR 2),
            'duration_days', v_days,
            'duration_label', CASE
              WHEN v_days < 60 THEN v_days::text || CASE WHEN v_days = 1 THEN ' day' ELSE ' days' END
              ELSE round(v_days / 30.44)::int::text || CASE WHEN round(v_days / 30.44)::int = 1 THEN ' month' ELSE ' months' END
            END
          );
          v_placements := v_placements || jsonb_build_array(v_open);
          v_last := v_open;
          v_open := NULL;
        END IF;
        v_open := jsonb_build_object(
          'client', nullif(btrim(coalesce(rec.client, '')), ''),
          'location', coalesce(nullif(btrim(coalesce(rec.to_location, '')), ''), nullif(btrim(coalesce(rec.after_location, '')), '')),
          'kind', 'Sale',
          'start', left(rec.date, 10),
          'start_label', substring(left(rec.date, 10) FROM 9 FOR 2) || '/' || substring(left(rec.date, 10) FROM 6 FOR 2) || '/' || substring(left(rec.date, 10) FROM 1 FOR 4),
          'start_short', substring(left(rec.date, 10) FROM 9 FOR 2) || '/' || substring(left(rec.date, 10) FROM 6 FOR 2),
          'end', 'current',
          'end_label', 'current',
          'end_short', 'current',
          'duration_days', v_today - left(rec.date, 10)::date,
          'duration_label', NULL,
          'changes', '[]'::jsonb
        );
      END IF;
    ELSIF rec.type = 'POC Out' THEN
      v_open := jsonb_build_object(
        'client', nullif(btrim(coalesce(rec.client, '')), ''),
        'location', coalesce(nullif(btrim(coalesce(rec.to_location, '')), ''), nullif(btrim(coalesce(rec.after_location, '')), '')),
        'kind', 'POC',
        'start', left(rec.date, 10),
        'start_label', substring(left(rec.date, 10) FROM 9 FOR 2) || '/' || substring(left(rec.date, 10) FROM 6 FOR 2) || '/' || substring(left(rec.date, 10) FROM 1 FOR 4),
        'start_short', substring(left(rec.date, 10) FROM 9 FOR 2) || '/' || substring(left(rec.date, 10) FROM 6 FOR 2),
        'end', 'current',
        'end_label', 'current',
        'end_short', 'current',
        'duration_days', v_today - left(rec.date, 10)::date,
        'duration_label', NULL,
        'changes', '[]'::jsonb
      );
    ELSIF rec.type = 'Rentals' THEN
      v_open := jsonb_build_object(
        'client', nullif(btrim(coalesce(rec.client, '')), ''),
        'location', coalesce(nullif(btrim(coalesce(rec.to_location, '')), ''), nullif(btrim(coalesce(rec.after_location, '')), '')),
        'kind', 'Rental',
        'start', left(rec.date, 10),
        'start_label', substring(left(rec.date, 10) FROM 9 FOR 2) || '/' || substring(left(rec.date, 10) FROM 6 FOR 2) || '/' || substring(left(rec.date, 10) FROM 1 FOR 4),
        'start_short', substring(left(rec.date, 10) FROM 9 FOR 2) || '/' || substring(left(rec.date, 10) FROM 6 FOR 2),
        'end', 'current',
        'end_label', 'current',
        'end_short', 'current',
        'duration_days', v_today - left(rec.date, 10)::date,
        'duration_label', NULL,
        'changes', '[]'::jsonb
      );
    ELSIF rec.type = 'Decommissioned' AND rec.previous_status IS NULL THEN
      v_end := left(rec.date, 10);
      v_placements := v_placements || jsonb_build_array(jsonb_build_object(
        'client', nullif(btrim(coalesce(rec.client, '')), ''),
        'location', coalesce(nullif(btrim(coalesce(rec.to_location, '')), ''), nullif(btrim(coalesce(rec.after_location, '')), '')),
        'kind', 'Decommissioned',
        'start', 'unknown',
        'start_label', 'unknown',
        'start_short', 'unknown',
        'end', v_end,
        'end_label', substring(v_end FROM 9 FOR 2) || '/' || substring(v_end FROM 6 FOR 2) || '/' || substring(v_end FROM 1 FOR 4),
        'end_short', substring(v_end FROM 9 FOR 2) || '/' || substring(v_end FROM 6 FOR 2),
        'duration_days', NULL,
        'duration_label', NULL,
        'changes', '[]'::jsonb
      ));
      v_last := v_placements->-1;
      v_seen_return := true;
    ELSIF rec.type IN ('POC Return', 'Rental Return', 'Decommissioned') THEN
      v_seen_return := true;
      IF v_open IS NOT NULL THEN
        v_end := left(rec.date, 10);
        v_days := CASE
          WHEN v_open->>'start' = 'unknown' THEN NULL
          ELSE v_end::date - (v_open->>'start')::date
        END;
        v_open := v_open || jsonb_build_object(
          'end', v_end,
          'end_label', substring(v_end FROM 9 FOR 2) || '/' || substring(v_end FROM 6 FOR 2) || '/' || substring(v_end FROM 1 FOR 4),
          'end_short', substring(v_end FROM 9 FOR 2) || '/' || substring(v_end FROM 6 FOR 2),
          'duration_days', v_days,
          'duration_label', CASE
            WHEN v_days IS NULL THEN NULL
            WHEN v_days < 60 THEN v_days::text || CASE WHEN v_days = 1 THEN ' day' ELSE ' days' END
            ELSE round(v_days / 30.44)::int::text || CASE WHEN round(v_days / 30.44)::int = 1 THEN ' month' ELSE ' months' END
          END
        );
        v_placements := v_placements || jsonb_build_array(v_open);
        v_last := v_open;
        v_open := NULL;
      END IF;
    END IF;
  END LOOP;

  IF v_open IS NOT NULL AND coalesce(v_open->>'start', '') <> 'unknown' THEN
    v_days := v_today - (v_open->>'start')::date;
    v_open := v_open || jsonb_build_object(
      'end', 'current',
      'end_label', 'current',
      'end_short', 'current',
      'duration_days', v_days,
      'duration_label', CASE
        WHEN v_days < 60 THEN v_days::text || CASE WHEN v_days = 1 THEN ' day' ELSE ' days' END
        ELSE round(v_days / 30.44)::int::text || CASE WHEN round(v_days / 30.44)::int = 1 THEN ' month' ELSE ' months' END
      END
    );
  END IF;

  IF v_open IS NOT NULL AND v_open->>'kind' = 'Sale' THEN
    v_on := coalesce(v_open #>> '{changes,-1,at_label}', v_open->>'start_short');
    v_summary := 'Sold to ' || coalesce(v_open->>'client', 'the client') || ' on ' || v_on;
  ELSIF v_open IS NOT NULL AND v_open->>'kind' = 'Rental' THEN
    v_summary := 'With ' || coalesce(v_open->>'client', 'the client')
      || ' on rental since ' || coalesce(v_open->>'start_short', '')
      || ' (' || coalesce(v_open->>'duration_days', '0') || ' days)';
  ELSIF v_open IS NOT NULL AND v_open->>'kind' = 'POC' THEN
    v_summary := 'With ' || coalesce(v_open->>'client', 'the client')
      || ' on POC since ' || coalesce(v_open->>'start_short', '')
      || ' (' || coalesce(v_open->>'duration_days', '0') || ' days)';
  ELSIF v_last IS NOT NULL AND v_last->>'start' = 'unknown' THEN
    v_summary := 'Returned on ' || coalesce(v_last->>'end_short', '') || ', previous start unknown';
  ELSIF v_last IS NOT NULL AND v_item.status = 'In Stock' THEN
    v_summary := 'Previously at ' || coalesce(v_last->>'client', 'the client')
      || ' for ' || coalesce(v_last->>'duration_label', '0 days')
      || ', now back in stock';
  ELSIF v_item.status = 'Pending Inspection' THEN
    v_summary := 'Returned on ' || coalesce(v_last->>'end_short', '') || ', pending inspection';
  ELSE
    v_summary := v_item.status;
  END IF;

  SELECT
    v_item.stock_pool = 'rental'
    OR EXISTS (
      SELECT 1
      FROM public.transactions AS txn
      WHERE txn.serial_number = v_item.serial_number
        AND txn.type = 'Rentals'
        AND NOT (
          EXISTS (
            SELECT 1 FROM public.batch_reversals AS reversal
            WHERE reversal.batch_id = txn.batch_id AND reversal.kind = 'void'
          )
          AND public.batch_is_currently_reversed(coalesce(nullif(btrim(txn.batch_id), ''), txn.id))
        )
    ),
    v_item.stock_pool = 'demo'
    OR EXISTS (
      SELECT 1 FROM public.transactions AS txn
      WHERE txn.serial_number = v_item.serial_number
        AND txn.after_stock_pool = 'demo'
    )
    OR EXISTS (
      SELECT 1 FROM public.stock_pool_changes AS change
      WHERE change.inventory_item_id = v_item.id
        AND change.to_pool = 'demo'
    ),
    EXISTS (
      SELECT 1
      FROM public.transactions AS txn
      WHERE txn.serial_number = v_item.serial_number
        AND txn.type = 'Decommissioned'
        AND NOT (
          EXISTS (
            SELECT 1 FROM public.batch_reversals AS reversal
            WHERE reversal.batch_id = txn.batch_id AND reversal.kind = 'void'
          )
          AND public.batch_is_currently_reversed(coalesce(nullif(btrim(txn.batch_id), ''), txn.id))
        )
    )
  INTO v_rental, v_demo, v_decommissioned;

  IF v_rental THEN v_tags := array_append(v_tags, 'Rental'); END IF;
  IF v_demo THEN v_tags := array_append(v_tags, 'Demo'); END IF;
  IF v_decommissioned THEN v_tags := array_append(v_tags, 'Decommissioned'); END IF;
  IF v_resold THEN v_tags := array_append(v_tags, 'Resold'); END IF;

  SELECT cases.id INTO v_open_case
  FROM public.kit_cases AS cases
  WHERE cases.inventory_item_id = v_item.id
    AND cases.stage = 'open'
  ORDER BY cases.opened_at ASC
  LIMIT 1;

  IF v_open_case IS NOT NULL THEN
    v_links := v_links || jsonb_build_array(jsonb_build_object(
      'label', 'Open inspection',
      'href', '/inventory/inspections/' || v_open_case::text
    ));
  END IF;
  v_links := v_links || jsonb_build_array(jsonb_build_object(
    'label', 'Inventory',
    'href', '/inventory?serial=' || replace(v_item.serial_number, ' ', '%20')
  ));

  v_timeline := (
  WITH actor AS (
    SELECT id, coalesce(nullif(btrim(display_name), ''), email) AS name
    FROM public.profiles
  ),
  entries AS (
    SELECT
      jsonb_build_object(
        'id', txn.id,
        'sort_at', coalesce(txn.created_at, left(txn.date, 10)::timestamptz),
        'date_label', substring(left(txn.date, 10) FROM 9 FOR 2) || '/' || substring(left(txn.date, 10) FROM 6 FOR 2) || '/' || substring(left(txn.date, 10) FROM 1 FOR 4),
        'kind', txn.type,
        'title', txn.type,
        'detail', concat_ws(
          ' · ',
          nullif(btrim(coalesce(txn.client, '')), ''),
          nullif(btrim(coalesce(txn.to_location, txn.after_location, '')), ''),
          CASE
            WHEN txn.previous_stock_pool IS NOT NULL
             AND txn.after_stock_pool IS NOT NULL
             AND txn.previous_stock_pool IS DISTINCT FROM txn.after_stock_pool
            THEN 'Pool ' || txn.previous_stock_pool || ' to ' || txn.after_stock_pool
            ELSE NULL
          END
        ),
        'who', who.name,
        'reversed', public.batch_is_currently_reversed(coalesce(nullif(btrim(txn.batch_id), ''), txn.id)),
        'voided', EXISTS (
          SELECT 1 FROM public.batch_reversals AS reversal
          WHERE reversal.batch_id = txn.batch_id AND reversal.kind = 'void'
        ),
        'reversal', (
          SELECT jsonb_build_object(
            'reason', reversal.reversal_reason,
            'who', rev_who.name,
            'when', to_char(reversal.reversed_at AT TIME ZONE v_tz, 'DD/MM/YYYY HH24:MI')
          )
          FROM public.batch_reversals AS reversal
          LEFT JOIN actor AS rev_who ON rev_who.id::text = reversal.reversed_by
          WHERE reversal.batch_id = txn.batch_id
        ),
        'restore', (
          SELECT jsonb_build_object(
            'reason', restored.restore_reason,
            'who', res_who.name,
            'when', to_char(restored.restored_at AT TIME ZONE v_tz, 'DD/MM/YYYY HH24:MI')
          )
          FROM public.batch_restores AS restored
          LEFT JOIN actor AS res_who ON res_who.id::text = restored.restored_by
          WHERE restored.batch_id = txn.batch_id
          ORDER BY restored.restored_at DESC
          LIMIT 1
        ),
        'invoice', (
          SELECT jsonb_build_object(
            'status', invoice.status,
            'invoice_number', invoice.invoice_number,
            'approval', invoice.approval
          )
          FROM public.batch_invoices AS invoice
          WHERE invoice.batch_id = coalesce(nullif(btrim(txn.batch_id), ''), txn.id)
        )
      ) AS entry,
      coalesce(txn.created_at, left(txn.date, 10)::timestamptz) AS sort_at,
      txn.id AS sort_id
    FROM public.transactions AS txn
    LEFT JOIN actor AS who ON who.id = txn.created_by
    WHERE txn.serial_number = v_item.serial_number
      AND txn.type IS DISTINCT FROM 'Reversal'

    UNION ALL

    SELECT
      jsonb_build_object(
        'id', event.id::text,
        'sort_at', event.at,
        'date_label', to_char(event.at AT TIME ZONE v_tz, 'DD/MM/YYYY'),
        'kind', event.event_type,
        'title', CASE event.event_type
          WHEN 'opened' THEN 'Intake'
          WHEN 'inspection_recorded' THEN 'Inspection'
          WHEN 'outcome_applied' THEN 'Outcome'
          WHEN 're-closed' THEN 'Re-closed'
          ELSE initcap(replace(event.event_type, '_', ' '))
        END,
        'detail', CASE event.event_type
          WHEN 'opened' THEN cases.reason_category || ': ' || cases.reason_text
          WHEN 'inspection_recorded' THEN concat_ws(
            ' · ',
            nullif(event.payload->>'result', ''),
            nullif(event.payload->>'grade', ''),
            nullif(event.payload->>'comments', '')
          )
          WHEN 'outcome_applied' THEN nullif(event.payload->>'outcome', '')
          ELSE nullif(btrim(coalesce(event.reason, event.payload->>'note', '')), '')
        END,
        'who', who.name,
        'reversed', false,
        'voided', false,
        'reversal', NULL,
        'restore', NULL,
        'invoice', NULL
      ),
      event.at,
      event.id::text
    FROM public.kit_case_events AS event
    JOIN public.kit_cases AS cases ON cases.id = event.case_id
    LEFT JOIN actor AS who ON who.id = event.actor
    WHERE cases.inventory_item_id = v_item.id

    UNION ALL

    SELECT
      jsonb_build_object(
        'id', change.id::text,
        'sort_at', change.changed_at,
        'date_label', to_char(change.changed_at AT TIME ZONE v_tz, 'DD/MM/YYYY'),
        'kind', 'stock_pool',
        'title', 'Stock pool',
        'detail', change.from_pool || ' to ' || change.to_pool || '. ' || change.reason,
        'who', who.name,
        'reversed', false,
        'voided', false,
        'reversal', NULL,
        'restore', NULL,
        'invoice', NULL
      ),
      change.changed_at,
      change.id::text
    FROM public.stock_pool_changes AS change
    LEFT JOIN actor AS who ON who.id = change.changed_by
    WHERE change.inventory_item_id = v_item.id

    UNION ALL

    SELECT
      jsonb_build_object(
        'id', extension.id::text,
        'sort_at', extension.created_at,
        'date_label', to_char(extension.created_at AT TIME ZONE v_tz, 'DD/MM/YYYY'),
        'kind', 'holding_extension',
        'title', 'Holding extension',
        'detail', concat_ws(
          ' ',
          'Return date',
          coalesce(extension.previous_date, 'none'),
          'to',
          extension.new_date || '.',
          extension.reason
        ),
        'who', who.name,
        'reversed', false,
        'voided', false,
        'reversal', NULL,
        'restore', NULL,
        'invoice', NULL
      ),
      extension.created_at,
      extension.id::text
    FROM public.holding_extensions AS extension
    LEFT JOIN actor AS who ON who.id = extension.extended_by
    WHERE extension.item_id = v_item.id

    UNION ALL

    SELECT
      jsonb_build_object(
        'id', extension.id::text || ':cancel',
        'sort_at', extension.cancelled_at,
        'date_label', to_char(extension.cancelled_at AT TIME ZONE v_tz, 'DD/MM/YYYY'),
        'kind', 'holding_cancellation',
        'title', 'Holding cancellation',
        'detail', extension.cancel_reason,
        'who', who.name,
        'reversed', false,
        'voided', false,
        'reversal', NULL,
        'restore', NULL,
        'invoice', NULL
      ),
      extension.cancelled_at,
      extension.id::text || ':cancel'
    FROM public.holding_extensions AS extension
    LEFT JOIN actor AS who ON who.id = extension.cancelled_by
    WHERE extension.item_id = v_item.id
      AND extension.cancelled_at IS NOT NULL
  )
  SELECT coalesce(jsonb_agg(entry ORDER BY sort_at DESC, sort_id DESC), '[]'::jsonb)
  FROM entries
  );

  IF v_open IS NOT NULL THEN
    v_placements := v_placements || jsonb_build_array(v_open);
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'item_id', v_item.id,
    'serial', v_item.serial_number,
    'product', v_product,
    'status', v_item.status,
    'summary', v_summary,
    'tags', to_jsonb(v_tags),
    'placements', v_placements,
    'timeline', v_timeline,
    'links', v_links
  );
END;
$$;

COMMENT ON FUNCTION public.kit_history(text) IS
  'Ordered kit timeline, placements, summary line, and tags. The app renders this and does not rebuild history from rows.';

REVOKE ALL ON FUNCTION public.kit_history(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kit_history(text) TO authenticated, service_role;

COMMIT;
