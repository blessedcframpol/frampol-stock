-- Resolve overdue POC and Rented kits in one transaction.
-- Every row is validated before any movement is written. Each kit is its own batch because the dates differ.

BEGIN;

CREATE OR REPLACE FUNCTION public.bulk_resolve_holdings(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_row jsonb;
  v_plan jsonb;
  v_item public.inventory_items%ROWTYPE;
  v_seen text[] := ARRAY[]::text[];
  v_messages text[];
  v_errors jsonb := '[]'::jsonb;
  v_plans jsonb := '[]'::jsonb;
  v_batches jsonb := '[]'::jsonb;
  v_today date := (now() AT TIME ZONE 'Africa/Harare')::date;
  v_returned integer := 0;
  v_sold integer := 0;
  v_inspection integer := 0;
  v_awaiting integer := 0;
  v_serial text;
  v_action text;
  v_status text;
  v_day text;
  v_action_date date;
  v_dispatch text;
  v_last text;
  v_due text;
  v_location text;
  v_pool text;
  v_category text;
  v_reason text;
  v_choice text;
  v_number text;
  v_invoice_reason text;
  v_invoice_stored text;
  v_end text;
  v_product_name text;
  v_vendor text;
  v_client_id text;
  v_type text;
  v_txn_id text;
  v_batch_id text;
  v_upsert jsonb;
  v_txn jsonb;
  v_meta jsonb;
  v_problem text;
  v_skip boolean;
BEGIN
  IF auth.uid() IS NULL
     OR coalesce((SELECT public.get_my_role())::text, '') NOT IN ('admin', 'technicians') THEN
    RAISE EXCEPTION 'You do not have permission to record this movement'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errors', jsonb_build_array(jsonb_build_object(
        'serial', '',
        'messages', jsonb_build_array('Choose at least one kit')
      ))
    );
  END IF;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) AS value
  LOOP
    v_messages := ARRAY[]::text[];
    v_skip := false;
    v_serial := '';
    v_action := '';
    v_client_id := NULL;

    IF jsonb_typeof(v_row) IS DISTINCT FROM 'object' THEN
      v_messages := array_append(v_messages, 'This kit is not on the ledger');
    ELSE
      v_serial := btrim(coalesce(v_row->>'serial_number', ''));
      v_action := btrim(coalesce(v_row->>'action', ''));
    END IF;

    IF v_serial = ANY(v_seen) THEN
      v_messages := array_append(v_messages, 'This kit is already in this resolve');
      v_skip := true;
    ELSIF v_serial <> '' THEN
      v_seen := v_seen || v_serial;
    END IF;

    IF NOT v_skip AND cardinality(v_messages) = 0 THEN
      SELECT *
      INTO v_item
      FROM public.inventory_items AS item
      WHERE item.serial_number = v_serial
        AND item.deleted_at IS NULL
      ORDER BY item.id
      LIMIT 1
      FOR UPDATE;

      IF NOT FOUND THEN
        v_messages := array_append(v_messages, 'This kit is not on the ledger');
        v_skip := true;
      ELSE
        v_status := v_item.status;
        v_due := substring(coalesce(v_item.return_date, '') FROM 1 FOR 10);
        IF v_status NOT IN ('POC', 'Rented')
           OR v_due !~ '^\d{4}-\d{2}-\d{2}$'
           OR v_due::date >= v_today THEN
          v_messages := array_append(v_messages, 'Only overdue POC and Rented kits can be resolved here');
          v_skip := true;
        END IF;
      END IF;
    END IF;

    IF NOT v_skip THEN
      IF v_action NOT IN ('returned', 'sold', 'leave') THEN
        v_messages := array_append(v_messages, 'Choose Returned, Sold, or Leave');
      ELSIF v_action <> 'leave' THEN
        v_dispatch := NULL;
        IF v_status = 'Rented' THEN
          SELECT substring(txn.date FROM 1 FOR 10)
          INTO v_dispatch
          FROM public.active_transactions AS txn
          WHERE txn.serial_number = v_serial
            AND txn.type = 'Rentals'
            AND substring(txn.date FROM 1 FOR 10) ~ '^\d{4}-\d{2}-\d{2}$'
          ORDER BY txn.date DESC, txn.id DESC
          LIMIT 1;
        ELSE
          v_dispatch := substring(coalesce(v_item.poc_out_date, '') FROM 1 FOR 10);
          IF v_dispatch !~ '^\d{4}-\d{2}-\d{2}$' THEN
            SELECT substring(txn.date FROM 1 FOR 10)
            INTO v_dispatch
            FROM public.transactions AS txn
            WHERE txn.serial_number = v_serial
              AND txn.type = 'POC Out'
              AND substring(txn.date FROM 1 FOR 10) ~ '^\d{4}-\d{2}-\d{2}$'
            ORDER BY txn.date DESC, txn.id DESC
            LIMIT 1;
          END IF;
        END IF;

        SELECT max(substring(txn.date FROM 1 FOR 10))
        INTO v_last
        FROM public.transactions AS txn
        WHERE txn.serial_number = v_serial
          AND substring(txn.date FROM 1 FOR 10) ~ '^\d{4}-\d{2}-\d{2}$';

        v_day := btrim(coalesce(v_row->>'action_date', ''));
        v_action_date := NULL;
        BEGIN
          IF v_day ~ '^\d{4}-\d{2}-\d{2}$' THEN
            v_action_date := v_day::date;
          END IF;
        EXCEPTION
          WHEN invalid_datetime_format OR datetime_field_overflow THEN
            v_action_date := NULL;
        END;

        IF v_dispatch IS NULL OR v_dispatch !~ '^\d{4}-\d{2}-\d{2}$' THEN
          v_messages := array_append(v_messages, 'This kit has no dispatch date');
        END IF;
        IF v_action_date IS NULL
           OR v_action_date > v_today
           OR (v_dispatch ~ '^\d{4}-\d{2}-\d{2}$' AND v_action_date < v_dispatch::date) THEN
          v_messages := array_append(v_messages, CASE
            WHEN v_action = 'returned' THEN 'Date returned must be between the dispatch date and today'
            ELSE 'Sale date must be between the dispatch date and today'
          END);
        END IF;
        IF v_action_date IS NOT NULL
           AND v_last ~ '^\d{4}-\d{2}-\d{2}$'
           AND v_action_date < v_last::date THEN
          v_messages := array_append(v_messages, CASE
            WHEN v_action = 'returned' THEN 'Date returned cannot be before this kit''s last movement'
            ELSE 'Sale date cannot be before this kit''s last movement'
          END);
        END IF;

        IF v_action = 'returned' THEN
          v_location := btrim(coalesce(v_row->>'location', ''));
          IF v_location NOT IN ('Warehouse A', 'Warehouse B', 'Service Center') THEN
            v_messages := array_append(v_messages, 'Choose a warehouse');
          END IF;
          IF v_status = 'POC' THEN
            v_pool := btrim(coalesce(v_row->>'return_pool', ''));
            IF v_pool NOT IN ('sale', 'demo') THEN
              v_messages := array_append(v_messages, 'Choose Back in sellable stock or Demo unit, not for sale');
            END IF;
          ELSE
            v_category := btrim(coalesce(v_row->>'reason_category', ''));
            v_reason := btrim(coalesce(v_row->>'reason_text', ''));
            IF v_category NOT IN ('Client cancelled', 'Service termination') THEN
              v_messages := array_append(v_messages, 'Choose Client cancelled or Service termination');
            END IF;
            IF v_reason = '' THEN
              v_messages := array_append(v_messages, 'Enter a reason');
            END IF;
          END IF;
        ELSE
          v_choice := btrim(coalesce(v_row->>'invoice_choice', ''));
          v_number := btrim(coalesce(v_row->>'invoice_number', ''));
          v_invoice_reason := btrim(coalesce(v_row->>'invoice_reason', ''));
          IF v_choice = 'number' THEN
            v_problem := public.real_invoice_number_problem(v_number);
            IF v_problem IS NOT NULL THEN
              v_messages := array_append(v_messages, v_problem);
            END IF;
          ELSIF v_choice = 'pending' THEN
            IF v_number <> '' THEN
              v_messages := array_append(v_messages, 'Invoice pending does not take a number');
            END IF;
          ELSIF v_choice = 'not_invoiced' THEN
            IF char_length(v_invoice_reason) < 15 THEN
              v_messages := array_append(v_messages, '00000 needs a reason of at least 15 characters');
            END IF;
          ELSE
            v_messages := array_append(v_messages, 'Sale and Rentals need an invoice number, Invoice pending, or 00000 — not invoiced');
          END IF;

          IF v_status = 'Rented' THEN
            SELECT line.vendor
            INTO v_vendor
            FROM public.product_lines AS line
            WHERE line.id = v_item.product_id;
            IF coalesce(v_vendor, '') IS DISTINCT FROM 'Starlink' THEN
              v_messages := array_append(v_messages, 'Convert to sale is only for Starlink kits');
            END IF;
            v_end := nullif(btrim(coalesce(v_row->>'rental_end', '')), '');
            IF v_end IS NULL THEN
              v_end := v_day;
            END IF;
            IF v_dispatch IS NULL OR v_dispatch !~ '^\d{4}-\d{2}-\d{2}$' THEN
              v_messages := array_append(v_messages, 'Convert to sale needs the rental start');
            ELSE
              IF v_end !~ '^\d{4}-\d{2}-\d{2}$'
                 OR v_end::date < v_dispatch::date
                 OR v_end::date > v_today THEN
                v_messages := array_append(v_messages, 'Rental end date must be between the rental start and today');
              END IF;
              IF v_action_date IS NOT NULL
                 AND v_end ~ '^\d{4}-\d{2}-\d{2}$'
                 AND v_action_date < v_end::date THEN
                v_messages := array_append(v_messages, 'Sale date cannot be before the rental end date');
              END IF;
            END IF;
          END IF;
        END IF;
      END IF;
    END IF;

    IF cardinality(v_messages) > 0 THEN
      v_errors := v_errors || jsonb_build_array(jsonb_build_object(
        'serial', v_serial,
        'messages', to_jsonb(v_messages)
      ));
      CONTINUE;
    END IF;

    IF v_action = 'leave' OR v_skip THEN
      CONTINUE;
    END IF;

    SELECT line.product_name
    INTO v_product_name
    FROM public.product_lines AS line
    WHERE line.id = v_item.product_id;

    SELECT client.id
    INTO v_client_id
    FROM public.clients AS client
    WHERE btrim(coalesce(v_item.client, '')) <> ''
      AND (
        (client.name || ' - ' || client.company) = btrim(v_item.client)
        OR client.name = btrim(v_item.client)
      )
    ORDER BY CASE
      WHEN (client.name || ' - ' || client.company) = btrim(v_item.client) THEN 0
      ELSE 1
    END, client.id
    LIMIT 1;

    v_txn_id := 'TXN-' || replace(gen_random_uuid()::text, '-', '');
    v_batch_id := 'BATCH-' || replace(gen_random_uuid()::text, '-', '');
    v_upsert := to_jsonb(v_item) - 'stock_pool';
    v_meta := '{}'::jsonb;
    v_invoice_stored := NULL;

    IF v_action = 'returned' AND v_status = 'POC' THEN
      v_type := 'POC Return';
      v_upsert := jsonb_set(jsonb_set(v_upsert, '{status}', '"In Stock"'::jsonb), '{location}', to_jsonb(v_location));
      v_upsert := v_upsert - 'client' - 'assigned_to' - 'poc_out_date' - 'return_date';
    ELSIF v_action = 'returned' THEN
      v_type := 'Rental Return';
      v_upsert := jsonb_set(jsonb_set(v_upsert, '{status}', '"Pending Inspection"'::jsonb), '{location}', to_jsonb(v_location));
      v_meta := jsonb_build_object('reason_category', v_category, 'reason_text', v_reason);
    ELSE
      v_type := 'Sale';
      v_upsert := jsonb_set(v_upsert, '{status}', '"Sold"'::jsonb) - 'return_date';
      v_meta := jsonb_build_object('invoice_choice', v_choice);
      IF v_choice = 'not_invoiced' THEN
        v_meta := v_meta || jsonb_build_object('invoice_reason', v_invoice_reason);
        v_invoice_stored := '00000';
      ELSIF v_choice = 'number' THEN
        v_invoice_stored := v_number;
      END IF;
      IF v_status = 'POC' THEN
        v_meta := v_meta || jsonb_build_object('converted_from', 'POC');
        IF substring(coalesce(v_item.poc_out_date, '') FROM 1 FOR 10) ~ '^\d{4}-\d{2}-\d{2}$' THEN
          v_meta := v_meta || jsonb_build_object('poc_out_date', substring(v_item.poc_out_date FROM 1 FOR 10));
        END IF;
      ELSE
        v_meta := v_meta || jsonb_build_object('converted_from', 'Rentals', 'rental_end', v_end);
      END IF;
    END IF;

    v_txn := jsonb_strip_nulls(jsonb_build_object(
      'id', v_txn_id,
      'type', v_type,
      'serial_number', v_serial,
      'item_name', coalesce(v_product_name, v_serial),
      'client', v_item.client,
      'date', to_char(v_action_date, 'YYYY-MM-DD') || 'T00:00:00.000Z',
      'client_id', v_client_id,
      'invoice_number', v_invoice_stored,
      'batch_id', v_batch_id,
      'to_location', CASE WHEN v_action = 'returned' THEN v_location ELSE NULL END,
      'assigned_to', CASE
        WHEN v_action = 'sold' THEN coalesce(nullif(btrim(coalesce(v_item.assigned_to, '')), ''), v_item.client)
        ELSE NULL
      END,
      'metadata', CASE WHEN v_meta = '{}'::jsonb THEN NULL ELSE v_meta END,
      'created_by', auth.uid(),
      'return_pool', CASE WHEN v_type = 'POC Return' THEN v_pool ELSE NULL END
    ));

    v_plans := v_plans || jsonb_build_array(jsonb_build_object('upsert', v_upsert, 'txn', v_txn));
    v_batches := v_batches || jsonb_build_array(jsonb_build_object(
      'serial', v_serial,
      'batch_id', v_batch_id,
      'type', v_type
    ));
    IF v_action = 'returned' THEN
      v_returned := v_returned + 1;
      IF v_status = 'Rented' THEN
        v_inspection := v_inspection + 1;
      END IF;
    ELSE
      v_sold := v_sold + 1;
      IF v_choice = 'not_invoiced' THEN
        v_awaiting := v_awaiting + 1;
      END IF;
    END IF;
  END LOOP;

  IF jsonb_array_length(v_errors) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'errors', v_errors);
  END IF;

  FOR v_plan IN SELECT value FROM jsonb_array_elements(v_plans) AS value
  LOOP
    PERFORM public.apply_stock_movement(
      jsonb_build_array(v_plan -> 'upsert'),
      '[]'::jsonb,
      jsonb_build_array(v_plan -> 'txn')
    );
    -- apply_stock_movement keeps this temp table until commit. Drop it so the next kit can lock its own previous status.
    DROP TABLE IF EXISTS _movement_prev;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'returned', v_returned,
    'sold', v_sold,
    'inspection', v_inspection,
    'awaiting_approval', v_awaiting,
    'batches', v_batches
  );
END;
$$;

COMMENT ON FUNCTION public.bulk_resolve_holdings(jsonb) IS
  'Resolve overdue POC and Rented kits. Validates every row, then writes one apply_stock_movement batch per kit in a single transaction.';

REVOKE ALL ON FUNCTION public.bulk_resolve_holdings(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bulk_resolve_holdings(jsonb) TO authenticated, service_role;

COMMIT;
