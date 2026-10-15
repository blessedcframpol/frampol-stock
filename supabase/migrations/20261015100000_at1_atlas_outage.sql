-- AT1 — Atlas outage mode: optional link on submit, pending flag, restore notifications.

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS atlas_link_required boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.app_settings.atlas_link_required IS
  'When false, submit/resubmit may omit atlas_task_url (atlas_link_pending on the request).';

ALTER TABLE public.stock_requests
  ADD COLUMN IF NOT EXISTS atlas_link_pending boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.stock_requests.atlas_link_pending IS
  'True when submitted without an Atlas link while atlas_link_required was false.';

CREATE OR REPLACE FUNCTION public.app_settings_atlas_link_required()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT coalesce(
    (SELECT s.atlas_link_required FROM public.app_settings AS s WHERE s.id IS TRUE LIMIT 1),
    true
  );
$$;

REVOKE ALL ON FUNCTION public.app_settings_atlas_link_required() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.app_settings_atlas_link_required() TO authenticated, service_role;

-- Relax CHECK: null URL allowed when cancelled or atlas_link_pending.
ALTER TABLE public.stock_requests
  DROP CONSTRAINT IF EXISTS stock_requests_atlas_task_url_chk;

ALTER TABLE public.stock_requests
  ADD CONSTRAINT stock_requests_atlas_task_url_chk CHECK (
    (
      atlas_task_url IS NULL
      AND atlas_task_id IS NULL
      AND (review_state = 'cancelled' OR atlas_link_pending IS TRUE)
    )
    OR (
      atlas_task_url IS NOT NULL
      AND atlas_task_id IS NOT NULL
      AND atlas_task_id = public.atlas_task_id_from_url(atlas_task_url)
      AND atlas_link_pending IS FALSE
    )
  );

CREATE OR REPLACE FUNCTION public.stock_request_fields_problem(
  p_client_id text,
  p_type text,
  p_return_date date,
  p_atlas_task_url text,
  p_choice text,
  p_invoice_number text,
  p_reason text,
  p_kind text
)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_client text := nullif(btrim(coalesce(p_client_id, '')), '');
  v_internal text;
  v_atlas text := nullif(btrim(coalesce(p_atlas_task_url, '')), '');
  v_link_required boolean := public.app_settings_atlas_link_required();
  v_inv_problem text;
BEGIN
  IF p_choice = 'not_invoiced' AND p_kind = 'internal' THEN
    SELECT s.internal_client_id INTO v_internal
    FROM public.app_settings AS s
    WHERE s.id IS TRUE;
    IF v_internal IS NULL THEN
      RETURN 'Internal client is not configured in settings';
    END IF;
    v_client := v_internal;
  ELSIF v_client IS NULL OR NOT EXISTS (SELECT 1 FROM public.clients WHERE id = v_client) THEN
    RETURN 'Pick a client from the directory';
  END IF;

  IF p_type IS NULL OR p_type NOT IN ('Sale', 'POC Out', 'Rentals') THEN
    RETURN 'Request type must be Sale, POC Out, or Rentals';
  END IF;

  IF p_type IN ('POC Out', 'Rentals') THEN
    IF p_return_date IS NULL THEN
      RETURN p_type || ' needs a return date';
    END IF;
    IF p_return_date <= public.stock_request_today() THEN
      RETURN 'Return date must be after today';
    END IF;
  ELSIF p_return_date IS NOT NULL THEN
    RETURN 'A Sale does not take a return date';
  END IF;

  IF v_atlas IS NULL THEN
    IF v_link_required THEN
      RETURN 'Atlas task link is required';
    END IF;
  ELSIF public.atlas_task_id_from_url(v_atlas) IS NULL THEN
    RETURN 'That doesn''t look like an Atlas task link. Open the task in Atlas and copy the address from the browser.';
  END IF;

  IF p_choice = 'number' THEN
    v_inv_problem := public.real_invoice_number_problem(p_invoice_number);
    IF v_inv_problem IS NOT NULL THEN
      RETURN v_inv_problem;
    END IF;
  ELSIF p_choice = 'pending' THEN
    IF btrim(coalesce(p_invoice_number, '')) <> '' THEN
      RETURN 'Invoice pending does not take a number';
    END IF;
  ELSIF p_choice = 'not_invoiced' THEN
    IF char_length(btrim(coalesce(p_reason, ''))) < 15 THEN
      RETURN '00000 needs a reason of at least 15 characters';
    END IF;
    IF p_kind IS NULL OR p_kind NOT IN ('internal', 'complimentary') THEN
      RETURN '00000 needs a kind: internal or complimentary';
    END IF;
  ELSE
    RETURN 'Invoice must be a number, Invoice pending, or 00000 — not invoiced';
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_atlas_link_restored()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row record;
BEGIN
  FOR v_row IN
    SELECT DISTINCT ON (sr.created_by)
      sr.created_by,
      sr.id,
      sr.request_number
    FROM public.stock_requests AS sr
    WHERE sr.atlas_link_pending IS TRUE
      AND sr.review_state NOT IN ('cancelled', 'closed')
    ORDER BY sr.created_by, sr.created_at DESC
  LOOP
    INSERT INTO public.notifications (user_id, type, title, body, metadata)
    VALUES (
      v_row.created_by,
      'atlas_link_restored',
      'Atlas is back',
      format('Add the task link to %s', v_row.request_number),
      jsonb_build_object(
        'request_id', v_row.id::text,
        'request_number', v_row.request_number,
        'href', '/requests/' || v_row.id::text
      )
    );
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_atlas_link_restored() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_atlas_link_required(p_required boolean, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role public.app_role := public.get_my_role();
  v_was boolean;
BEGIN
  IF v_uid IS NULL OR v_role IS DISTINCT FROM 'admin'::public.app_role THEN
    RAISE EXCEPTION 'set_atlas_link_required: admin only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF char_length(btrim(coalesce(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT s.atlas_link_required INTO v_was
  FROM public.app_settings AS s
  WHERE s.id IS TRUE
  FOR UPDATE;

  IF v_was IS NOT DISTINCT FROM p_required THEN
    RETURN;
  END IF;

  PERFORM set_config('app.audit_source', 'set_atlas_link_required', true);
  PERFORM set_config('app.audit_reason', btrim(p_reason), true);

  UPDATE public.app_settings
  SET
    atlas_link_required = p_required,
    updated_at = now(),
    updated_by = v_uid
  WHERE id IS TRUE;

  IF p_required IS TRUE AND coalesce(v_was, true) IS FALSE THEN
    PERFORM public.notify_atlas_link_restored();
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.set_atlas_link_required(boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_atlas_link_required(boolean, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_request_atlas_link(p_request_id uuid, p_url text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role public.app_role := public.get_my_role();
  v_req public.stock_requests%ROWTYPE;
  v_atlas text := nullif(btrim(coalesce(p_url, '')), '');
  v_atlas_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not signed in'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_atlas_id := public.atlas_task_id_from_url(v_atlas);
  IF v_atlas_id IS NULL THEN
    RAISE EXCEPTION 'That doesn''t look like an Atlas task link. Open the task in Atlas and copy the address from the browser.'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_req FROM public.stock_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request was not found';
  END IF;

  IF v_role IS DISTINCT FROM 'admin'::public.app_role AND v_req.created_by IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Only the requester or an admin can set the Atlas link'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_req.review_state IN ('cancelled', 'closed') THEN
    RAISE EXCEPTION 'This request is closed'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT v_req.atlas_link_pending AND v_req.atlas_task_url IS NOT NULL THEN
    RAISE EXCEPTION 'This request already has an Atlas task link'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.stock_requests
  SET
    atlas_task_url = v_atlas,
    atlas_task_id = v_atlas_id,
    atlas_link_pending = false
  WHERE id = p_request_id;

  PERFORM public.log_stock_request_event(
    p_request_id,
    'atlas_link_set',
    NULL,
    NULL,
    jsonb_build_object('atlas_task_url', v_atlas, 'atlas_task_id', v_atlas_id::text),
    v_uid
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_request_atlas_link(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_request_atlas_link(uuid, text) TO authenticated, service_role;

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

  v_problem := public.stock_request_fields_problem(v_client, v_type, v_return, v_atlas, v_choice, v_number, v_reason, v_kind);
  IF v_problem IS NULL THEN
    v_problem := public.stock_request_lines_problem(v_type, v_lines);
  END IF;
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION '%', v_problem USING ERRCODE = 'check_violation';
  END IF;

  v_state := CASE WHEN v_choice = 'not_invoiced' THEN 'awaiting_approval' ELSE 'submitted' END;

  INSERT INTO public.stock_requests (
    client_id, created_by, review_state, type, return_date, atlas_task_url, atlas_task_id, atlas_link_pending,
    quotation_url, notes,
    invoice_status, invoice_number, not_invoiced_reason, not_invoiced_kind, invoice_approval,
    invoice_entered_by, invoice_entered_at, submitted_at
  ) VALUES (
    v_client,
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
      'atlas_link_pending', v_pending
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

REVOKE ALL ON FUNCTION public.submit_request(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_request(jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.resubmit_request(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resubmit_request(uuid, jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
