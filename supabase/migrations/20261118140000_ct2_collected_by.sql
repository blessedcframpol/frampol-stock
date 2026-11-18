-- CT2: stock_issue_batches + collected-by on issue_units.
-- DROP + CREATE issue_units with DEFAULT args so 2-arg clients keep working.

SET lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- 1. stock_issue_batches
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stock_issue_batches (
  batch_id text PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES public.stock_requests (id) ON DELETE RESTRICT,
  collected_by_contact_id uuid REFERENCES public.client_contacts (id) ON DELETE SET NULL,
  collected_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT stock_issue_batches_contact_requires_name_chk
    CHECK (
      collected_by_contact_id IS NULL
      OR nullif(btrim(collected_by_name), '') IS NOT NULL
    ),
  CONSTRAINT stock_issue_batches_name_len_chk
    CHECK (
      collected_by_name IS NULL
      OR char_length(btrim(collected_by_name)) BETWEEN 1 AND 120
    )
);

COMMENT ON TABLE public.stock_issue_batches IS
  'CT2: one row per issue_units batch; optional collected-by contact + name snapshot.';

CREATE INDEX IF NOT EXISTS stock_issue_batches_request_id_idx
  ON public.stock_issue_batches (request_id);

ALTER TABLE public.stock_issue_batches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stock_issue_batches_select ON public.stock_issue_batches;
CREATE POLICY stock_issue_batches_select
  ON public.stock_issue_batches FOR SELECT TO authenticated
  USING (
    (SELECT public.get_my_role()) IN ('admin', 'accounts', 'viewer')
    OR EXISTS (
      SELECT 1
      FROM public.stock_requests AS request
      WHERE request.id = stock_issue_batches.request_id
        AND request.created_by = (SELECT auth.uid())
    )
  );

REVOKE ALL ON TABLE public.stock_issue_batches FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.stock_issue_batches TO authenticated;
GRANT ALL ON TABLE public.stock_issue_batches TO service_role;

DROP TRIGGER IF EXISTS tr_stock_issue_batches_audit ON public.stock_issue_batches;
CREATE TRIGGER tr_stock_issue_batches_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.stock_issue_batches
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_capture('batch_id');

-- -----------------------------------------------------------------------------
-- 2. issue_units (single overload with DEFAULT collected-by args)
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.issue_units(uuid, jsonb);
DROP FUNCTION IF EXISTS public.issue_units(uuid, jsonb, uuid, text, boolean);
DROP FUNCTION IF EXISTS public.issue_units(uuid, jsonb, uuid, text, boolean, text);

CREATE FUNCTION public.issue_units(
  p_request_id uuid,
  p_scans jsonb,
  p_collected_by_contact_id uuid DEFAULT NULL,
  p_collected_by_name text DEFAULT NULL,
  p_save_collector boolean DEFAULT false,
  p_collected_by_phone text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_role public.app_role := public.get_my_role();
  v_req public.stock_requests%ROWTYPE;
  v_collected_contact uuid;
  v_collected_name text;
  v_existing_contact uuid;
  v_save_phone text;
  v_phone_problem text;
  v_scan jsonb;
  v_serial text;
  v_line_hint text;
  v_scan_key text;
  v_item public.inventory_items%ROWTYPE;
  v_vendor text;
  v_product text;
  v_needs_key boolean;
  v_pool text;
  v_line_id uuid;
  v_line_product text;
  v_problem text;
  v_remaining jsonb;
  v_seen text[] := '{}';
  v_failures jsonb := '[]'::jsonb;
  v_serials jsonb := '[]'::jsonb;
  v_issued_labels text[] := '{}';
  v_upserts jsonb := '[]'::jsonb;
  v_txns jsonb := '[]'::jsonb;
  v_client_label text;
  v_today date;
  v_today_text text;
  v_date text;
  v_stamp text;
  v_batch text;
  v_n integer := 0;
  v_choice text;
  v_meta jsonb;
  v_outbound jsonb;
  v_item_status text;
  v_item_location text;
BEGIN
  IF v_uid IS NULL OR NOT coalesce(v_role IN ('admin', 'accounts'), false) THEN
    RAISE EXCEPTION 'Only admin or accounts can issue units'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_req FROM public.stock_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request was not found';
  END IF;
  IF v_req.review_state IS DISTINCT FROM 'submitted' THEN
    RAISE EXCEPTION '%', CASE v_req.review_state
      WHEN 'awaiting_approval' THEN 'This request is awaiting 00000 approval'
      WHEN 'rejected' THEN 'This request was rejected'
      WHEN 'cancelled' THEN 'This request is cancelled'
      WHEN 'closed' THEN 'This request is closed'
      ELSE 'This request cannot be issued'
    END USING ERRCODE = 'check_violation';
  END IF;

  -- CT2: validate collected-by inputs early (before scan work where possible)
  v_collected_name := nullif(btrim(coalesce(p_collected_by_name, '')), '');
  IF v_collected_name IS NOT NULL AND char_length(v_collected_name) > 120 THEN
    RAISE EXCEPTION 'Collected-by name must be 120 characters or fewer'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_collected_by_contact_id IS NOT NULL THEN
    v_collected_contact := public.stock_request_resolve_contact(p_collected_by_contact_id, v_req.client_id);
    SELECT nullif(btrim(cc.name), '') INTO v_collected_name
    FROM public.client_contacts AS cc
    WHERE cc.id = v_collected_contact;
    IF v_collected_name IS NULL THEN
      RAISE EXCEPTION 'Collected-by contact has no name'
        USING ERRCODE = 'check_violation';
    END IF;
    IF char_length(v_collected_name) > 120 THEN
      v_collected_name := left(v_collected_name, 120);
    END IF;
  ELSIF v_collected_name IS NOT NULL AND coalesce(p_save_collector, false) THEN
    IF NOT coalesce(v_role IN ('admin', 'sales', 'technicians'), false) THEN
      RAISE EXCEPTION 'You cannot save a new collector contact'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Reuse ignores phone; phone required only when creating a new collector.
    SELECT cc.id INTO v_existing_contact
    FROM public.client_contacts AS cc
    WHERE cc.client_id = v_req.client_id
      AND cc.active IS TRUE
      AND lower(btrim(cc.name)) = lower(v_collected_name)
    ORDER BY cc.is_primary DESC, cc.created_at ASC
    LIMIT 1;
    IF v_existing_contact IS NULL THEN
      IF nullif(btrim(coalesce(p_collected_by_phone, '')), '') IS NULL THEN
        RAISE EXCEPTION 'Add a phone number to save this collector as a contact, or untick Save'
          USING ERRCODE = 'check_violation';
      END IF;
      v_phone_problem := public.client_phone_problem(p_collected_by_phone);
      IF v_phone_problem IS NOT NULL THEN
        RAISE EXCEPTION '%', v_phone_problem
          USING ERRCODE = 'check_violation';
      END IF;
      v_save_phone := public.client_normalize_phone(p_collected_by_phone);
    END IF;
  END IF;

  IF p_scans IS NULL OR jsonb_typeof(p_scans) IS DISTINCT FROM 'array' OR jsonb_array_length(p_scans) = 0 THEN
    RAISE EXCEPTION 'Scan at least one serial'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT coalesce(jsonb_object_agg(
    line.id::text,
    line.quantity_requested
      - (SELECT count(*) FROM public.active_transactions AS t WHERE t.request_line_id = line.id)
  ), '{}'::jsonb)
  INTO v_remaining
  FROM public.stock_request_lines AS line
  WHERE line.request_id = p_request_id;

  SELECT coalesce(
    nullif(btrim(concat_ws(' - ', nullif(btrim(client.name), ''), nullif(btrim(client.company), ''))), ''),
    client.id
  )
  INTO v_client_label
  FROM public.clients AS client
  WHERE client.id = v_req.client_id;

  v_today := public.stock_request_today();
  v_today_text := to_char(v_today, 'YYYY-MM-DD');
  v_date := v_today_text || 'T00:00:00.000Z';
  v_stamp := ((extract(epoch FROM clock_timestamp()) * 1000)::bigint)::text;
  v_batch := 'BATCH-' || v_stamp || '-' || substr(md5(random()::text || p_request_id::text), 1, 7);
  v_choice := CASE v_req.invoice_status WHEN 'invoiced' THEN 'number' WHEN 'pending' THEN 'pending' ELSE 'not_invoiced' END;

  v_meta := jsonb_strip_nulls(jsonb_build_object(
    'request_id', v_req.id,
    'atlas_task_url', v_req.atlas_task_url
  ));
  IF v_req.type IN ('Sale', 'Rentals') THEN
    v_meta := v_meta || jsonb_build_object('invoice_choice', v_choice);
    IF v_choice = 'not_invoiced' THEN
      v_meta := v_meta || jsonb_build_object(
        'invoice_reason', v_req.not_invoiced_reason,
        'not_invoiced_kind', v_req.not_invoiced_kind
      );
    END IF;
  END IF;

  v_item_status := CASE v_req.type WHEN 'Sale' THEN 'Sold' WHEN 'POC Out' THEN 'POC' ELSE 'Rented' END;
  v_item_location := CASE v_req.type WHEN 'Sale' THEN 'Delivered' ELSE 'Client Site' END;

  FOR v_scan IN SELECT value FROM jsonb_array_elements(p_scans) LOOP
    v_problem := NULL;
    v_line_id := NULL;

    IF jsonb_typeof(v_scan) = 'string' THEN
      v_serial := btrim(v_scan #>> '{}');
      v_line_hint := NULL;
      v_scan_key := NULL;
    ELSIF jsonb_typeof(v_scan) = 'object' THEN
      v_serial := btrim(coalesce(v_scan->>'serial', v_scan->>'serial_number', ''));
      v_line_hint := nullif(btrim(coalesce(v_scan->>'line_id', '')), '');
      v_scan_key := nullif(btrim(coalesce(v_scan->>'cloud_key', '')), '');
    ELSE
      v_serial := '';
    END IF;

    IF v_serial = '' THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object('serial', '', 'reason', 'Serial is blank'));
      CONTINUE;
    END IF;
    IF v_serial = ANY (v_seen) THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object('serial', v_serial, 'reason', 'Scanned more than once'));
      CONTINUE;
    END IF;
    v_seen := v_seen || v_serial;

    SELECT * INTO v_item
    FROM public.inventory_items
    WHERE serial_number = v_serial AND deleted_at IS NULL
    ORDER BY id
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
      v_problem := 'Serial is not in inventory';
    ELSIF v_item.status IS DISTINCT FROM 'In Stock' THEN
      v_problem := format('Not in stock (status is %s)', v_item.status);
    END IF;

    IF v_problem IS NULL THEN
      SELECT line.vendor, line.product_name, line.requires_cloud_key
      INTO v_vendor, v_product, v_needs_key
      FROM public.product_lines AS line
      WHERE line.id = v_item.product_id;

      IF v_role = 'accounts' AND lower(btrim(coalesce(v_vendor, ''))) IS DISTINCT FROM 'fortinet' THEN
        v_problem := 'Accounts can only issue Fortinet units';
      END IF;
    END IF;

    IF v_problem IS NULL THEN
      IF v_line_hint IS NOT NULL THEN
        SELECT line.id, line.product_id INTO v_line_id, v_line_product
        FROM public.stock_request_lines AS line
        WHERE line.request_id = p_request_id AND line.id::text = v_line_hint;
        IF v_line_id IS NULL THEN
          v_problem := 'That line is not on this request';
        ELSIF v_line_product IS DISTINCT FROM v_item.product_id THEN
          v_problem := format('Serial is %s, not the product on this line', coalesce(v_product, 'another product'));
        ELSIF coalesce((v_remaining->>v_line_id::text)::int, 0) <= 0 THEN
          v_problem := 'This line is fully issued';
        END IF;
      ELSE
        SELECT line.id INTO v_line_id
        FROM public.stock_request_lines AS line
        WHERE line.request_id = p_request_id
          AND line.product_id = v_item.product_id
          AND coalesce((v_remaining->>line.id::text)::int, 0) > 0
        ORDER BY line.sort_order, line.id
        LIMIT 1;
        IF v_line_id IS NULL THEN
          IF EXISTS (
            SELECT 1 FROM public.stock_request_lines AS line
            WHERE line.request_id = p_request_id AND line.product_id = v_item.product_id
          ) THEN
            v_problem := format('All requested %s units are already issued', coalesce(v_product, 'product'));
          ELSE
            v_problem := format('%s is not on this request', coalesce(v_product, 'This product'));
          END IF;
        END IF;
      END IF;
    END IF;

    IF v_problem IS NULL THEN
      v_pool := coalesce(v_item.stock_pool, 'sale');
      IF v_req.type = 'Sale' AND v_pool IS DISTINCT FROM 'sale' THEN
        v_problem := format('Sale requires a sellable kit. Move it from %s to sale first', v_pool);
      ELSIF v_req.type = 'POC Out' AND v_pool NOT IN ('sale', 'demo') THEN
        v_problem := format('POC Out is not allowed from the %s group', v_pool);
      ELSIF v_req.type = 'Rentals' AND coalesce(v_vendor, '') IS DISTINCT FROM 'Starlink' THEN
        v_problem := 'Rentals is only for Starlink kits';
      ELSIF v_req.type = 'Rentals' AND v_pool NOT IN ('sale', 'rental') THEN
        v_problem := format('Rentals is not allowed from the %s group', v_pool);
      END IF;
    END IF;

    IF v_problem IS NULL
       AND coalesce(v_needs_key, false)
       AND nullif(btrim(coalesce(v_item.cloud_key, '')), '') IS NULL
       AND v_scan_key IS NULL THEN
      v_problem := 'Cloud key is required for this unit';
    END IF;

    IF v_problem IS NOT NULL THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object('serial', v_serial, 'reason', v_problem));
      CONTINUE;
    END IF;

    v_remaining := jsonb_set(
      v_remaining,
      ARRAY[v_line_id::text],
      to_jsonb((v_remaining->>v_line_id::text)::int - 1)
    );
    v_n := v_n + 1;
    v_serials := v_serials || to_jsonb(v_serial);
    v_issued_labels := v_issued_labels || (
      v_serial || CASE WHEN v_scan_key IS NOT NULL THEN ' (cloud key ' || v_scan_key || ')' ELSE '' END
    );

    v_upserts := v_upserts || jsonb_build_array(
      to_jsonb(v_item) || jsonb_build_object(
        'status', v_item_status,
        'location', v_item_location,
        'client', v_client_label,
        'assigned_to', v_client_label,
        'poc_out_date', CASE WHEN v_req.type = 'Sale' THEN v_item.poc_out_date ELSE v_today_text END,
        'return_date', CASE WHEN v_req.type = 'Sale' THEN v_item.return_date ELSE to_char(v_req.return_date, 'YYYY-MM-DD') END,
        'cloud_key', coalesce(v_scan_key, v_item.cloud_key),
        'assignment_history', coalesce(v_item.assignment_history, '[]'::jsonb)
      )
    );

    v_txns := v_txns || jsonb_build_array(jsonb_build_object(
      'id', 'TXN-' || v_stamp || '-' || v_n || '-' || substr(md5(random()::text || v_serial), 1, 7),
      'type', v_req.type,
      'serial_number', v_serial,
      'item_name', coalesce(v_product, v_serial),
      'client', v_client_label,
      'date', v_date,
      'client_id', v_req.client_id,
      'invoice_number', CASE
        WHEN v_req.type IN ('Sale', 'Rentals') AND v_req.invoice_status = 'invoiced' THEN v_req.invoice_number
        ELSE NULL
      END,
      'assigned_to', v_client_label,
      'batch_id', v_batch,
      'created_by', v_uid,
      'request_id', v_req.id,
      'request_line_id', v_line_id,
      'metadata', v_meta || jsonb_build_object('request_line_id', v_line_id)
    ));
  END LOOP;

  IF jsonb_array_length(v_failures) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'failures', v_failures, 'serials', '[]'::jsonb);
  END IF;

  IF v_req.type IN ('POC Out', 'Rentals') THEN
    v_outbound := jsonb_build_object(
      'id', v_batch,
      'type', v_req.type,
      'client', v_client_label,
      'client_id', v_req.client_id,
      'start_date', v_today_text,
      'end_date', CASE WHEN v_req.type = 'Rentals' THEN to_char(v_req.return_date, 'YYYY-MM-DD') ELSE NULL END,
      'status', 'open',
      'invoice_number', CASE WHEN v_req.invoice_status = 'invoiced' THEN v_req.invoice_number ELSE NULL END,
      'created_at', now()
    );
  END IF;


  -- CT2: resolve / save collector only after scans succeed (same txn — rolls back on later failure)
  IF v_collected_contact IS NULL AND v_collected_name IS NOT NULL AND coalesce(p_save_collector, false) THEN
    SELECT cc.id INTO v_existing_contact
    FROM public.client_contacts AS cc
    WHERE cc.client_id = v_req.client_id
      AND cc.active IS TRUE
      AND lower(btrim(cc.name)) = lower(v_collected_name)
    ORDER BY cc.is_primary DESC, cc.created_at ASC
    LIMIT 1;
    IF v_existing_contact IS NOT NULL THEN
      v_collected_contact := v_existing_contact;
      SELECT nullif(btrim(cc.name), '') INTO v_collected_name
      FROM public.client_contacts AS cc WHERE cc.id = v_collected_contact;
    ELSE
      -- Never copy clients.email/phone onto the person. Phone comes from p_collected_by_phone only.
      IF v_save_phone IS NULL THEN
        RAISE EXCEPTION 'Add a phone number to save this collector as a contact, or untick Save'
          USING ERRCODE = 'check_violation';
      END IF;
      INSERT INTO public.client_contacts (
        client_id, name, role, email, phone, is_primary, active, notes, created_by
      ) VALUES (
        v_req.client_id,
        v_collected_name,
        'collector',
        NULL,
        v_save_phone,
        false,
        true,
        'Created at issue',
        v_uid
      )
      RETURNING id INTO v_collected_contact;
    END IF;
  END IF;

  IF v_collected_contact IS NOT NULL AND v_collected_name IS NULL THEN
    SELECT nullif(btrim(cc.name), '') INTO v_collected_name
    FROM public.client_contacts AS cc WHERE cc.id = v_collected_contact;
  END IF;

  PERFORM set_config('app.request_issue', p_request_id::text, true);
  PERFORM public.apply_stock_movement(v_upserts, '[]'::jsonb, v_txns, v_outbound, NULL, NULL);
  PERFORM set_config('app.request_issue', '', true);

  IF v_req.type IN ('Sale', 'Rentals') THEN
    PERFORM public.sync_request_batch_invoices(p_request_id, NULL);
  END IF;

  INSERT INTO public.stock_issue_batches (
    batch_id, request_id, collected_by_contact_id, collected_by_name, created_by
  ) VALUES (
    v_batch, p_request_id, v_collected_contact, v_collected_name, v_uid
  );

  PERFORM public.log_stock_request_event(
    p_request_id,
    'units_issued',
    v_req.review_state,
    v_req.review_state,
    jsonb_strip_nulls(jsonb_build_object(
      'batch_id', v_batch,
      'serials', v_serials,
      'count', v_n,
      'outstanding_after', public.stock_request_outstanding_total(p_request_id),
      'collected_by_contact_id', v_collected_contact,
      'collected_by_name', v_collected_name
    )),
    v_uid
  );

  UPDATE public.stock_requests SET issue_lock_user_id = NULL, issue_lock_since = NULL WHERE id = p_request_id;
  PERFORM public.notify_stock_request(
    v_req.created_by,
    'request_units_issued',
    CASE
      WHEN public.stock_request_outstanding_total(p_request_id) = 0 THEN 'Request fulfilled'
      ELSE 'Request partially fulfilled'
    END,
    format(
      '%s: %s unit(s) issued (%s).%s',
      CASE
        WHEN public.stock_request_outstanding_total(p_request_id) = 0 THEN 'Fulfilled'
        ELSE 'Partially fulfilled'
      END,
      v_n,
      array_to_string(v_issued_labels, ', '),
      CASE
        WHEN public.stock_request_outstanding_total(p_request_id) > 0
          THEN format(' %s still outstanding.', public.stock_request_outstanding_total(p_request_id))
        ELSE ''
      END
    ),
    p_request_id
  );

  RETURN jsonb_build_object('ok', true, 'batch_id', v_batch, 'failures', '[]'::jsonb, 'serials', v_serials);
END;
$function$;

REVOKE ALL ON FUNCTION public.issue_units(uuid, jsonb, uuid, text, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_units(uuid, jsonb, uuid, text, boolean, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.issue_units(uuid, jsonb, uuid, text, boolean, text) IS
  'CT2: issue request units; optional collected-by contact/name/phone; p_save_collector creates/reuses collector (phone required to create).';
