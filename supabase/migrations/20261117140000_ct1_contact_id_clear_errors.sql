-- CT1 fix: clearer submit/resubmit errors when contact_id is wrong client or archived.
SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.stock_request_resolve_contact(
  p_contact_id uuid,
  p_client_id text
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_row public.client_contacts%ROWTYPE;
BEGIN
  IF p_contact_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_row FROM public.client_contacts WHERE id = p_contact_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contact was not found'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_row.client_id IS DISTINCT FROM p_client_id THEN
    RAISE EXCEPTION 'Contact does not belong to this client'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_row.active IS NOT TRUE THEN
    RAISE EXCEPTION 'Contact is archived'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN p_contact_id;
END;
$$;

REVOKE ALL ON FUNCTION public.stock_request_resolve_contact(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_request_resolve_contact(uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.submit_request(p_payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role public.app_role := public.get_my_role();
  v_client text;
  v_contact uuid;
  v_type text;
  v_return date;
  v_atlas text;
  v_atlas_id uuid;
  v_choice text;
  v_number text;
  v_reason text;
  v_kind text;
  v_lines jsonb;
  v_problem text;
  v_state text;
  v_id uuid;
  v_link_required boolean := public.app_settings_atlas_link_required();
  v_pending boolean;
BEGIN
  IF v_uid IS NULL OR NOT coalesce(v_role IN ('admin', 'sales', 'technicians'), false) THEN
    RAISE EXCEPTION 'You cannot submit stock requests'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Request details are missing'
      USING ERRCODE = 'check_violation';
  END IF;

  v_type := nullif(btrim(coalesce(p_payload->>'type', '')), '');
  v_return := public.stock_request_parse_date(p_payload->>'return_date');
  v_atlas := nullif(btrim(coalesce(p_payload->>'atlas_task_url', '')), '');
  v_atlas_id := CASE WHEN v_atlas IS NOT NULL THEN public.atlas_task_id_from_url(v_atlas) END;
  v_choice := nullif(btrim(coalesce(p_payload->>'invoice_choice', '')), '');
  v_number := btrim(coalesce(p_payload->>'invoice_number', ''));
  v_reason := btrim(coalesce(p_payload->>'not_invoiced_reason', ''));
  v_kind := nullif(btrim(coalesce(p_payload->>'not_invoiced_kind', '')), '');
  v_lines := p_payload->'lines';
  v_client := public.stock_request_resolve_client(p_payload->>'client_id', v_choice, v_kind);
  v_pending := v_atlas IS NULL AND NOT v_link_required;

  v_contact := public.stock_request_resolve_contact(
    nullif(btrim(coalesce(p_payload->>'contact_id', '')), '')::uuid,
    v_client
  );

  v_problem := public.stock_request_fields_problem(v_client, v_type, v_return, v_atlas, v_choice, v_number, v_reason, v_kind);
  IF v_problem IS NULL THEN
    v_problem := public.stock_request_lines_problem(v_type, v_lines);
  END IF;
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION '%', v_problem USING ERRCODE = 'check_violation';
  END IF;

  v_state := CASE WHEN v_choice = 'not_invoiced' THEN 'awaiting_approval' ELSE 'submitted' END;

  INSERT INTO public.stock_requests (
    client_id, contact_id, created_by, review_state, type, return_date, atlas_task_url, atlas_task_id, atlas_link_pending,
    quotation_url, notes,
    invoice_status, invoice_number, not_invoiced_reason, not_invoiced_kind, invoice_approval,
    invoice_entered_by, invoice_entered_at, submitted_at
  ) VALUES (
    v_client,
    v_contact,
    v_uid,
    v_state,
    v_type,
    v_return,
    v_atlas,
    v_atlas_id,
    v_pending,
    nullif(btrim(coalesce(p_payload->>'quotation_url', '')), ''),
    nullif(btrim(coalesce(p_payload->>'notes', '')), ''),
    CASE v_choice WHEN 'number' THEN 'invoiced' WHEN 'pending' THEN 'pending' ELSE 'not_invoiced' END,
    CASE WHEN v_choice = 'number' THEN v_number ELSE NULL END,
    CASE WHEN v_choice = 'not_invoiced' THEN v_reason ELSE NULL END,
    CASE WHEN v_choice = 'not_invoiced' THEN v_kind ELSE NULL END,
    CASE WHEN v_choice = 'not_invoiced' THEN 'awaiting' ELSE NULL END,
    v_uid,
    now(),
    now()
  )
  RETURNING id INTO v_id;

  PERFORM public.stock_request_insert_lines(v_id, v_lines);

  PERFORM public.log_stock_request_event(
    v_id,
    'submitted',
    NULL,
    v_state,
    jsonb_build_object(
      'type', v_type,
      'client_id', v_client,
      'contact_id', v_contact,
      'invoice_choice', v_choice,
      'not_invoiced_kind', v_kind,
      'line_count', jsonb_array_length(v_lines),
      'atlas_link_pending', v_pending
    ),
    v_uid
  );

  IF v_state = 'awaiting_approval' THEN
    PERFORM public.notify_stock_request_admins(
      'request_awaiting_approval',
      '00000 request awaiting approval',
      format('A %s request was submitted as 00000 — not invoiced (%s).', v_type, v_kind),
      v_id
    );
  END IF;

  PERFORM public.notify_stock_request_issuers(
    v_id,
    'request_submitted',
    'New request to issue',
    format('A %s request was submitted and is ready to issue.', v_type)
  );

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_request(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_request(jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resubmit_request(p_request_id uuid, p_changes jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role public.app_role := public.get_my_role();
  v_req public.stock_requests%ROWTYPE;
  v_changes jsonb := coalesce(p_changes, '{}'::jsonb);
  v_client text;
  v_contact uuid;
  v_type text;
  v_return date;
  v_atlas text;
  v_atlas_id uuid;
  v_quote text;
  v_notes text;
  v_choice text;
  v_number text;
  v_reason text;
  v_kind text;
  v_lines jsonb;
  v_problem text;
  v_state text;
  v_link_required boolean := public.app_settings_atlas_link_required();
  v_pending boolean;
BEGIN
  IF v_uid IS NULL OR NOT coalesce(v_role IN ('admin', 'sales', 'technicians'), false) THEN
    RAISE EXCEPTION 'You cannot resubmit stock requests'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF jsonb_typeof(v_changes) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Changes must be an object'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_req FROM public.stock_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request was not found';
  END IF;
  IF v_req.created_by IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Only the requester can resubmit this request'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_req.review_state IS DISTINCT FROM 'rejected' THEN
    RAISE EXCEPTION 'Only a rejected request can be resubmitted';
  END IF;
  IF public.stock_request_issued_total(p_request_id) > 0 THEN
    RAISE EXCEPTION 'Units are already issued on this request';
  END IF;

  v_type := CASE WHEN v_changes ? 'type'
    THEN nullif(btrim(coalesce(v_changes->>'type', '')), '') ELSE v_req.type END;
  v_return := CASE WHEN v_changes ? 'return_date'
    THEN public.stock_request_parse_date(v_changes->>'return_date') ELSE v_req.return_date END;
  v_atlas := CASE WHEN v_changes ? 'atlas_task_url'
    THEN nullif(btrim(coalesce(v_changes->>'atlas_task_url', '')), '') ELSE v_req.atlas_task_url END;
  v_atlas_id := CASE WHEN v_atlas IS NOT NULL THEN public.atlas_task_id_from_url(v_atlas) END;
  v_quote := CASE WHEN v_changes ? 'quotation_url'
    THEN nullif(btrim(coalesce(v_changes->>'quotation_url', '')), '') ELSE v_req.quotation_url END;
  v_notes := CASE WHEN v_changes ? 'notes'
    THEN nullif(btrim(coalesce(v_changes->>'notes', '')), '') ELSE v_req.notes END;
  v_choice := CASE WHEN v_changes ? 'invoice_choice'
    THEN nullif(btrim(coalesce(v_changes->>'invoice_choice', '')), '')
    ELSE CASE v_req.invoice_status WHEN 'invoiced' THEN 'number' WHEN 'pending' THEN 'pending' ELSE 'not_invoiced' END
  END;
  v_number := CASE WHEN v_changes ? 'invoice_number'
    THEN btrim(coalesce(v_changes->>'invoice_number', '')) ELSE coalesce(v_req.invoice_number, '') END;
  v_reason := CASE WHEN v_changes ? 'not_invoiced_reason'
    THEN btrim(coalesce(v_changes->>'not_invoiced_reason', '')) ELSE coalesce(v_req.not_invoiced_reason, '') END;
  v_kind := CASE WHEN v_changes ? 'not_invoiced_kind'
    THEN nullif(btrim(coalesce(v_changes->>'not_invoiced_kind', '')), '') ELSE v_req.not_invoiced_kind END;
  v_client := public.stock_request_resolve_client(
    CASE WHEN v_changes ? 'client_id' THEN v_changes->>'client_id' ELSE v_req.client_id END,
    v_choice,
    v_kind
  );
  v_pending := v_atlas IS NULL AND NOT v_link_required;

  IF v_changes ? 'contact_id' THEN
    v_contact := public.stock_request_resolve_contact(
      nullif(btrim(coalesce(v_changes->>'contact_id', '')), '')::uuid,
      v_client
    );
  ELSE
    -- Keep existing contact when still valid for the (possibly new) client; otherwise clear.
    BEGIN
      v_contact := public.stock_request_resolve_contact(v_req.contact_id, v_client);
    EXCEPTION
      WHEN check_violation THEN
        v_contact := NULL;
    END;
  END IF;

  IF v_changes ? 'lines' THEN
    v_lines := v_changes->'lines';
  ELSE
    SELECT coalesce(
      jsonb_agg(jsonb_build_object('product_id', line.product_id, 'quantity', line.quantity_requested) ORDER BY line.sort_order, line.id),
      '[]'::jsonb
    )
    INTO v_lines
    FROM public.stock_request_lines AS line
    WHERE line.request_id = p_request_id;
  END IF;

  v_problem := public.stock_request_fields_problem(v_client, v_type, v_return, v_atlas, v_choice, v_number, v_reason, v_kind);
  IF v_problem IS NULL THEN
    v_problem := public.stock_request_lines_problem(v_type, v_lines);
  END IF;
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION '%', v_problem USING ERRCODE = 'check_violation';
  END IF;

  v_state := CASE WHEN v_choice = 'not_invoiced' THEN 'awaiting_approval' ELSE 'submitted' END;

  UPDATE public.stock_requests
  SET
    client_id = v_client,
    contact_id = v_contact,
    type = v_type,
    return_date = v_return,
    atlas_task_url = v_atlas,
    atlas_task_id = v_atlas_id,
    atlas_link_pending = v_pending,
    quotation_url = v_quote,
    notes = v_notes,
    invoice_status = CASE v_choice WHEN 'number' THEN 'invoiced' WHEN 'pending' THEN 'pending' ELSE 'not_invoiced' END,
    invoice_number = CASE WHEN v_choice = 'number' THEN v_number ELSE NULL END,
    not_invoiced_reason = CASE WHEN v_choice = 'not_invoiced' THEN v_reason ELSE NULL END,
    not_invoiced_kind = CASE WHEN v_choice = 'not_invoiced' THEN v_kind ELSE NULL END,
    invoice_approval = CASE WHEN v_choice = 'not_invoiced' THEN 'awaiting' ELSE NULL END,
    invoice_approved_by = NULL,
    invoice_approved_at = NULL,
    invoice_entered_by = v_uid,
    invoice_entered_at = now(),
    review_state = v_state,
    reject_reason_code = NULL,
    reject_note = NULL,
    rejected_by = NULL,
    rejected_at = NULL,
    submitted_at = now()
  WHERE id = p_request_id;

  IF v_changes ? 'lines' THEN
    DELETE FROM public.stock_request_lines WHERE request_id = p_request_id;
    PERFORM public.stock_request_insert_lines(p_request_id, v_lines);
  END IF;

  PERFORM public.log_stock_request_event(
    p_request_id,
    'resubmitted',
    'rejected',
    v_state,
    jsonb_build_object(
      'changes', v_changes - 'lines',
      'lines_replaced', v_changes ? 'lines',
      'previous_reject_code', v_req.reject_reason_code,
      'atlas_link_pending', v_pending,
      'contact_id', v_contact
    ),
    v_uid
  );

  IF v_state = 'awaiting_approval' THEN
    PERFORM public.notify_stock_request_admins(
      'request_awaiting_approval',
      '00000 request awaiting approval',
      format('A %s request was resubmitted as 00000 — not invoiced (%s).', v_type, v_kind),
      p_request_id
    );
  END IF;

  PERFORM public.notify_stock_request_issuers(
    p_request_id,
    'request_resubmitted',
    'Request resubmitted',
    format('A %s request was resubmitted and is ready to issue.', v_type)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resubmit_request(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resubmit_request(uuid, jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
