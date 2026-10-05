-- Kit cases: decommission intake, inspection, and append-only events.
-- remediation_cases is left untouched for the later remediation phase.

BEGIN;

CREATE TABLE public.kit_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_type text NOT NULL CHECK (case_type IN ('decommission')),
  inventory_item_id text NOT NULL REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
  client_id text REFERENCES public.clients(id) ON DELETE SET NULL,
  source_transaction_id text NOT NULL UNIQUE REFERENCES public.transactions(id) ON DELETE RESTRICT,
  reason_category text NOT NULL CHECK (reason_category IN ('Client cancelled', 'Service termination', 'Not recorded')),
  reason_text text NOT NULL,
  stage text NOT NULL CHECK (stage IN ('open', 'closed')),
  outcome text CHECK (outcome IS NULL OR outcome IN ('Resell', 'Rent out', 'Dispose', 'Return to vendor')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  opened_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  closed_at timestamptz,
  closed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX kit_cases_one_open_per_item
  ON public.kit_cases (inventory_item_id)
  WHERE stage = 'open';

CREATE INDEX kit_cases_open_oldest
  ON public.kit_cases (opened_at)
  WHERE stage = 'open';

COMMENT ON TABLE public.kit_cases IS
  'One case per decommission or rental-return intake. Remediation cases stay in remediation_cases.';

CREATE TABLE public.kit_case_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.kit_cases(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN (
    'opened', 'inspection_recorded', 'outcome_applied', 'note', 'reopened', 're-closed'
  )),
  actor uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text
);

CREATE INDEX kit_case_events_case ON public.kit_case_events (case_id, at);

COMMENT ON TABLE public.kit_case_events IS
  'Append-only history of a kit case. Rows cannot be updated or deleted.';

CREATE OR REPLACE FUNCTION public.kit_case_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'kit_case_events rows cannot be changed';
END;
$$;

DROP TRIGGER IF EXISTS tr_kit_case_events_append_only ON public.kit_case_events;
CREATE TRIGGER tr_kit_case_events_append_only
  BEFORE UPDATE OR DELETE ON public.kit_case_events
  FOR EACH ROW
  EXECUTE FUNCTION public.kit_case_events_append_only();

ALTER TABLE public.kit_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kit_case_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kit_cases_select ON public.kit_cases;
CREATE POLICY kit_cases_select
  ON public.kit_cases FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS kit_cases_insert ON public.kit_cases;
CREATE POLICY kit_cases_insert
  ON public.kit_cases FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.get_my_role()) IN ('admin', 'technicians'));

DROP POLICY IF EXISTS kit_cases_update ON public.kit_cases;
CREATE POLICY kit_cases_update
  ON public.kit_cases FOR UPDATE TO authenticated
  USING ((SELECT public.get_my_role()) = 'admin')
  WITH CHECK ((SELECT public.get_my_role()) = 'admin');

DROP POLICY IF EXISTS kit_case_events_select ON public.kit_case_events;
CREATE POLICY kit_case_events_select
  ON public.kit_case_events FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS kit_case_events_insert ON public.kit_case_events;
CREATE POLICY kit_case_events_insert
  ON public.kit_case_events FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.get_my_role()) IN ('admin', 'technicians'));

REVOKE ALL ON TABLE public.kit_cases FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.kit_case_events FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.kit_cases TO authenticated;
GRANT SELECT, INSERT ON TABLE public.kit_case_events TO authenticated;

REVOKE ALL ON FUNCTION public.kit_case_events_append_only() FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.record_decommission_intake(p_transactions jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  rec record;
  v_item_id text;
  v_client_id text;
  v_case_id uuid;
BEGIN
  FOR rec IN
    SELECT
      t.id,
      t.type,
      t.serial_number,
      t.client_id,
      t.metadata,
      t.previous_status
    FROM jsonb_to_recordset(p_transactions) AS src(id text)
    JOIN public.transactions AS t ON t.id = src.id
  LOOP
    SELECT item.id
    INTO v_item_id
    FROM public.inventory_items AS item
    WHERE item.serial_number = rec.serial_number
      AND item.deleted_at IS NULL
    ORDER BY item.id
    LIMIT 1;

    IF v_item_id IS NULL THEN
      RAISE EXCEPTION 'Decommission intake is missing the kit (%)', rec.serial_number
        USING ERRCODE = 'check_violation';
    END IF;

    v_client_id := NULL;
    IF rec.previous_status IS NULL THEN
      v_client_id := NULLIF(btrim(COALESCE(rec.client_id, '')), '');
      IF v_client_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.clients AS client WHERE client.id = v_client_id) THEN
        RAISE EXCEPTION 'An unknown serial needs a client'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      SELECT client.id
      INTO v_client_id
      FROM public.clients AS client
      JOIN public.inventory_items AS item ON item.id = v_item_id
      WHERE (client.name || ' - ' || client.company) = btrim(item.client)
      LIMIT 1;
    END IF;

    INSERT INTO public.kit_cases (
      case_type, inventory_item_id, client_id, source_transaction_id,
      reason_category, reason_text, stage, opened_by
    ) VALUES (
      'decommission',
      v_item_id,
      v_client_id,
      rec.id,
      rec.metadata->>'reason_category',
      btrim(rec.metadata->>'reason_text'),
      'open',
      auth.uid()
    )
    RETURNING id INTO v_case_id;

    INSERT INTO public.kit_case_events (case_id, event_type, actor, payload)
    VALUES (
      v_case_id,
      'opened',
      auth.uid(),
      jsonb_build_object('movement_type', rec.type, 'source_transaction_id', rec.id)
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.reopen_inspection_cases(p_batch_id text, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.kit_case_events (case_id, event_type, actor, payload, reason)
  SELECT
    kc.id,
    'reopened',
    auth.uid(),
    jsonb_build_object(
      'batch_id', p_batch_id,
      'transaction_id', ev.payload->>'transaction_id',
      'outcome', ev.payload->>'outcome'
    ),
    p_reason
  FROM public.kit_cases AS kc
  JOIN public.kit_case_events AS ev
    ON ev.case_id = kc.id
   AND ev.event_type = 'outcome_applied'
  JOIN public.transactions AS src
    ON src.id = ev.payload->>'transaction_id'
   AND src.batch_id = p_batch_id
  WHERE kc.stage = 'closed'
    AND src.type IN ('Inspection Pass', 'Inspection Fail', 'Dispose');

  UPDATE public.kit_cases AS kc
  SET stage = 'open', outcome = NULL, closed_at = NULL, closed_by = NULL
  FROM public.kit_case_events AS ev
  JOIN public.transactions AS src
    ON src.id = ev.payload->>'transaction_id'
   AND src.batch_id = p_batch_id
  WHERE ev.case_id = kc.id
    AND ev.event_type = 'outcome_applied'
    AND kc.stage = 'closed'
    AND src.type IN ('Inspection Pass', 'Inspection Fail', 'Dispose');
END;
$$;

CREATE OR REPLACE FUNCTION public.reclose_inspection_cases(p_batch_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.kit_case_events (case_id, event_type, actor, payload)
  SELECT
    kc.id,
    're-closed',
    auth.uid(),
    jsonb_build_object('batch_id', p_batch_id, 'outcome', applied.payload->>'outcome')
  FROM public.kit_cases AS kc
  JOIN public.kit_case_events AS reopened
    ON reopened.case_id = kc.id
   AND reopened.event_type = 'reopened'
   AND reopened.payload->>'batch_id' = p_batch_id
  JOIN public.kit_case_events AS applied
    ON applied.case_id = kc.id
   AND applied.event_type = 'outcome_applied'
  WHERE kc.stage = 'open';

  UPDATE public.kit_cases AS kc
  SET
    stage = 'closed',
    outcome = applied.payload->>'outcome',
    closed_at = now(),
    closed_by = auth.uid()
  FROM public.kit_case_events AS reopened
  JOIN public.kit_case_events AS applied
    ON applied.case_id = reopened.case_id
   AND applied.event_type = 'outcome_applied'
  WHERE reopened.case_id = kc.id
    AND reopened.event_type = 'reopened'
    AND reopened.payload->>'batch_id' = p_batch_id
    AND kc.stage = 'open';
END;
$$;

REVOKE ALL ON FUNCTION public.record_decommission_intake(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reopen_inspection_cases(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reclose_inspection_cases(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_decommission_intake(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reopen_inspection_cases(text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reclose_inspection_cases(text) TO authenticated, service_role;

-- The UCG already has a Decommissioned transaction. Record the case and leave the kit row alone.
INSERT INTO public.kit_cases (
  case_type, inventory_item_id, client_id, source_transaction_id,
  reason_category, reason_text, stage, opened_at, opened_by
)
SELECT
  'decommission',
  item.id,
  txn.client_id,
  txn.id,
  'Not recorded',
  'Other',
  'open',
  txn.created_at,
  CASE
    WHEN EXISTS (SELECT 1 FROM auth.users AS usr WHERE usr.id = txn.created_by) THEN txn.created_by
    ELSE NULL
  END
FROM public.inventory_items AS item
JOIN public.transactions AS txn
  ON txn.serial_number = item.serial_number
 AND txn.type = 'Decommissioned'
WHERE item.serial_number = '0CEA14E98B2D'
  AND item.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.kit_cases AS existing WHERE existing.source_transaction_id = txn.id
  );

INSERT INTO public.kit_case_events (case_id, event_type, actor, at, payload, reason)
SELECT
  kc.id,
  'opened',
  kc.opened_by,
  kc.opened_at,
  jsonb_build_object('movement_type', 'Decommissioned', 'backfill', true),
  'Other'
FROM public.kit_cases AS kc
JOIN public.transactions AS txn ON txn.id = kc.source_transaction_id
WHERE txn.serial_number = '0CEA14E98B2D'
  AND txn.type = 'Decommissioned'
  AND NOT EXISTS (
    SELECT 1
    FROM public.kit_case_events AS ev
    WHERE ev.case_id = kc.id
      AND ev.event_type = 'opened'
  );

CREATE OR REPLACE FUNCTION public.apply_stock_movement(
  p_inventory_upserts jsonb,
  p_inventory_inserts jsonb,
  p_transactions jsonb,
  p_outbound_batch jsonb DEFAULT NULL,
  p_kit_inspection jsonb DEFAULT NULL,
  p_remediation_patch jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_type text;
  v_type_count integer;
  rec record;
  v_item_id text;
  v_status text;
  v_location text;
  v_client text;
  v_assigned text;
  v_poc text;
  v_return text;
  v_pool text;
  v_written text;
  v_expected text;
  v_exists boolean;
  v_inserted integer;
  v_insert_count integer;
BEGIN
  IF p_transactions IS NOT NULL
     AND jsonb_typeof(p_transactions) = 'array'
     AND jsonb_array_length(p_transactions) > 0 THEN
    IF EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_transactions) AS t(date text)
      WHERE CASE
        WHEN t.date ~ '^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$'
          THEN substring(t.date FROM 1 FOR 4)::int NOT BETWEEN 2020 AND 2100
        ELSE true
      END
    ) THEN
      RAISE EXCEPTION 'Transaction date must be a business-date midnight (YYYY-MM-DDT00:00:00.000Z) between 2020 and 2100'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT count(DISTINCT t.type)::integer
    INTO v_type_count
    FROM jsonb_to_recordset(p_transactions) AS t(type text);

    IF v_type_count > 1 THEN
      RAISE EXCEPTION 'A stock movement has one type'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT t.type
    INTO v_type
    FROM jsonb_to_recordset(p_transactions) AS t(type text)
    LIMIT 1;

    IF v_type = 'POC Return' AND EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_transactions) AS t(return_pool text)
      WHERE t.return_pool IS NULL OR t.return_pool NOT IN ('sale', 'demo')
    ) THEN
      RAISE EXCEPTION 'POC Return must choose Back in sellable stock or Demo unit, not for sale'
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_type IN ('Decommissioned', 'Rental Return') AND EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_transactions) AS t(metadata jsonb)
      WHERE COALESCE(t.metadata->>'reason_category', '') NOT IN ('Client cancelled', 'Service termination')
         OR btrim(COALESCE(t.metadata->>'reason_text', '')) = ''
    ) THEN
      RAISE EXCEPTION 'Decommissioned and Rental Return need a reason category and a typed reason'
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_type = 'Decommissioned' AND EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_transactions) AS t(serial_number text, client_id text)
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.inventory_items AS item
        WHERE item.serial_number = t.serial_number
          AND item.deleted_at IS NULL
      )
      AND (
        NULLIF(btrim(COALESCE(t.client_id, '')), '') IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM public.clients AS client
          WHERE client.id = NULLIF(btrim(COALESCE(t.client_id, '')), '')
        )
      )
    ) THEN
      RAISE EXCEPTION 'An unknown serial needs a client'
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_type IN ('Inspection Pass', 'Inspection Fail')
       AND COALESCE(current_setting('app.inspection_case', true), '') = '' THEN
      RAISE EXCEPTION 'Record the inspection on the open case'
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_type = 'Dispose'
       AND COALESCE(current_setting('app.inspection_case', true), '') = ''
       AND EXISTS (
         SELECT 1
         FROM jsonb_to_recordset(p_transactions) AS t(serial_number text)
         JOIN public.inventory_items AS item
           ON item.serial_number = t.serial_number
          AND item.deleted_at IS NULL
         JOIN public.kit_cases AS kc
           ON kc.inventory_item_id = item.id
          AND kc.case_type = 'decommission'
          AND kc.stage = 'open'
       ) THEN
      RAISE EXCEPTION 'Dispose this kit from its inspection case'
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_type = 'Inspection Pass' AND EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_transactions) AS t(inspection_pool text)
      WHERE t.inspection_pool IS NOT NULL
        AND t.inspection_pool NOT IN ('sale', 'rental')
    ) THEN
      RAISE EXCEPTION 'Inspection Pass group must be sale or rental'
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_type = 'Inspection Pass' AND EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_transactions) AS t(serial_number text, inspection_pool text)
      WHERE t.inspection_pool = 'rental'
        AND NOT EXISTS (
          SELECT 1
          FROM public.inventory_items AS item
          JOIN public.product_lines AS line ON line.id = item.product_id
          WHERE item.serial_number = t.serial_number
            AND item.deleted_at IS NULL
            AND line.vendor = 'Starlink'
        )
    ) THEN
      RAISE EXCEPTION 'Rent out is only for Starlink kits'
        USING ERRCODE = 'check_violation';
    END IF;

    PERFORM set_config('app.movement_type', v_type, true);

    CREATE TEMP TABLE _movement_prev (
      serial text PRIMARY KEY,
      previous_status text,
      previous_location text,
      previous_client text,
      previous_assigned_to text,
      previous_poc_out_date text,
      previous_return_date text,
      previous_stock_pool text,
      is_create boolean NOT NULL
    ) ON COMMIT DROP;

    FOR rec IN
      SELECT t.type, t.serial_number
      FROM jsonb_to_recordset(p_transactions) AS t(type text, serial_number text)
    LOOP
      v_item_id := NULL;
      v_status := NULL;
      v_pool := NULL;
      SELECT item.id, item.status, item.location, item.client, item.assigned_to,
             item.poc_out_date, item.return_date, item.stock_pool
      INTO v_item_id, v_status, v_location, v_client, v_assigned, v_poc, v_return, v_pool
      FROM public.inventory_items AS item
      WHERE item.serial_number = rec.serial_number
        AND item.deleted_at IS NULL
      ORDER BY item.id
      LIMIT 1
      FOR UPDATE;

      v_exists := FOUND;

      IF NOT v_exists THEN
        IF rec.type IS DISTINCT FROM 'Inbound' AND rec.type IS DISTINCT FROM 'Decommissioned' THEN
          RAISE EXCEPTION 'Invalid movement: % requires an existing item (%)', rec.type, rec.serial_number
            USING ERRCODE = 'check_violation';
        END IF;
        INSERT INTO _movement_prev (
          serial, previous_status, previous_location, previous_client, previous_assigned_to,
          previous_poc_out_date, previous_return_date, previous_stock_pool, is_create
        )
        VALUES (rec.serial_number, NULL, NULL, NULL, NULL, NULL, NULL, NULL, true)
        ON CONFLICT (serial) DO NOTHING;
      ELSE
        IF rec.type = 'Sale' AND v_status = 'In Stock' AND v_pool IS DISTINCT FROM 'sale' THEN
          RAISE EXCEPTION 'Sale requires a sellable kit. Move % from % to sale first', rec.serial_number, v_pool
            USING ERRCODE = 'check_violation';
        END IF;
        IF rec.type = 'Rentals' AND v_pool NOT IN ('sale', 'rental') THEN
          RAISE EXCEPTION 'Rentals is not allowed from the % group (%)', v_pool, rec.serial_number
            USING ERRCODE = 'check_violation';
        END IF;
        IF rec.type = 'POC Out' AND v_pool NOT IN ('sale', 'demo') THEN
          RAISE EXCEPTION 'POC Out is not allowed from the % group (%)', v_pool, rec.serial_number
            USING ERRCODE = 'check_violation';
        END IF;
        v_expected := public.movement_result_status(v_status, rec.type);
        SELECT u.status
        INTO v_written
        FROM jsonb_to_recordset(COALESCE(p_inventory_upserts, '[]'::jsonb)) AS u(id text, serial_number text, status text)
        WHERE u.id = v_item_id OR u.serial_number = rec.serial_number
        LIMIT 1;

        IF v_written IS NULL THEN
          RAISE EXCEPTION 'Movement % is missing the inventory update for %', rec.type, rec.serial_number
            USING ERRCODE = 'check_violation';
        END IF;
        IF v_written IS DISTINCT FROM v_expected THEN
          RAISE EXCEPTION 'Invalid movement: % from % cannot set %', rec.type, v_status, v_written
            USING ERRCODE = 'check_violation';
        END IF;
        INSERT INTO _movement_prev (
          serial, previous_status, previous_location, previous_client, previous_assigned_to,
          previous_poc_out_date, previous_return_date, previous_stock_pool, is_create
        )
        VALUES (rec.serial_number, v_status, v_location, v_client, v_assigned, v_poc, v_return, v_pool, false)
        ON CONFLICT (serial) DO NOTHING;
      END IF;
    END LOOP;
  END IF;

  IF p_inventory_inserts IS NOT NULL
     AND jsonb_typeof(p_inventory_inserts) = 'array'
     AND jsonb_array_length(p_inventory_inserts) > 0 THEN
    IF v_type IS DISTINCT FROM 'Inbound' AND v_type IS DISTINCT FROM 'Decommissioned' THEN
      RAISE EXCEPTION 'New inventory rows are only created by Inbound or Decommissioned'
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_type = 'Inbound' AND EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_inventory_inserts) AS i(status text)
      WHERE i.status IS DISTINCT FROM 'In Stock'
    ) THEN
      RAISE EXCEPTION 'Inbound creates In Stock rows'
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_type = 'Decommissioned' AND EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_inventory_inserts) AS i(status text, poc_out_date text, return_date text)
      WHERE i.status IS DISTINCT FROM 'Pending Inspection'
         OR NULLIF(btrim(COALESCE(i.poc_out_date, '')), '') IS NOT NULL
         OR NULLIF(btrim(COALESCE(i.return_date, '')), '') IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'An unknown serial is Pending Inspection and records the return date only'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF p_outbound_batch IS NOT NULL AND jsonb_typeof(p_outbound_batch) = 'object' THEN
    INSERT INTO public.outbound_batches (
      id, type, client, client_id, start_date, end_date, status, invoice_number, created_at
    )
    SELECT
      b.id, b.type, b.client, b.client_id, b.start_date, b.end_date, b.status, b.invoice_number, b.created_at
    FROM jsonb_to_record(p_outbound_batch) AS b(
      id text, type text, client text, client_id text, start_date text, end_date text,
      status text, invoice_number text, created_at text
    );
  END IF;

  IF p_inventory_upserts IS NOT NULL
     AND jsonb_typeof(p_inventory_upserts) = 'array'
     AND jsonb_array_length(p_inventory_upserts) > 0 THEN
    INSERT INTO public.inventory_items (
      id, product_id, serial_number, status, date_added, location, client, notes, assigned_to,
      purchase_date, warranty_end_date, poc_out_date, return_date, assignment_history,
      reserved_for_request_line_id, cloud_key, deleted_at
    )
    SELECT
      i.id, i.product_id, i.serial_number, i.status, i.date_added, i.location, i.client, i.notes, i.assigned_to,
      i.purchase_date, i.warranty_end_date, i.poc_out_date, i.return_date, i.assignment_history,
      i.reserved_for_request_line_id, i.cloud_key, i.deleted_at
    FROM jsonb_to_recordset(p_inventory_upserts) AS i(
      id text, product_id text, serial_number text, status text, date_added text, location text,
      client text, notes text, assigned_to text, purchase_date text, warranty_end_date text,
      poc_out_date text, return_date text, assignment_history jsonb, reserved_for_request_line_id uuid,
      cloud_key text, deleted_at timestamptz
    )
    ON CONFLICT (id) DO UPDATE
    SET
      product_id = EXCLUDED.product_id,
      serial_number = EXCLUDED.serial_number,
      status = EXCLUDED.status,
      date_added = EXCLUDED.date_added,
      location = EXCLUDED.location,
      client = EXCLUDED.client,
      notes = EXCLUDED.notes,
      assigned_to = EXCLUDED.assigned_to,
      purchase_date = EXCLUDED.purchase_date,
      warranty_end_date = EXCLUDED.warranty_end_date,
      poc_out_date = EXCLUDED.poc_out_date,
      return_date = EXCLUDED.return_date,
      assignment_history = EXCLUDED.assignment_history,
      reserved_for_request_line_id = EXCLUDED.reserved_for_request_line_id,
      cloud_key = EXCLUDED.cloud_key,
      deleted_at = EXCLUDED.deleted_at;
  END IF;

  IF p_inventory_inserts IS NOT NULL
     AND jsonb_typeof(p_inventory_inserts) = 'array'
     AND jsonb_array_length(p_inventory_inserts) > 0 THEN
    v_insert_count := jsonb_array_length(p_inventory_inserts);
    INSERT INTO public.inventory_items (
      id, product_id, serial_number, status, date_added, location, client, notes, assigned_to,
      purchase_date, warranty_end_date, poc_out_date, return_date, assignment_history,
      reserved_for_request_line_id, cloud_key, deleted_at
    )
    SELECT
      i.id, i.product_id, i.serial_number, i.status, i.date_added, i.location, i.client, i.notes, i.assigned_to,
      i.purchase_date, i.warranty_end_date, i.poc_out_date, i.return_date, i.assignment_history,
      i.reserved_for_request_line_id, i.cloud_key, i.deleted_at
    FROM jsonb_to_recordset(p_inventory_inserts) AS i(
      id text, product_id text, serial_number text, status text, date_added text, location text,
      client text, notes text, assigned_to text, purchase_date text, warranty_end_date text,
      poc_out_date text, return_date text, assignment_history jsonb, reserved_for_request_line_id uuid,
      cloud_key text, deleted_at timestamptz
    )
    ON CONFLICT (serial_number) WHERE deleted_at IS NULL AND serial_number IS NOT NULL
    DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted IS DISTINCT FROM v_insert_count THEN
      RAISE EXCEPTION 'Inbound insert skipped (% of % rows). The serial is already in stock', v_inserted, v_insert_count
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;

  IF p_transactions IS NOT NULL
     AND jsonb_typeof(p_transactions) = 'array'
     AND jsonb_array_length(p_transactions) > 0 THEN
    IF EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_transactions) AS t(serial_number text)
      WHERE NOT EXISTS (
        SELECT 1 FROM _movement_prev AS prev WHERE prev.serial = t.serial_number
      )
    ) THEN
      RAISE EXCEPTION 'Movement is missing a locked previous status'
        USING ERRCODE = 'check_violation';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_transactions) AS t(serial_number text)
      WHERE NOT EXISTS (
        SELECT 1 FROM public.inventory_items AS item WHERE item.serial_number = t.serial_number
      )
    ) THEN
      RAISE EXCEPTION 'Movement is missing the inventory row it just wrote'
        USING ERRCODE = 'check_violation';
    END IF;

    UPDATE public.inventory_items AS item
    SET stock_pool = CASE v_type
      WHEN 'Rentals' THEN 'rental'
      WHEN 'Rental Return' THEN 'rental'
      WHEN 'POC Return' THEN chosen.return_pool
      WHEN 'Inspection Pass' THEN chosen.inspection_pool
      ELSE item.stock_pool
    END
    FROM jsonb_to_recordset(p_transactions) AS chosen(serial_number text, return_pool text, inspection_pool text)
    WHERE item.serial_number = chosen.serial_number
      AND item.deleted_at IS NULL
      AND (
        v_type IN ('Rentals', 'Rental Return', 'POC Return')
        OR (v_type = 'Inspection Pass' AND chosen.inspection_pool IN ('sale', 'rental'))
      );

    UPDATE public.inventory_items AS item
    SET
      client = prev.previous_client,
      assigned_to = prev.previous_assigned_to
    FROM _movement_prev AS prev
    WHERE item.serial_number = prev.serial
      AND item.deleted_at IS NULL
      AND NOT prev.is_create
      AND v_type IN ('Decommissioned', 'Rental Return');

    INSERT INTO public.transactions (
      id, type, serial_number, item_name, client, date, client_id, invoice_number, notes,
      from_location, to_location, assigned_to, disposal_reason, authorised_by, batch_id,
      delivery_note_url, metadata, created_by, previous_status, previous_status_source,
      previous_location, previous_client, previous_assigned_to, previous_poc_out_date, previous_return_date,
      previous_stock_pool,
      after_status, after_location, after_client, after_assigned_to, after_poc_out_date, after_return_date,
      after_stock_pool
    )
    SELECT
      t.id, t.type, t.serial_number, t.item_name, t.client, t.date, t.client_id, t.invoice_number, t.notes,
      t.from_location, t.to_location, t.assigned_to, t.disposal_reason, t.authorised_by, t.batch_id,
      t.delivery_note_url, t.metadata, t.created_by,
      CASE WHEN prev.is_create THEN NULL ELSE prev.previous_status END,
      'recorded',
      CASE WHEN prev.is_create THEN NULL ELSE prev.previous_location END,
      CASE WHEN prev.is_create THEN NULL ELSE prev.previous_client END,
      CASE WHEN prev.is_create THEN NULL ELSE prev.previous_assigned_to END,
      CASE WHEN prev.is_create THEN NULL ELSE prev.previous_poc_out_date END,
      CASE WHEN prev.is_create THEN NULL ELSE prev.previous_return_date END,
      CASE WHEN prev.is_create THEN NULL ELSE prev.previous_stock_pool END,
      after_row.status, after_row.location, after_row.client, after_row.assigned_to,
      after_row.poc_out_date, after_row.return_date, after_row.stock_pool
    FROM jsonb_to_recordset(p_transactions) AS t(
      id text, type text, serial_number text, item_name text, client text, date text, client_id text,
      invoice_number text, notes text, from_location text, to_location text, assigned_to text,
      disposal_reason text, authorised_by text, batch_id text, delivery_note_url text, metadata jsonb,
      created_by uuid
    )
    JOIN _movement_prev AS prev ON prev.serial = t.serial_number
    JOIN LATERAL (
      SELECT item.status, item.location, item.client, item.assigned_to, item.poc_out_date, item.return_date, item.stock_pool
      FROM public.inventory_items AS item
      WHERE item.serial_number = t.serial_number
      ORDER BY item.deleted_at NULLS FIRST, item.id
      LIMIT 1
    ) AS after_row ON true;

    IF v_type IN ('Decommissioned', 'Rental Return') THEN
      PERFORM public.record_decommission_intake(p_transactions);
    END IF;
  END IF;

  IF p_kit_inspection IS NOT NULL AND jsonb_typeof(p_kit_inspection) = 'object' THEN
    INSERT INTO public.kit_inspections (
      inventory_item_id, serial_number, inspector_name, outcome, condition_notes,
      attachment_urls, transaction_id, created_by
    )
    SELECT
      k.inventory_item_id, k.serial_number, k.inspector_name, k.outcome, k.condition_notes,
      COALESCE(k.attachment_urls, '{}'::text[]), k.transaction_id, k.created_by
    FROM jsonb_to_record(p_kit_inspection) AS k(
      inventory_item_id text, serial_number text, inspector_name text, outcome text,
      condition_notes text, attachment_urls text[], transaction_id text, created_by uuid
    );
  END IF;

  IF p_remediation_patch IS NOT NULL AND jsonb_typeof(p_remediation_patch) = 'object' THEN
    UPDATE public.remediation_cases rc
    SET
      loaner_inventory_item_id = r.loaner_inventory_item_id,
      loaner_serial = r.loaner_serial,
      updated_at = COALESCE(r.updated_at, now())
    FROM jsonb_to_record(p_remediation_patch) AS r(
      id uuid, loaner_inventory_item_id text, loaner_serial text, updated_at timestamptz
    )
    WHERE rc.id = r.id;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.apply_stock_movement(jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) IS
  'Writes one movement. previous_* comes from the locked row. after_* is read back after the write, including stock_pool. Sale from In Stock requires the sale pool. Rentals sets rental. POC Return requires a sale or demo choice. A non-midnight date is rejected before anything is written.';

CREATE OR REPLACE FUNCTION public.reverse_quick_scan_batch(
  p_batch_id text,
  p_reason text,
  p_return_location text DEFAULT NULL,
  p_confirmed jsonb DEFAULT '[]'::jsonb,
  p_entered jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_type text;
  v_type_count integer;
  v_tz text;
  v_date text;
  v_reversal_batch text;
  v_later_batch text;
  v_later_serial text;
  v_count integer;
  v_plan jsonb;
BEGIN
  IF (SELECT public.get_my_role()) IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: forbidden';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 15 THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: reason must be at least 15 characters';
  END IF;
  IF p_batch_id IS NULL OR btrim(p_batch_id) = '' THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: batch_id is required';
  END IF;
  IF public.batch_is_currently_reversed(p_batch_id) THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: batch % is already reversed', p_batch_id;
  END IF;

  SELECT count(*)::integer, count(DISTINCT type)::integer, min(type)
  INTO v_count, v_type_count, v_type
  FROM public.transactions
  WHERE batch_id = p_batch_id
    AND type IS DISTINCT FROM 'Reversal';

  IF v_count = 0 THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: no transactions found for %', p_batch_id;
  END IF;
  IF v_type_count <> 1 THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: batch % mixes movement types', p_batch_id;
  END IF;
  IF v_type = 'Reversal' THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: a Reversal cannot be reversed';
  END IF;

  SELECT later.batch_id, orig.serial_number
  INTO v_later_batch, v_later_serial
  FROM public.transactions AS orig
  JOIN public.transactions AS later
    ON later.serial_number = orig.serial_number
   AND later.id <> orig.id
   AND later.type IS DISTINCT FROM 'Reversal'
   AND later.batch_id IS DISTINCT FROM orig.batch_id
   AND NOT public.batch_is_currently_reversed(later.batch_id)
   AND (
     public.transaction_record_time(later.id, later.created_at, later.date)
       > public.transaction_record_time(orig.id, orig.created_at, orig.date)
     OR (
       public.transaction_record_time(later.id, later.created_at, later.date)
         = public.transaction_record_time(orig.id, orig.created_at, orig.date)
       AND later.id > orig.id
     )
   )
  WHERE orig.batch_id = p_batch_id
    AND orig.type IS DISTINCT FROM 'Reversal'
  ORDER BY later.batch_id
  LIMIT 1;

  IF v_later_batch IS NOT NULL THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: % is blocked by later batch %', v_later_serial, v_later_batch;
  END IF;

  v_plan := public.reverse_restore_plan(p_batch_id);

  DROP TABLE IF EXISTS _rev_final;
  CREATE TEMP TABLE _rev_final ON COMMIT DROP AS
  SELECT
    plan."transactionId" AS transaction_id,
    plan.serial,
    plan."softDelete" AS soft_delete,
    plan.needs,
    CASE
      WHEN plan."softDelete" THEN NULL
      WHEN plan.needs @> '["status"]'::jsonb THEN NULLIF(btrim(confirmed.status), '')
      ELSE plan.status
    END AS restore_status,
    plan.client AS restore_client,
    plan."assignedTo" AS restore_assigned,
    CASE
      WHEN plan.needs @> '["location"]'::jsonb THEN COALESCE(
        NULLIF(btrim(entered.location), ''),
        NULLIF(btrim(p_return_location), '')
      )
      ELSE plan.location
    END AS restore_location,
    plan."pocOutDate" AS restore_poc,
    CASE
      WHEN plan.needs @> '["return_date"]'::jsonb THEN NULLIF(btrim(entered.return_date), '')
      ELSE plan."returnDate"
    END AS restore_return,
    item.status AS locked_status,
    item.location AS locked_location,
    item.client AS locked_client,
    item.assigned_to AS locked_assigned,
    item.poc_out_date AS locked_poc,
    item.return_date AS locked_return,
    item.stock_pool AS locked_pool,
    (
      SELECT src.previous_stock_pool
      FROM public.transactions AS src
      WHERE src.id = plan."transactionId"
    ) AS restore_pool
  FROM jsonb_to_recordset(COALESCE(v_plan -> 'rows', '[]'::jsonb)) AS plan(
    "transactionId" text,
    serial text,
    "softDelete" boolean,
    status text,
    client text,
    "assignedTo" text,
    location text,
    "pocOutDate" text,
    "returnDate" text,
    needs jsonb
  )
  JOIN public.inventory_items AS item
    ON item.serial_number = plan.serial
   AND item.deleted_at IS NULL
  LEFT JOIN jsonb_to_recordset(COALESCE(p_confirmed, '[]'::jsonb)) AS confirmed(transaction_id text, status text)
    ON confirmed.transaction_id = plan."transactionId"
  LEFT JOIN jsonb_to_recordset(COALESCE(p_entered, '[]'::jsonb)) AS entered(
    transaction_id text,
    location text,
    return_date text
  ) ON entered.transaction_id = plan."transactionId";

  IF (SELECT count(*) FROM _rev_final) IS DISTINCT FROM jsonb_array_length(COALESCE(v_plan -> 'rows', '[]'::jsonb)) THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: an inventory row is missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM _rev_final
    WHERE needs @> '["status"]'::jsonb
      AND restore_status IS NULL
  ) THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: an unknown previous status must be confirmed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM _rev_final AS final
    JOIN public.inventory_items AS item
      ON item.serial_number = final.serial
     AND item.deleted_at IS NULL
    WHERE final.restore_status IS NOT NULL
      AND NOT public.reversal_pair_allowed(item.status, v_type, final.restore_status)
  ) THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: confirmed status is not a legal predecessor of %', v_type;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM _rev_final
    WHERE needs @> '["location"]'::jsonb
      AND (
        restore_location IS NULL
        OR restore_location NOT IN ('Warehouse A', 'Warehouse B', 'Service Center')
      )
  ) THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: location must be entered at reversal';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM _rev_final
    WHERE needs @> '["return_date"]'::jsonb
      AND (restore_return IS NULL OR restore_return !~ '^\d{4}-\d{2}-\d{2}$')
  ) THEN
    RAISE EXCEPTION 'reverse_quick_scan_batch: return date must be entered at reversal';
  END IF;

  PERFORM item.id
  FROM public.inventory_items AS item
  JOIN _rev_final AS final ON final.serial = item.serial_number AND item.deleted_at IS NULL
  FOR UPDATE OF item;

  PERFORM set_config('app.movement_type', 'Reversal', true);
  PERFORM set_config('app.reversal_original_type', v_type, true);

  UPDATE public.inventory_items AS item
  SET
    status = final.restore_status,
    location = final.restore_location,
    client = final.restore_client,
    assigned_to = final.restore_assigned,
    poc_out_date = final.restore_poc,
    return_date = final.restore_return,
    stock_pool = COALESCE(final.restore_pool, item.stock_pool)
  FROM _rev_final AS final
  WHERE item.serial_number = final.serial
    AND item.deleted_at IS NULL
    AND final.restore_status IS NOT NULL;

  UPDATE public.inventory_items AS item
  SET deleted_at = now()
  FROM _rev_final AS final
  WHERE item.serial_number = final.serial
    AND item.deleted_at IS NULL
    AND final.restore_status IS NULL;

  v_tz := 'Africa/Harare';
  v_date := to_char((now() AT TIME ZONE v_tz)::date, 'YYYY-MM-DD') || 'T00:00:00.000Z';
  v_reversal_batch := 'BATCH-REV-' || ((extract(epoch FROM clock_timestamp()) * 1000)::bigint)::text;

  INSERT INTO public.transactions (
    id, type, serial_number, item_name, client, date, client_id, invoice_number, notes,
    from_location, to_location, batch_id, metadata, created_by,
    previous_status, previous_status_source, previous_location, previous_client,
    previous_assigned_to, previous_poc_out_date, previous_return_date, previous_stock_pool,
    after_status, after_location, after_client, after_assigned_to, after_poc_out_date, after_return_date,
    after_stock_pool,
    reverses_transaction_id
  )
  SELECT
    'TXN-REV-' || ((extract(epoch FROM clock_timestamp()) * 1000)::bigint)::text || '-' || row_number() OVER (ORDER BY src.id),
    'Reversal',
    src.serial_number,
    src.item_name,
    COALESCE(src.client, 'Internal'),
    v_date,
    src.client_id,
    src.invoice_number,
    btrim(p_reason),
    src.from_location,
    src.to_location,
    v_reversal_batch,
    jsonb_build_object(
      'reversedBatchId', p_batch_id,
      'originalMovementType', src.type,
      'restoreStatus', final.restore_status,
      'serialNumbers', jsonb_build_array(src.serial_number),
      'itemCount', 1,
      'returnLocation', final.restore_location
    ) || CASE
      WHEN jsonb_strip_nulls(jsonb_build_object(
        'location', CASE WHEN final.needs @> '["location"]'::jsonb THEN final.restore_location END,
        'return_date', CASE WHEN final.needs @> '["return_date"]'::jsonb THEN final.restore_return END
      )) = '{}'::jsonb THEN '{}'::jsonb
      ELSE jsonb_build_object(
        'entered at reversal',
        jsonb_strip_nulls(jsonb_build_object(
          'location', CASE WHEN final.needs @> '["location"]'::jsonb THEN final.restore_location END,
          'return_date', CASE WHEN final.needs @> '["return_date"]'::jsonb THEN final.restore_return END
        ))
      )
    END,
    auth.uid(),
    final.locked_status,
    'recorded',
    final.locked_location,
    final.locked_client,
    final.locked_assigned,
    final.locked_poc,
    final.locked_return,
    final.locked_pool,
    final.restore_status,
    final.restore_location,
    final.restore_client,
    final.restore_assigned,
    final.restore_poc,
  final.restore_return,
    CASE WHEN final.restore_status IS NULL THEN NULL ELSE COALESCE(final.restore_pool, final.locked_pool) END,
    src.id
  FROM public.transactions AS src
  JOIN _rev_final AS final ON final.serial = src.serial_number
  WHERE src.batch_id = p_batch_id
    AND src.type IS DISTINCT FROM 'Reversal';

  INSERT INTO public.batch_reversals (batch_id, reversed_at, reversal_reason, reversed_by, kind)
  VALUES (p_batch_id, now(), btrim(p_reason), (SELECT auth.uid())::text, 'reversal')
  ON CONFLICT (batch_id) DO UPDATE
  SET reversed_at = EXCLUDED.reversed_at,
      reversal_reason = EXCLUDED.reversal_reason,
      reversed_by = EXCLUDED.reversed_by,
      kind = EXCLUDED.kind;

  PERFORM public.reopen_inspection_cases(p_batch_id, btrim(p_reason));

  RETURN jsonb_build_object(
    'ok', true,
    'batch_id', p_batch_id,
    'reversal_batch_id', v_reversal_batch,
    'reversed_count', v_count
  );
END;
$$;

COMMENT ON FUNCTION public.reverse_quick_scan_batch(text, text, text, jsonb, jsonb) IS
  'Admin reversal. A recorded before-image is written back exactly. Legacy rows reconstruct only what is deterministic; other fields must be entered and are stored on the Reversal as entered at reversal.';

REVOKE ALL ON FUNCTION public.reverse_quick_scan_batch(text, text, text, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_quick_scan_batch(text, text, text, jsonb, jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.restore_batch(p_batch_id text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_kind text;
  v_type text;
  v_later_batch text;
  v_later_serial text;
  v_plan jsonb;
  v_count integer;
BEGIN
  IF (SELECT public.get_my_role()) IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'restore_batch: forbidden';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 15 THEN
    RAISE EXCEPTION 'restore_batch: reason must be at least 15 characters';
  END IF;
  IF NOT public.batch_is_currently_reversed(p_batch_id) THEN
    RAISE EXCEPTION 'restore_batch: batch % is not reversed', p_batch_id;
  END IF;

  SELECT kind INTO v_kind FROM public.batch_reversals WHERE batch_id = p_batch_id;

  SELECT later.batch_id, orig.serial_number
  INTO v_later_batch, v_later_serial
  FROM public.transactions AS orig
  JOIN public.transactions AS later
    ON later.serial_number = orig.serial_number
   AND later.id <> orig.id
   AND later.batch_id IS DISTINCT FROM orig.batch_id
   AND later.type IS DISTINCT FROM 'Reversal'
   AND NOT public.batch_is_currently_reversed(later.batch_id)
   AND NOT (
     later.type = 'Reversal'
     AND later.reverses_transaction_id = orig.id
   )
   AND (
     public.transaction_record_time(later.id, later.created_at, later.date)
       > public.transaction_record_time(orig.id, orig.created_at, orig.date)
     OR (
       public.transaction_record_time(later.id, later.created_at, later.date)
         = public.transaction_record_time(orig.id, orig.created_at, orig.date)
       AND later.id > orig.id
     )
   )
  WHERE orig.batch_id = p_batch_id
    AND orig.type IS DISTINCT FROM 'Reversal'
  ORDER BY later.batch_id
  LIMIT 1;

  IF v_later_batch IS NOT NULL THEN
    RAISE EXCEPTION 'restore_batch: % is blocked by later batch %', v_later_serial, v_later_batch;
  END IF;

  IF v_kind IS DISTINCT FROM 'void' THEN
    SELECT min(type) INTO v_type
    FROM public.transactions
    WHERE batch_id = p_batch_id
      AND type IS DISTINCT FROM 'Reversal';

    v_plan := public.restore_batch_plan(p_batch_id);

    DROP TABLE IF EXISTS _restore_final;
    CREATE TEMP TABLE _restore_final ON COMMIT DROP AS
    SELECT *
    FROM jsonb_to_recordset(COALESCE(v_plan -> 'rows', '[]'::jsonb)) AS plan(
      "transactionId" text,
      serial text,
      exact boolean,
      status text,
      client text,
      "assignedTo" text,
      location text,
      "pocOutDate" text,
      "returnDate" text
    );

    IF EXISTS (
      SELECT 1
      FROM _restore_final AS plan
      WHERE NOT EXISTS (
        SELECT 1 FROM public.inventory_items AS item WHERE item.serial_number = plan.serial
      )
    ) THEN
      RAISE EXCEPTION 'restore_batch: an inventory row is missing';
    END IF;

    PERFORM item.id
    FROM public.inventory_items AS item
    JOIN _restore_final AS plan ON plan.serial = item.serial_number
    FOR UPDATE OF item;

    PERFORM set_config('app.movement_type', v_type, true);

    UPDATE public.inventory_items AS item
    SET
      status = plan.status,
      location = COALESCE(plan.location, item.location),
      client = plan.client,
      assigned_to = plan."assignedTo",
      poc_out_date = plan."pocOutDate",
      return_date = plan."returnDate",
      deleted_at = NULL,
      stock_pool = COALESCE(
        (SELECT src.after_stock_pool FROM public.transactions AS src WHERE src.id = plan."transactionId"),
        item.stock_pool
      )
    FROM _restore_final AS plan
    WHERE item.id = (
      SELECT candidate.id
      FROM public.inventory_items AS candidate
      WHERE candidate.serial_number = plan.serial
      ORDER BY candidate.deleted_at NULLS FIRST, candidate.id
      LIMIT 1
    );

    PERFORM public.reclose_inspection_cases(p_batch_id);
  END IF;

  INSERT INTO public.batch_restores (batch_id, restored_at, restore_reason, restored_by)
  VALUES (p_batch_id, now(), btrim(p_reason), (SELECT auth.uid())::text);

  SELECT count(*)::integer INTO v_count
  FROM public.transactions
  WHERE batch_id = p_batch_id
    AND type IS DISTINCT FROM 'Reversal';

  RETURN jsonb_build_object('ok', true, 'batch_id', p_batch_id, 'kind', v_kind, 'restored_count', v_count);
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_inspection(
  p_case_id uuid,
  p_result text,
  p_comments text,
  p_grade text,
  p_outcome text,
  p_location text DEFAULT NULL,
  p_reason_category text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_case public.kit_cases%ROWTYPE;
  v_item public.inventory_items%ROWTYPE;
  v_vendor text;
  v_product text;
  v_status text;
  v_move text;
  v_pool text;
  v_client text;
  v_assigned text;
  v_location text;
  v_poc text;
  v_return text;
  v_txn text;
  v_batch text;
  v_date text;
  v_upserts jsonb;
  v_txns jsonb;
BEGIN
  IF (SELECT public.get_my_role()) IS DISTINCT FROM 'admin' OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'complete_inspection: admin only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_result IS NULL OR p_result NOT IN ('Pass', 'Fail') THEN
    RAISE EXCEPTION 'complete_inspection: result must be Pass or Fail'
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(COALESCE(p_comments, '')) = '' THEN
    RAISE EXCEPTION 'complete_inspection: comments are required'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_grade IS NULL OR p_grade NOT IN ('A', 'B', 'C') THEN
    RAISE EXCEPTION 'complete_inspection: grade must be A, B, or C'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT *
  INTO v_case
  FROM public.kit_cases
  WHERE id = p_case_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'complete_inspection: case not found'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_case.case_type IS DISTINCT FROM 'decommission' OR v_case.stage IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'complete_inspection: the case is not open'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_reason_category IS NOT NULL THEN
    IF p_reason_category NOT IN ('Client cancelled', 'Service termination', 'Not recorded') THEN
      RAISE EXCEPTION 'complete_inspection: reason category is not recognised'
        USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public.kit_cases
    SET reason_category = p_reason_category
    WHERE id = p_case_id;
  END IF;

  SELECT *
  INTO v_item
  FROM public.inventory_items
  WHERE id = v_case.inventory_item_id
    AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND OR v_item.status IS DISTINCT FROM 'Pending Inspection' THEN
    RAISE EXCEPTION 'complete_inspection: the kit is not pending inspection'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT line.vendor, line.product_name
  INTO v_vendor, v_product
  FROM public.product_lines AS line
  WHERE line.id = v_item.product_id;

  IF p_result = 'Fail' AND p_outcome = 'Resell' THEN
    RAISE EXCEPTION 'complete_inspection: Resell is rejected after a Fail'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_result = 'Pass' AND COALESCE(v_vendor, '') = 'Starlink' THEN
    IF p_outcome NOT IN ('Resell', 'Rent out', 'Dispose') THEN
      RAISE EXCEPTION 'complete_inspection: a passed Starlink kit can be Resell, Rent out, or Dispose'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF p_result = 'Pass' THEN
    IF p_outcome = 'Rent out' THEN
      RAISE EXCEPTION 'complete_inspection: Rent out is only for Starlink kits'
        USING ERRCODE = 'check_violation';
    END IF;
    IF p_outcome NOT IN ('Resell', 'Dispose') THEN
      RAISE EXCEPTION 'complete_inspection: a passed kit can be Resell or Dispose'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF p_outcome NOT IN ('Return to vendor', 'Dispose') THEN
      RAISE EXCEPTION 'complete_inspection: a failed kit can be Return to vendor or Dispose'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  v_pool := NULL;
  v_client := v_item.client;
  v_assigned := v_item.assigned_to;
  v_location := v_item.location;
  v_poc := v_item.poc_out_date;
  v_return := v_item.return_date;

  IF p_outcome = 'Resell' THEN
    v_move := 'Inspection Pass';
    v_status := 'In Stock';
    v_pool := 'sale';
    v_client := NULL;
    v_assigned := NULL;
    v_poc := NULL;
    v_return := NULL;
  ELSIF p_outcome = 'Rent out' THEN
    v_move := 'Inspection Pass';
    v_status := 'In Stock';
    v_pool := 'rental';
    v_client := NULL;
    v_assigned := NULL;
    v_poc := NULL;
    v_return := NULL;
  ELSIF p_outcome = 'Dispose' THEN
    v_move := 'Dispose';
    v_status := 'Disposed';
  ELSE
    v_move := 'Inspection Fail';
    v_status := 'RMA Hold';
  END IF;

  IF p_outcome IN ('Resell', 'Rent out') THEN
    IF p_location IS NULL OR p_location NOT IN ('Warehouse A', 'Warehouse B', 'Service Center') THEN
      RAISE EXCEPTION 'complete_inspection: pick a warehouse'
        USING ERRCODE = 'check_violation';
    END IF;
    v_location := p_location;
  END IF;

  v_date := to_char((now() AT TIME ZONE 'Africa/Harare')::date, 'YYYY-MM-DD') || 'T00:00:00.000Z';
  v_txn := 'TXN-INSP-' || ((extract(epoch FROM clock_timestamp()) * 1000)::bigint)::text;
  v_batch := 'BATCH-INSP-' || ((extract(epoch FROM clock_timestamp()) * 1000)::bigint)::text;

  v_upserts := jsonb_build_array(jsonb_build_object(
    'id', v_item.id,
    'product_id', v_item.product_id,
    'serial_number', v_item.serial_number,
    'status', v_status,
    'date_added', v_item.date_added,
    'location', v_location,
    'client', v_client,
    'notes', v_item.notes,
    'assigned_to', v_assigned,
    'purchase_date', v_item.purchase_date,
    'warranty_end_date', v_item.warranty_end_date,
    'poc_out_date', v_poc,
    'return_date', v_return,
    'assignment_history', COALESCE(v_item.assignment_history, '[]'::jsonb),
    'reserved_for_request_line_id', v_item.reserved_for_request_line_id,
    'cloud_key', v_item.cloud_key,
    'deleted_at', v_item.deleted_at
  ));

  v_txns := jsonb_build_array(jsonb_build_object(
    'id', v_txn,
    'type', v_move,
    'serial_number', v_item.serial_number,
    'item_name', COALESCE(v_product, v_item.serial_number),
    'client', COALESCE(v_client, v_item.client, 'Internal'),
    'date', v_date,
    'client_id', v_case.client_id,
    'notes', btrim(p_comments),
    'to_location', v_location,
    'batch_id', v_batch,
    'created_by', auth.uid(),
    'inspection_pool', v_pool,
    'metadata', jsonb_build_object(
      'case_id', p_case_id,
      'result', p_result,
      'grade', p_grade,
      'outcome', p_outcome,
      'comments', btrim(p_comments)
    )
  ));

  PERFORM set_config('app.inspection_case', p_case_id::text, true);
  PERFORM public.apply_stock_movement(v_upserts, '[]'::jsonb, v_txns, NULL, NULL, NULL);

  INSERT INTO public.kit_case_events (case_id, event_type, actor, payload)
  VALUES (
    p_case_id,
    'inspection_recorded',
    auth.uid(),
    jsonb_build_object('result', p_result, 'comments', btrim(p_comments), 'grade', p_grade)
  );
  INSERT INTO public.kit_case_events (case_id, event_type, actor, payload)
  VALUES (
    p_case_id,
    'outcome_applied',
    auth.uid(),
    jsonb_build_object(
      'outcome', p_outcome,
      'transaction_id', v_txn,
      'batch_id', v_batch,
      'status', v_status,
      'stock_pool', COALESCE(v_pool, v_item.stock_pool)
    )
  );

  UPDATE public.kit_cases
  SET stage = 'closed', outcome = p_outcome, closed_at = now(), closed_by = auth.uid()
  WHERE id = p_case_id;

  RETURN p_case_id;
END;
$$;

COMMENT ON FUNCTION public.complete_inspection(uuid, text, text, text, text, text, text) IS
  'Admin inspection. Writes the inspection event, the stock movement, and the case closure in one transaction.';

REVOKE ALL ON FUNCTION public.complete_inspection(uuid, text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_inspection(uuid, text, text, text, text, text, text) TO authenticated, service_role;

CREATE OR REPLACE VIEW public.kit_case_list
WITH (security_invoker = true) AS
SELECT
  kc.id,
  kc.case_type,
  kc.stage,
  kc.outcome,
  kc.reason_category,
  kc.reason_text,
  kc.opened_at,
  kc.closed_at,
  kc.opened_by,
  kc.closed_by,
  kc.client_id,
  kc.inventory_item_id,
  item.serial_number,
  item.status AS kit_status,
  item.stock_pool,
  item.location,
  item.client AS holder,
  item.product_id,
  line.product_name,
  line.vendor,
  src.type AS source_type,
  CASE src.type
    WHEN 'Rental Return' THEN 'Rental return'
    WHEN 'Decommissioned' THEN 'Decommissioned'
    ELSE src.type
  END AS source_label,
  client.name AS client_name,
  client.company AS client_company,
  insp.payload->>'grade' AS grade,
  insp.payload->>'result' AS result,
  insp.payload->>'comments' AS comments,
  COALESCE(NULLIF(btrim(closer.display_name), ''), closer.email) AS closed_by_name
FROM public.kit_cases AS kc
JOIN public.inventory_items AS item ON item.id = kc.inventory_item_id
LEFT JOIN public.product_lines AS line ON line.id = item.product_id
JOIN public.transactions AS src ON src.id = kc.source_transaction_id
LEFT JOIN public.clients AS client ON client.id = kc.client_id
LEFT JOIN public.profiles AS closer ON closer.id = kc.closed_by
LEFT JOIN LATERAL (
  SELECT ev.payload
  FROM public.kit_case_events AS ev
  WHERE ev.case_id = kc.id
    AND ev.event_type = 'inspection_recorded'
  ORDER BY ev.at DESC
  LIMIT 1
) AS insp ON true;

COMMENT ON VIEW public.kit_case_list IS
  'Open and closed decommission cases for the Inspections section.';

REVOKE ALL ON TABLE public.kit_case_list FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.kit_case_list TO authenticated;

COMMIT;
