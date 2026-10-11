-- =============================================================================
-- RQ2: roles, request rules (Fortinet mix, internal client), notifications cron
-- No BEGIN/COMMIT: rehearse/apply wraps its own txn.
-- =============================================================================
--
-- INTERNAL CLIENT
--   app_settings.internal_client_id → Frampol Inhouse (CLT-1779783610314-dj3rqr9).
--   00000 kind=internal forces that client on submit/resubmit.
--
-- ROLES
--   Sales/technicians: own requests only; no stock movements (RLS + apply gate).
--   Admin: movements + issue + approve/reject (unchanged privileged ops).
--   Accounts: Fortinet issue only (RQ1).
--   Viewer ("Admin viewer"): read-all requests/invoices/audit/users; no writes.
--
-- REMINDER
--   notify_awaiting_invoice_reminders(p_as_of) — Mon–Fri Africa/Harare only.
--   pg_cron: 0 7 * * 1-5 (07:00 UTC = 09:00 Africa/Harare).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. app_settings.internal_client_id
-- -----------------------------------------------------------------------------
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS internal_client_id text
    REFERENCES public.clients (id);

COMMENT ON COLUMN public.app_settings.internal_client_id IS
  'Client used when a 00000 request is labelled Internal. Seeded to Frampol Inhouse.';

UPDATE public.app_settings
SET internal_client_id = 'CLT-1779783610314-dj3rqr9'
WHERE id IS TRUE
  AND internal_client_id IS NULL
  AND EXISTS (SELECT 1 FROM public.clients WHERE id = 'CLT-1779783610314-dj3rqr9');

-- -----------------------------------------------------------------------------
-- 2. Movement writer gate (admin direct, or issue_units via app.request_issue)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_can_record_stock_movement()
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF nullif(btrim(coalesce(current_setting('app.request_issue', true), '')), '') IS NOT NULL THEN
    RETURN;
  END IF;
  -- Session without JWT (service role / SQL console) may write.
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;
  IF public.get_my_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only an admin can record stock movements'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_can_record_stock_movement() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assert_can_record_stock_movement() TO authenticated, service_role;

DO $patch$
DECLARE
  def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'apply_stock_movement'
    AND pg_get_function_identity_arguments(p.oid) LIKE 'p_inventory_upserts%'
  ORDER BY p.oid DESC
  LIMIT 1;

  IF def IS NULL THEN
    RAISE EXCEPTION 'apply_stock_movement not found';
  END IF;

  IF position('assert_can_record_stock_movement' IN def) > 0 THEN
    RAISE NOTICE 'apply_stock_movement already gated';
    RETURN;
  END IF;

  def := regexp_replace(
    def,
    E'BEGIN\\s*\\n',
    E'BEGIN\n  PERFORM public.assert_can_record_stock_movement();\n',
    ''
  );
  EXECUTE def;
END;
$patch$;

-- Drop technician write policies (admin FOR ALL remains; issue_units is DEFINER).
DROP POLICY IF EXISTS "Technicians insert inventory_items" ON public.inventory_items;
DROP POLICY IF EXISTS "Technicians update inventory_items" ON public.inventory_items;
DROP POLICY IF EXISTS "Technicians insert transactions" ON public.transactions;
DROP POLICY IF EXISTS "Technicians insert outbound_batches" ON public.outbound_batches;

-- Technicians may no longer amend their own transactions via direct UPDATE/DELETE.
DROP POLICY IF EXISTS "Creator or admin update transactions" ON public.transactions;
DROP POLICY IF EXISTS "Creator or admin delete transactions" ON public.transactions;

CREATE POLICY "Admin update transactions"
  ON public.transactions FOR UPDATE TO authenticated
  USING ((SELECT public.get_my_role()) = 'admin')
  WITH CHECK ((SELECT public.get_my_role()) = 'admin');

CREATE POLICY "Admin delete transactions"
  ON public.transactions FOR DELETE TO authenticated
  USING ((SELECT public.get_my_role()) = 'admin');

-- -----------------------------------------------------------------------------
-- 3. Request RLS: sales/tech own-only; viewer/admin/accounts see all
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS stock_requests_select ON public.stock_requests;
CREATE POLICY stock_requests_select
  ON public.stock_requests FOR SELECT TO authenticated
  USING (
    created_by = (SELECT auth.uid())
    OR (SELECT public.get_my_role()) IN ('admin', 'accounts', 'viewer')
  );

DROP POLICY IF EXISTS stock_request_lines_select ON public.stock_request_lines;
CREATE POLICY stock_request_lines_select
  ON public.stock_request_lines FOR SELECT TO authenticated
  USING (
    (SELECT public.get_my_role()) IN ('admin', 'accounts', 'viewer')
    OR EXISTS (
      SELECT 1
      FROM public.stock_requests AS request
      WHERE request.id = stock_request_lines.request_id
        AND request.created_by = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS stock_request_events_select_own ON public.stock_request_events;
CREATE POLICY stock_request_events_select
  ON public.stock_request_events FOR SELECT TO authenticated
  USING (
    (SELECT public.get_my_role()) IN ('admin', 'accounts', 'viewer')
    OR EXISTS (
      SELECT 1
      FROM public.stock_requests AS request
      WHERE request.id = stock_request_events.request_id
        AND request.created_by = (SELECT auth.uid())
    )
  );

-- -----------------------------------------------------------------------------
-- 4. Admin viewer: profiles list + audit_log_read
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can read all profiles" ON public.profiles;
CREATE POLICY "Admins and viewers can read all profiles"
  ON public.profiles FOR SELECT TO authenticated
  USING ((SELECT public.get_my_role()) IN ('admin', 'viewer'));

CREATE OR REPLACE FUNCTION public.audit_log_read(
  p_table text DEFAULT NULL,
  p_row text DEFAULT NULL,
  p_user text DEFAULT NULL,
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tz text;
  v_user text := nullif(btrim(coalesce(p_user, '')), '');
BEGIN
  IF coalesce(public.get_my_role()::text, '') NOT IN ('admin', 'viewer') THEN
    RAISE EXCEPTION 'audit_log_read: admin or Admin viewer only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT coalesce(nullif(btrim(timezone), ''), 'Africa/Harare')
  INTO v_tz
  FROM public.app_settings
  WHERE id IS TRUE;
  v_tz := coalesce(v_tz, 'Africa/Harare');

  RETURN (
    SELECT coalesce(jsonb_agg(to_jsonb(entry) ORDER BY entry.at DESC, entry.id DESC), '[]'::jsonb)
    FROM (
      SELECT
        log.id,
        log.table_name,
        log.row_id,
        log.action,
        log.changed,
        log.actor,
        coalesce(nullif(btrim(profile.display_name), ''), profile.email) AS actor_name,
        log.source,
        log.reason,
        log.at,
        log.transaction_id
      FROM public.audit_log AS log
      LEFT JOIN public.profiles AS profile ON profile.id::text = log.actor
      WHERE (nullif(btrim(coalesce(p_table, '')), '') IS NULL OR log.table_name = btrim(p_table))
        AND (nullif(btrim(coalesce(p_row, '')), '') IS NULL OR log.row_id = btrim(p_row))
        AND (
          v_user IS NULL
          OR log.actor = v_user
          OR profile.display_name ILIKE '%' || v_user || '%'
          OR profile.email ILIKE '%' || v_user || '%'
        )
        AND (p_from IS NULL OR (log.at AT TIME ZONE v_tz)::date >= p_from)
        AND (p_to IS NULL OR (log.at AT TIME ZONE v_tz)::date <= p_to)
      ORDER BY log.at DESC, log.id DESC
      LIMIT 500
    ) AS entry
  );
END;
$$;

COMMENT ON FUNCTION public.audit_log_read(text, text, text, date, date) IS
  'Admin and Admin viewer read the audit log. No writes.';

-- -----------------------------------------------------------------------------
-- 5. Fortinet mix rule + internal client on submit/resubmit helpers
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.stock_request_lines_problem(p_type text, p_lines jsonb)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_line jsonb;
  v_product_id text;
  v_quantity text;
  v_vendor text;
  v_active boolean;
  v_name text;
  v_seen text[] := '{}';
  v_fortinet integer := 0;
  v_other integer := 0;
BEGIN
  IF p_lines IS NULL OR jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RETURN 'Add at least one product line';
  END IF;

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    IF jsonb_typeof(v_line) IS DISTINCT FROM 'object' THEN
      RETURN 'Each line needs a product and a quantity';
    END IF;
    v_product_id := nullif(btrim(coalesce(v_line->>'product_id', '')), '');
    v_quantity := btrim(coalesce(v_line->>'quantity', ''));
    IF v_product_id IS NULL THEN
      RETURN 'Each line needs a product';
    END IF;
    IF v_quantity !~ '^[0-9]{1,5}$' OR v_quantity::int < 1 THEN
      RETURN 'Each line needs a whole quantity of at least 1';
    END IF;
    IF v_product_id = ANY (v_seen) THEN
      RETURN 'A product appears on more than one line';
    END IF;
    v_seen := v_seen || v_product_id;

    SELECT line.vendor, line.is_active, line.product_name
    INTO v_vendor, v_active, v_name
    FROM public.product_lines AS line
    WHERE line.id = v_product_id;

    IF NOT FOUND THEN
      RETURN 'A line names a product that is not in the catalog';
    END IF;
    IF NOT coalesce(v_active, false) THEN
      RETURN format('%s is not an active product', v_name);
    END IF;
    IF p_type = 'Rentals' AND coalesce(v_vendor, '') IS DISTINCT FROM 'Starlink' THEN
      RETURN 'Rentals is only for Starlink kits';
    END IF;

    IF lower(btrim(coalesce(v_vendor, ''))) = 'fortinet' THEN
      v_fortinet := v_fortinet + 1;
    ELSE
      v_other := v_other + 1;
    END IF;
  END LOOP;

  IF v_fortinet > 0 AND v_other > 0 THEN
    RETURN 'A request must be all Fortinet lines or no Fortinet lines — do not mix them';
  END IF;

  RETURN NULL;
END;
$$;

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
  IF v_atlas !~ '^https://ai\.frampolafrica\.com:10801/projects/[0-9a-f-]{36}\?task=[0-9a-f-]{36}$' THEN
    RETURN 'Atlas task link must look like https://ai.frampolafrica.com:10801/projects/<id>?task=<id>';
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

CREATE OR REPLACE FUNCTION public.stock_request_resolve_client(
  p_client_id text,
  p_choice text,
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
BEGIN
  IF p_choice = 'not_invoiced' AND p_kind = 'internal' THEN
    SELECT s.internal_client_id INTO v_internal
    FROM public.app_settings AS s
    WHERE s.id IS TRUE;
    IF v_internal IS NULL THEN
      RAISE EXCEPTION 'Internal client is not configured in settings'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN v_internal;
  END IF;
  RETURN v_client;
END;
$$;

REVOKE ALL ON FUNCTION public.stock_request_resolve_client(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_request_resolve_client(text, text, text) TO authenticated, service_role;

-- Patch submit_request to force internal client
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
    client_id, created_by, review_state, type, return_date, atlas_task_url, quotation_url, notes,
    invoice_status, invoice_number, not_invoiced_reason, not_invoiced_kind, invoice_approval,
    invoice_entered_by, invoice_entered_at, submitted_at
  ) VALUES (
    v_client,
    v_uid,
    v_state,
    v_type,
    v_return,
    v_atlas,
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
-- 6. Richer issue / reject / approve notifications
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_not_invoiced(p_request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_req public.stock_requests%ROWTYPE;
  v_state text;
BEGIN
  IF v_uid IS NULL OR public.get_my_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only an admin can approve 00000'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_req FROM public.stock_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request was not found';
  END IF;
  IF v_req.review_state IN ('rejected', 'cancelled') THEN
    RAISE EXCEPTION 'This request is %', v_req.review_state;
  END IF;
  IF v_req.invoice_status IS DISTINCT FROM 'not_invoiced' OR v_req.invoice_approval IS DISTINCT FROM 'awaiting' THEN
    RAISE EXCEPTION 'This request is not awaiting 00000 approval';
  END IF;
  IF v_req.created_by = v_uid OR v_req.invoice_entered_by = v_uid THEN
    RAISE EXCEPTION 'You cannot approve a 00000 you requested or entered';
  END IF;

  v_state := CASE WHEN v_req.review_state = 'awaiting_approval' THEN 'submitted' ELSE v_req.review_state END;

  UPDATE public.stock_requests
  SET
    invoice_approval = 'approved',
    invoice_approved_by = v_uid,
    invoice_approved_at = now(),
    review_state = v_state
  WHERE id = p_request_id;

  PERFORM public.sync_request_batch_invoices(p_request_id, NULL);

  PERFORM public.log_stock_request_event(
    p_request_id,
    'not_invoiced_approved',
    v_req.review_state,
    v_state,
    jsonb_build_object('not_invoiced_kind', v_req.not_invoiced_kind),
    v_uid
  );

  PERFORM public.notify_stock_request(
    v_req.created_by,
    'request_not_invoiced_approved',
    '00000 approved',
    format(
      'Your %s request was approved as 00000 — %s. %s',
      v_req.type,
      coalesce(v_req.not_invoiced_kind, 'not invoiced'),
      left(coalesce(v_req.not_invoiced_reason, ''), 120)
    ),
    p_request_id
  );
END;
$$;

-- Issue notification: partial vs fulfilled (patch issue_units notify block)
DO $issue$
DECLARE
  def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'issue_units'
    AND pg_get_function_identity_arguments(p.oid) = 'p_request_id uuid, p_scans jsonb'
  LIMIT 1;

  IF def IS NULL THEN
    RAISE EXCEPTION 'issue_units not found';
  END IF;

  IF position('request_units_issued' IN def) = 0 THEN
    RETURN;
  END IF;

  -- Replace the notify_stock_request call for units issued with richer title/body
  def := regexp_replace(
    def,
    E'PERFORM public\\.notify_stock_request\\(\\s*v_req\\.created_by,\\s*''request_units_issued'',\\s*''Units issued'',\\s*format\\([\\s\\S]*?\\),\\s*p_request_id\\s*\\);',
    $n$PERFORM public.notify_stock_request(
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
  );$n$,
    ''
  );
  EXECUTE def;
END;
$issue$;

CREATE OR REPLACE FUNCTION public.reject_request(p_request_id uuid, p_code text, p_note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_req public.stock_requests%ROWTYPE;
  v_code text := btrim(coalesce(p_code, ''));
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_reason text;
BEGIN
  IF v_uid IS NULL OR public.get_my_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only an admin can reject a request'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_code NOT IN ('insufficient_customer_info', 'no_atlas_task', 'no_invoice', 'other') THEN
    RAISE EXCEPTION 'Pick a rejection reason'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_code = 'other' AND v_note IS NULL THEN
    RAISE EXCEPTION 'Explain the rejection when the reason is Other'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_req FROM public.stock_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request was not found';
  END IF;
  IF v_req.review_state NOT IN ('submitted', 'awaiting_approval') THEN
    RAISE EXCEPTION 'Only a submitted or awaiting-approval request can be rejected';
  END IF;
  IF public.stock_request_issued_total(p_request_id) > 0 THEN
    RAISE EXCEPTION 'Units are already issued on this request. Close the outstanding units instead';
  END IF;

  UPDATE public.stock_requests
  SET
    review_state = 'rejected',
    reject_reason_code = v_code,
    reject_note = v_note,
    rejected_by = v_uid,
    rejected_at = now()
  WHERE id = p_request_id;

  PERFORM public.log_stock_request_event(
    p_request_id,
    'rejected',
    v_req.review_state,
    'rejected',
    jsonb_build_object('reason_code', v_code, 'note', v_note),
    v_uid
  );

  v_reason := CASE v_code
    WHEN 'insufficient_customer_info' THEN 'Insufficient customer info'
    WHEN 'no_atlas_task' THEN 'No Atlas task'
    WHEN 'no_invoice' THEN 'No invoice'
    ELSE 'Other'
  END;
  IF v_note IS NOT NULL THEN
    v_reason := v_reason || ' — ' || v_note;
  END IF;

  PERFORM public.notify_stock_request(
    v_req.created_by,
    'request_rejected',
    'Request rejected',
    'Your request was rejected: ' || v_reason,
    p_request_id
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. Daily awaiting-invoice reminders (Mon–Fri Africa/Harare)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_awaiting_invoice_reminders(
  p_as_of timestamptz DEFAULT now()
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tz text;
  v_local timestamp;
  v_dow integer;
  v_n integer := 0;
  r record;
  v_body text;
BEGIN
  SELECT coalesce(nullif(btrim(timezone), ''), 'Africa/Harare')
  INTO v_tz
  FROM public.app_settings
  WHERE id IS TRUE;

  v_local := (p_as_of AT TIME ZONE v_tz);
  v_dow := extract(isodow FROM v_local)::integer; -- 1=Mon … 7=Sun

  IF v_dow > 5 THEN
    RETURN 0;
  END IF;

  FOR r IN
    SELECT
      req.created_by AS user_id,
      count(*)::int AS n,
      string_agg(req.id::text, ', ' ORDER BY req.created_at) AS ids
    FROM public.stock_requests AS req
    WHERE req.invoice_status = 'pending'
      AND req.review_state NOT IN ('cancelled', 'closed', 'rejected')
    GROUP BY req.created_by
  LOOP
    v_body := format(
      'You have %s request(s) still awaiting an invoice number. Open Requests to add the number.',
      r.n
    );
    INSERT INTO public.notifications (user_id, type, title, body, metadata)
    VALUES (
      r.user_id,
      'request_awaiting_invoice_reminder',
      'Invoice number still needed',
      v_body,
      jsonb_build_object('request_ids', to_jsonb(string_to_array(r.ids, ', ')), 'as_of', p_as_of)
    );
    v_n := v_n + 1;
  END LOOP;

  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION public.notify_awaiting_invoice_reminders(timestamptz) IS
  'Inserts one reminder per requester with pending-invoice requests. No-ops on Sat/Sun in Africa/Harare. '
  'Scheduled daily at 09:00 Africa/Harare (07:00 UTC Mon–Fri) via pg_cron.';

REVOKE ALL ON FUNCTION public.notify_awaiting_invoice_reminders(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_awaiting_invoice_reminders(timestamptz) TO service_role;

-- pg_cron may need a one-time dashboard enable on some projects. Schedule is
-- 09:00 Africa/Harare = 07:00 UTC, Mon–Fri. Wrapped so rehearsal ROLLBACK still works.
DO $cron$
BEGIN
  EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog';
  PERFORM cron.unschedule(j.jobid)
  FROM cron.job AS j
  WHERE j.jobname = 'rq2-awaiting-invoice-reminders';
  PERFORM cron.schedule(
    'rq2-awaiting-invoice-reminders',
    '0 7 * * 1-5',
    $job$SELECT public.notify_awaiting_invoice_reminders()$job$
  );
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'pg_cron schedule skipped (%). Function notify_awaiting_invoice_reminders is ready; schedule manually if needed.',
      SQLERRM;
END;
$cron$;
