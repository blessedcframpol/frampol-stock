-- HF1: Atlas task links (URL parse + atlas_task_id), product catalogue for requesters,
-- and inventory SELECT locked down so sales/technicians cannot read kits/serials.
-- No BEGIN/COMMIT: rehearse and apply wrap their own transactions.
-- Does not modify existing business rows beyond backfilling atlas_task_id from stored URLs.

-- -----------------------------------------------------------------------------
-- 1. Shared Atlas URL parse (same rules as lib/atlas-task-url.ts)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.atlas_task_id_from_url(p_url text)
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_raw text := btrim(coalesce(p_url, ''));
  v_parts text[];
  v_scheme text;
  v_host text;
  v_port text;
  v_query text;
  v_pair text;
  v_key text;
  v_val text;
  v_task text;
BEGIN
  IF v_raw = '' THEN
    RETURN NULL;
  END IF;

  -- scheme://host[:port]/path[?query][#fragment] — not a whole-string allowlist.
  v_parts := regexp_match(
    v_raw,
    '^(https?)://([^/?#:]+)(?::([0-9]+))?([^?#]*)(?:\?([^#]*))?(?:#.*)?$',
    'i'
  );
  IF v_parts IS NULL THEN
    RETURN NULL;
  END IF;

  v_scheme := lower(v_parts[1]);
  v_host := lower(v_parts[2]);
  v_port := v_parts[3];
  v_query := coalesce(v_parts[5], '');

  IF v_scheme NOT IN ('http', 'https') THEN
    RETURN NULL;
  END IF;
  IF v_host IS DISTINCT FROM 'ai.frampolafrica.com' THEN
    RETURN NULL;
  END IF;
  IF v_port IS NOT NULL AND v_port IS DISTINCT FROM '10801' THEN
    RETURN NULL;
  END IF;

  FOREACH v_pair IN ARRAY string_to_array(v_query, '&')
  LOOP
    IF v_pair IS NULL OR v_pair = '' THEN
      CONTINUE;
    END IF;
    v_key := split_part(v_pair, '=', 1);
    IF position('=' IN v_pair) > 0 THEN
      v_val := substring(v_pair FROM position('=' IN v_pair) + 1);
    ELSE
      v_val := '';
    END IF;
    IF v_key = 'task' THEN
      v_task := nullif(btrim(v_val), '');
      EXIT;
    END IF;
  END LOOP;

  IF v_task IS NULL OR v_task !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;

  RETURN lower(v_task)::uuid;
EXCEPTION
  WHEN others THEN
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.atlas_task_id_from_url(text) IS
  'HF1: extract Atlas task UUID when host is ai.frampolafrica.com, port 10801 or absent; any path.';

CREATE OR REPLACE FUNCTION public.atlas_task_url_ok(p_url text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT public.atlas_task_id_from_url(p_url) IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.atlas_task_id_from_url(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.atlas_task_url_ok(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.atlas_task_id_from_url(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.atlas_task_url_ok(text) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. atlas_task_id column + CHECK
-- -----------------------------------------------------------------------------
ALTER TABLE public.stock_requests
  ADD COLUMN IF NOT EXISTS atlas_task_id uuid;

COMMENT ON COLUMN public.stock_requests.atlas_task_id IS
  'Parsed task UUID from atlas_task_url (HF1). Null only when atlas_task_url is null (historical cancelled).';

UPDATE public.stock_requests
SET atlas_task_id = public.atlas_task_id_from_url(atlas_task_url)
WHERE atlas_task_url IS NOT NULL
  AND atlas_task_id IS NULL;

ALTER TABLE public.stock_requests
  DROP CONSTRAINT IF EXISTS stock_requests_atlas_task_url_chk;

ALTER TABLE public.stock_requests
  ADD CONSTRAINT stock_requests_atlas_task_url_chk CHECK (
    (
      atlas_task_url IS NULL
      AND atlas_task_id IS NULL
      AND review_state = 'cancelled'
    )
    OR (
      atlas_task_url IS NOT NULL
      AND atlas_task_id IS NOT NULL
      AND atlas_task_id = public.atlas_task_id_from_url(atlas_task_url)
    )
  );

-- Keep atlas_task_id in sync on any write (submit RPCs and direct inserts).
CREATE OR REPLACE FUNCTION public.stock_requests_sync_atlas_task_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.atlas_task_url IS NULL THEN
    NEW.atlas_task_id := NULL;
  ELSE
    NEW.atlas_task_id := public.atlas_task_id_from_url(NEW.atlas_task_url);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_stock_requests_sync_atlas_task_id ON public.stock_requests;
CREATE TRIGGER tr_stock_requests_sync_atlas_task_id
  BEFORE INSERT OR UPDATE OF atlas_task_url, atlas_task_id
  ON public.stock_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.stock_requests_sync_atlas_task_id();

-- -----------------------------------------------------------------------------
-- 3. stock_request_fields_problem — same rule + fixed error copy
-- -----------------------------------------------------------------------------
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
  v_atlas text := nullif(btrim(coalesce(p_atlas_task_url, '')), '');
  v_problem text;
  v_internal text;
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
    RETURN 'Atlas task link is required';
  END IF;
  IF public.atlas_task_id_from_url(v_atlas) IS NULL THEN
    RETURN 'That doesn''t look like an Atlas task link. Open the task in Atlas and copy the address from the browser.';
  END IF;

  IF p_choice = 'number' THEN
    v_problem := public.real_invoice_number_problem(p_invoice_number);
    IF v_problem IS NOT NULL THEN
      RETURN v_problem;
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

-- -----------------------------------------------------------------------------
-- 4. submit_request / resubmit_request — persist atlas_task_id
-- -----------------------------------------------------------------------------
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
  v_atlas_id := public.atlas_task_id_from_url(v_atlas);
  v_choice := nullif(btrim(coalesce(p_payload->>'invoice_choice', '')), '');
  v_number := btrim(coalesce(p_payload->>'invoice_number', ''));
  v_reason := btrim(coalesce(p_payload->>'not_invoiced_reason', ''));
  v_kind := nullif(btrim(coalesce(p_payload->>'not_invoiced_kind', '')), '');
  v_lines := p_payload->'lines';
  v_client := public.stock_request_resolve_client(p_payload->>'client_id', v_choice, v_kind);

  v_problem := public.stock_request_fields_problem(v_client, v_type, v_return, v_atlas, v_choice, v_number, v_reason, v_kind);
  IF v_problem IS NULL THEN
    v_problem := public.stock_request_lines_problem(v_type, v_lines);
  END IF;
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION '%', v_problem USING ERRCODE = 'check_violation';
  END IF;

  v_state := CASE WHEN v_choice = 'not_invoiced' THEN 'awaiting_approval' ELSE 'submitted' END;

  INSERT INTO public.stock_requests (
    client_id, created_by, review_state, type, return_date, atlas_task_url, atlas_task_id, quotation_url, notes,
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
      'line_count', jsonb_array_length(v_lines)
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
  v_atlas_id := public.atlas_task_id_from_url(v_atlas);
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
      'previous_reject_code', v_req.reject_reason_code
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
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. Active product catalogue (counts-free; no kits/serials)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.product_catalogue()
RETURNS TABLE (
  product_id text,
  product_name text,
  vendor text,
  is_active boolean,
  requires_cloud_key boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role public.app_role := public.get_my_role();
BEGIN
  IF v_uid IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'product_catalogue: signed-in staff only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT
    pl.id::text AS product_id,
    pl.product_name::text AS product_name,
    pl.vendor::text AS vendor,
    pl.is_active AS is_active,
    pl.requires_cloud_key AS requires_cloud_key
  FROM public.product_lines AS pl
  WHERE pl.is_active IS TRUE
  ORDER BY pl.product_name ASC, pl.vendor ASC;
END;
$$;

COMMENT ON FUNCTION public.product_catalogue() IS
  'HF1: active product catalogue for every signed-in role. No kits, serials, locations, or history.';

REVOKE ALL ON FUNCTION public.product_catalogue() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.product_catalogue() TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 6. Requesters cannot SELECT inventory kits/serials (accounts/viewer/admin keep access)
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Non-admin read inventory_items" ON public.inventory_items;
CREATE POLICY "Non-admin read inventory_items"
  ON public.inventory_items FOR SELECT
  TO authenticated
  USING (
    (SELECT public.get_my_role()) IN ('accounts', 'viewer')
    AND deleted_at IS NULL
  );

NOTIFY pgrst, 'reload schema';
