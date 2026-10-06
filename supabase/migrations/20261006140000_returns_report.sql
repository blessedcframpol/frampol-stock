-- Returns report for the Inspections screen and its CSV export. One function, one payload.

BEGIN;

CREATE OR REPLACE FUNCTION public.returns_report(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_tz text;
  v_today date;
  v_oldest timestamptz;
  v_oldest_days integer;
  v_rental integer;
  v_waiting jsonb;
  v_returns jsonb;
  v_outcomes jsonb;
  v_results jsonb;
  v_grades jsonb;
  v_sites jsonb;
BEGIN
  IF coalesce((SELECT public.get_my_role())::text, '') NOT IN ('admin', 'accounts', 'viewer') THEN
    RAISE EXCEPTION 'returns_report: not allowed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'returns_report: choose a from and to date'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT coalesce(
    (SELECT settings.timezone FROM public.app_settings AS settings LIMIT 1),
    'Africa/Harare'
  )
  INTO v_tz;
  v_today := (timezone(v_tz, now()))::date;

  SELECT count(*)::int
  INTO v_rental
  FROM public.inventory_items AS item
  WHERE item.status = 'Rented'
    AND item.deleted_at IS NULL;

  SELECT min(cases.opened_at)
  INTO v_oldest
  FROM public.kit_cases AS cases
  WHERE cases.stage = 'open';

  v_oldest_days := CASE
    WHEN v_oldest IS NULL THEN NULL
    ELSE v_today - (v_oldest AT TIME ZONE v_tz)::date
  END;

  SELECT jsonb_build_array(
    jsonb_build_object(
      'type', 'Decommissioned',
      'units', coalesce(count(*) FILTER (WHERE src.type IS DISTINCT FROM 'Rental Return'), 0)
    ),
    jsonb_build_object(
      'type', 'Rental return',
      'units', coalesce(count(*) FILTER (WHERE src.type = 'Rental Return'), 0)
    )
  )
  INTO v_waiting
  FROM public.kit_cases AS cases
  JOIN public.transactions AS src ON src.id = cases.source_transaction_id
  WHERE cases.stage = 'open';

  WITH opened AS (
    SELECT
      cases.reason_category,
      btrim(cases.reason_text) AS reason_text
    FROM public.kit_cases AS cases
    WHERE (cases.opened_at AT TIME ZONE v_tz)::date BETWEEN p_from AND p_to
      AND cases.reason_category IN ('Client cancelled', 'Service termination')
  ),
  reason_rows AS (
    SELECT reason_category, reason_text, count(*)::int AS units
    FROM opened
    WHERE reason_text <> ''
    GROUP BY reason_category, reason_text
  )
  SELECT jsonb_build_array(
    jsonb_build_object(
      'category', 'Client cancelled',
      'units', coalesce((SELECT count(*)::int FROM opened WHERE reason_category = 'Client cancelled'), 0),
      'reasons', coalesce((
        SELECT jsonb_agg(jsonb_build_object('text', reason_text, 'units', units) ORDER BY units DESC, reason_text ASC)
        FROM reason_rows
        WHERE reason_category = 'Client cancelled'
      ), '[]'::jsonb)
    ),
    jsonb_build_object(
      'category', 'Service termination',
      'units', coalesce((SELECT count(*)::int FROM opened WHERE reason_category = 'Service termination'), 0),
      'reasons', coalesce((
        SELECT jsonb_agg(jsonb_build_object('text', reason_text, 'units', units) ORDER BY units DESC, reason_text ASC)
        FROM reason_rows
        WHERE reason_category = 'Service termination'
      ), '[]'::jsonb)
    )
  )
  INTO v_returns;

  WITH counted AS (
    SELECT
      event.payload->>'outcome' AS outcome,
      CASE WHEN line.vendor = 'Starlink' THEN 'starlink' ELSE 'other' END AS hardware,
      count(*)::int AS units
    FROM public.kit_case_events AS event
    JOIN public.kit_cases AS cases ON cases.id = event.case_id
    JOIN public.inventory_items AS item ON item.id = cases.inventory_item_id
    LEFT JOIN public.product_lines AS line ON line.id = item.product_id
    WHERE event.event_type = 'outcome_applied'
      AND (event.at AT TIME ZONE v_tz)::date BETWEEN p_from AND p_to
      AND event.payload->>'outcome' IN ('Resell', 'Rent out', 'Dispose', 'Return to vendor')
    GROUP BY 1, 2
  )
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'outcome', grid.name,
      'starlink', coalesce((SELECT counted.units FROM counted WHERE counted.outcome = grid.name AND counted.hardware = 'starlink'), 0),
      'other', coalesce((SELECT counted.units FROM counted WHERE counted.outcome = grid.name AND counted.hardware = 'other'), 0)
    )
    ORDER BY grid.ord
  ), '[]'::jsonb)
  INTO v_outcomes
  FROM (
    VALUES
      ('Resell', 1),
      ('Rent out', 2),
      ('Dispose', 3),
      ('Return to vendor', 4)
  ) AS grid(name, ord);

  WITH counted AS (
    SELECT event.payload->>'result' AS result, count(*)::int AS units
    FROM public.kit_case_events AS event
    WHERE event.event_type = 'inspection_recorded'
      AND (event.at AT TIME ZONE v_tz)::date BETWEEN p_from AND p_to
      AND event.payload->>'result' IN ('Pass', 'Fail')
    GROUP BY 1
  )
  SELECT jsonb_build_array(
    jsonb_build_object('result', 'Pass', 'units', coalesce((SELECT units FROM counted WHERE result = 'Pass'), 0)),
    jsonb_build_object('result', 'Fail', 'units', coalesce((SELECT units FROM counted WHERE result = 'Fail'), 0))
  )
  INTO v_results;

  WITH counted AS (
    SELECT event.payload->>'grade' AS grade, count(*)::int AS units
    FROM public.kit_case_events AS event
    WHERE event.event_type = 'inspection_recorded'
      AND (event.at AT TIME ZONE v_tz)::date BETWEEN p_from AND p_to
      AND event.payload->>'grade' IN ('A', 'B', 'C')
    GROUP BY 1
  )
  SELECT jsonb_build_array(
    jsonb_build_object('grade', 'A', 'units', coalesce((SELECT units FROM counted WHERE grade = 'A'), 0)),
    jsonb_build_object('grade', 'B', 'units', coalesce((SELECT units FROM counted WHERE grade = 'B'), 0)),
    jsonb_build_object('grade', 'C', 'units', coalesce((SELECT units FROM counted WHERE grade = 'C'), 0))
  )
  INTO v_grades;

  WITH cancellations AS (
    SELECT
      coalesce(chosen.address, 'No site') AS site
    FROM public.kit_cases AS cases
    JOIN public.transactions AS src ON src.id = cases.source_transaction_id
    LEFT JOIN public.clients AS client ON client.id = cases.client_id
    LEFT JOIN LATERAL (
      SELECT btrim(site_row.address) AS address
      FROM (
        SELECT btrim(entry->>'address') AS address, btrim(coalesce(entry->>'name', '')) AS name
        FROM jsonb_array_elements(coalesce(client.sites, '[]'::jsonb)) AS entry
        WHERE nullif(btrim(entry->>'address'), '') IS NOT NULL
        UNION ALL
        SELECT btrim(client.address), ''
        WHERE nullif(btrim(coalesce(client.address, '')), '') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(coalesce(client.sites, '[]'::jsonb)) AS entry
            WHERE nullif(btrim(entry->>'address'), '') IS NOT NULL
          )
      ) AS site_row
      WHERE (
        SELECT count(*)
        FROM (
          SELECT btrim(entry->>'address') AS address
          FROM jsonb_array_elements(coalesce(client.sites, '[]'::jsonb)) AS entry
          WHERE nullif(btrim(entry->>'address'), '') IS NOT NULL
          UNION ALL
          SELECT btrim(client.address)
          WHERE nullif(btrim(coalesce(client.address, '')), '') IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements(coalesce(client.sites, '[]'::jsonb)) AS entry
              WHERE nullif(btrim(entry->>'address'), '') IS NOT NULL
            )
        ) AS tally
      ) = 1
      OR lower(site_row.address) = lower(btrim(coalesce(src.previous_location, '')))
      OR (
        site_row.name <> ''
        AND lower(site_row.name) = lower(btrim(coalesce(src.previous_location, '')))
      )
      ORDER BY
        CASE
          WHEN lower(site_row.address) = lower(btrim(coalesce(src.previous_location, ''))) THEN 0
          WHEN site_row.name <> '' AND lower(site_row.name) = lower(btrim(coalesce(src.previous_location, ''))) THEN 0
          ELSE 1
        END,
        site_row.address
      LIMIT 1
    ) AS chosen ON true
    WHERE cases.reason_category = 'Client cancelled'
      AND (cases.opened_at AT TIME ZONE v_tz)::date BETWEEN p_from AND p_to
  )
  SELECT coalesce(jsonb_agg(
    jsonb_build_object('site', site, 'units', units)
    ORDER BY units DESC, site ASC
  ), '[]'::jsonb)
  INTO v_sites
  FROM (
    SELECT site, count(*)::int AS units
    FROM cancellations
    GROUP BY site
  ) AS grouped;

  RETURN jsonb_build_object(
    'from', to_char(p_from, 'YYYY-MM-DD'),
    'to', to_char(p_to, 'YYYY-MM-DD'),
    'now', jsonb_build_object(
      'waiting', v_waiting,
      'oldest_wait_days', v_oldest_days,
      'oldest_since', CASE
        WHEN v_oldest IS NULL THEN NULL
        ELSE to_char(v_oldest AT TIME ZONE v_tz, 'DD/MM/YYYY')
      END,
      'rental_out', v_rental
    ),
    'returns', v_returns,
    'outcomes', v_outcomes,
    'results', v_results,
    'grades', v_grades,
    'sites', v_sites
  );
END;
$$;

COMMENT ON FUNCTION public.returns_report(date, date) IS
  'Inspections returns report for a date range. Current waiting and rentals ignore the range. The screen and the CSV export both render this payload.';

REVOKE ALL ON FUNCTION public.returns_report(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.returns_report(date, date) TO authenticated, service_role;

COMMIT;
