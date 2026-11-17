-- CT1: client_contacts (people) + optional stock_requests.contact_id (buyer).
-- No sync with clients.name/email/phone. No seed from existing data.
-- No outer BEGIN/COMMIT (rehearse/apply wrap transactions).

SET lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- 1. client_contacts
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.client_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL REFERENCES public.clients (id) ON DELETE RESTRICT,
  name text NOT NULL,
  role text NOT NULL,
  email text,
  phone text,
  is_primary boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  notes text,
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_contacts_role_chk
    CHECK (role = ANY (ARRAY['buyer'::text, 'collector'::text, 'accounts'::text, 'other'::text])),
  CONSTRAINT client_contacts_name_not_blank_chk
    CHECK (char_length(btrim(name)) > 0),
  CONSTRAINT client_contacts_email_or_phone_chk
    CHECK (
      nullif(btrim(coalesce(email, '')), '') IS NOT NULL
      OR nullif(btrim(coalesce(phone, '')), '') IS NOT NULL
    )
);

COMMENT ON TABLE public.client_contacts IS
  'CT1: people linked to a client (buyer/collector/accounts/other). Independent of clients.name/email/phone.';

CREATE INDEX IF NOT EXISTS idx_client_contacts_client_id
  ON public.client_contacts (client_id);

CREATE INDEX IF NOT EXISTS idx_client_contacts_client_active
  ON public.client_contacts (client_id)
  WHERE active IS TRUE;

-- At most one active primary contact per client.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_client_contacts_one_active_primary
  ON public.client_contacts (client_id)
  WHERE is_primary IS TRUE AND active IS TRUE;

-- -----------------------------------------------------------------------------
-- 2. Validate + normalise (reuse NC1 single-email / phone helpers)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.client_contacts_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_email text;
  v_phone_raw text;
  v_phone text;
  v_problem text;
BEGIN
  NEW.name := btrim(coalesce(NEW.name, ''));
  IF NEW.name = '' THEN
    RAISE EXCEPTION 'Contact name is required'
      USING ERRCODE = 'check_violation';
  END IF;
  IF public.client_is_placeholder(NEW.name) THEN
    RAISE EXCEPTION 'Contact name cannot be a placeholder'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.role IS NULL OR NEW.role NOT IN ('buyer', 'collector', 'accounts', 'other') THEN
    RAISE EXCEPTION 'Contact role must be buyer, collector, accounts, or other'
      USING ERRCODE = 'check_violation';
  END IF;

  v_email := nullif(btrim(coalesce(NEW.email, '')), '');
  v_phone_raw := nullif(btrim(coalesce(NEW.phone, '')), '');

  IF v_email IS NULL AND v_phone_raw IS NULL THEN
    RAISE EXCEPTION 'Contact needs an email or a phone'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_email IS NOT NULL THEN
    IF position(';' IN v_email) > 0 OR position(',' IN v_email) > 0 THEN
      RAISE EXCEPTION 'Contact email must be a single address'
        USING ERRCODE = 'check_violation';
    END IF;
    v_problem := public.client_one_email_problem(v_email);
    IF v_problem IS NOT NULL THEN
      RAISE EXCEPTION '%', v_problem USING ERRCODE = 'check_violation';
    END IF;
    NEW.email := lower(v_email);
  ELSE
    NEW.email := NULL;
  END IF;

  IF v_phone_raw IS NOT NULL THEN
    IF public.client_is_placeholder(v_phone_raw) THEN
      RAISE EXCEPTION 'Phone cannot be a placeholder'
        USING ERRCODE = 'check_violation';
    END IF;
    v_phone := public.client_normalize_phone(v_phone_raw);
    IF v_phone IS NULL THEN
      RAISE EXCEPTION 'Enter a valid phone number (e.g. 077 123 4567, +27 82 123 4567, or +260 97 123 4567)'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.phone := v_phone;
  ELSE
    NEW.phone := NULL;
  END IF;

  IF NEW.notes IS NOT NULL AND btrim(NEW.notes) = '' THEN
    NEW.notes := NULL;
  END IF;

  NEW.is_primary := coalesce(NEW.is_primary, false);
  NEW.active := coalesce(NEW.active, true);
  IF NEW.active IS FALSE THEN
    NEW.is_primary := false;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_by := coalesce(NEW.created_by, auth.uid());
    NEW.created_at := coalesce(NEW.created_at, now());
  END IF;
  NEW.updated_at := now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_client_contacts_before_write ON public.client_contacts;
CREATE TRIGGER tr_client_contacts_before_write
  BEFORE INSERT OR UPDATE ON public.client_contacts
  FOR EACH ROW
  EXECUTE FUNCTION public.client_contacts_before_write();

-- Demote other primaries before write so the partial unique index can accept the new one.
CREATE OR REPLACE FUNCTION public.client_contacts_enforce_one_primary()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.is_primary IS TRUE AND NEW.active IS TRUE THEN
    UPDATE public.client_contacts
    SET is_primary = false, updated_at = now()
    WHERE client_id = NEW.client_id
      AND id IS DISTINCT FROM coalesce(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
      AND is_primary IS TRUE;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_client_contacts_one_primary ON public.client_contacts;
CREATE TRIGGER tr_client_contacts_one_primary
  BEFORE INSERT OR UPDATE OF is_primary, active ON public.client_contacts
  FOR EACH ROW
  WHEN (NEW.is_primary IS TRUE AND NEW.active IS TRUE)
  EXECUTE FUNCTION public.client_contacts_enforce_one_primary();

-- -----------------------------------------------------------------------------
-- 3. RLS (mirror clients) — no DELETE for non-admins
-- -----------------------------------------------------------------------------
ALTER TABLE public.client_contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin full access client_contacts" ON public.client_contacts;
CREATE POLICY "Admin full access client_contacts"
  ON public.client_contacts FOR ALL
  TO authenticated
  USING ((SELECT public.get_my_role()) = 'admin')
  WITH CHECK ((SELECT public.get_my_role()) = 'admin');

DROP POLICY IF EXISTS "Non-admin read client_contacts" ON public.client_contacts;
CREATE POLICY "Non-admin read client_contacts"
  ON public.client_contacts FOR SELECT
  TO authenticated
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians', 'viewer'));

DROP POLICY IF EXISTS "Non-admin insert client_contacts" ON public.client_contacts;
CREATE POLICY "Non-admin insert client_contacts"
  ON public.client_contacts FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.get_my_role()) IN ('sales', 'technicians'));

DROP POLICY IF EXISTS "Non-admin update client_contacts" ON public.client_contacts;
CREATE POLICY "Non-admin update client_contacts"
  ON public.client_contacts FOR UPDATE
  TO authenticated
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'))
  WITH CHECK ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'));

REVOKE ALL ON TABLE public.client_contacts FROM PUBLIC, anon;
-- DELETE granted for admin RLS only; non-admins archive via active = false.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.client_contacts TO authenticated;
GRANT ALL ON TABLE public.client_contacts TO service_role;

-- -----------------------------------------------------------------------------
-- 4. Audit
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS tr_client_contacts_audit ON public.client_contacts;
CREATE TRIGGER tr_client_contacts_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.client_contacts
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_capture('id');

-- -----------------------------------------------------------------------------
-- 5. stock_requests.contact_id (optional buyer)
-- -----------------------------------------------------------------------------
ALTER TABLE public.stock_requests
  ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES public.client_contacts (id) ON DELETE SET NULL;

COMMENT ON COLUMN public.stock_requests.contact_id IS
  'CT1: optional buyer contact (client_contacts.id) for this request.';

CREATE INDEX IF NOT EXISTS idx_stock_requests_contact_id
  ON public.stock_requests (contact_id)
  WHERE contact_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 6. submit_request: accept optional contact_id (must belong to resolved client)
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

  v_contact := nullif(btrim(coalesce(p_payload->>'contact_id', '')), '')::uuid;
  IF v_contact IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.client_contacts cc
      WHERE cc.id = v_contact
        AND cc.client_id = v_client
        AND cc.active IS TRUE
    ) THEN
      RAISE EXCEPTION 'Contact does not belong to this client'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

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

-- resubmit: optional contact_id (omit key → keep; null/"" → clear)
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
    v_contact := nullif(btrim(coalesce(v_changes->>'contact_id', '')), '')::uuid;
  ELSE
    v_contact := v_req.contact_id;
  END IF;
  IF v_contact IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.client_contacts cc
      WHERE cc.id = v_contact
        AND cc.client_id = v_client
        AND cc.active IS TRUE
    ) THEN
      IF v_changes ? 'contact_id' THEN
        RAISE EXCEPTION 'Contact does not belong to this client'
          USING ERRCODE = 'check_violation';
      END IF;
      v_contact := NULL;
    END IF;
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

-- -----------------------------------------------------------------------------
-- 7. Duplicate check: also match active contact emails/phones
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.find_client_duplicate_candidates(
  p_email text,
  p_phone text,
  p_name text
)
RETURNS TABLE (
  id text,
  name text,
  company text,
  email text,
  phone text,
  match_on text[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_emails text[] := public.client_email_parts(p_email);
  v_phone text := public.client_normalize_phone(p_phone);
  v_name_key text := lower(
    regexp_replace(
      public.client_sanitize_text(p_name),
      '[^a-zA-Z0-9]+',
      ' ',
      'g'
    )
  );
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    c.name,
    c.company,
    c.email,
    c.phone,
    array_remove(
      ARRAY[
        CASE
          WHEN cardinality(v_emails) > 0
            AND (
              public.client_email_parts(c.email) && v_emails
              OR EXISTS (
                SELECT 1 FROM public.client_contacts cc
                WHERE cc.client_id = c.id
                  AND cc.active IS TRUE
                  AND cc.email IS NOT NULL
                  AND lower(cc.email) = ANY (v_emails)
              )
            )
          THEN 'email'
        END,
        CASE
          WHEN v_phone IS NOT NULL AND (
            public.client_normalize_phone(c.phone) = v_phone
            OR EXISTS (
              SELECT 1 FROM public.client_contacts cc
              WHERE cc.client_id = c.id
                AND cc.active IS TRUE
                AND cc.phone IS NOT NULL
                AND public.client_normalize_phone(cc.phone) = v_phone
            )
          )
          THEN 'phone'
        END,
        CASE
          WHEN v_name_key <> ''
            AND lower(
              regexp_replace(
                public.client_sanitize_text(c.name),
                '[^a-zA-Z0-9]+',
                ' ',
                'g'
              )
            ) = v_name_key
          THEN 'name'
        END
      ],
      NULL
    ) AS match_on
  FROM public.clients AS c
  WHERE (
      (
        cardinality(v_emails) > 0
        AND (
          public.client_email_parts(c.email) && v_emails
          OR EXISTS (
            SELECT 1 FROM public.client_contacts cc
            WHERE cc.client_id = c.id
              AND cc.active IS TRUE
              AND cc.email IS NOT NULL
              AND lower(cc.email) = ANY (v_emails)
          )
        )
      )
      OR (
        v_phone IS NOT NULL AND (
          public.client_normalize_phone(c.phone) = v_phone
          OR EXISTS (
            SELECT 1 FROM public.client_contacts cc
            WHERE cc.client_id = c.id
              AND cc.active IS TRUE
              AND cc.phone IS NOT NULL
              AND public.client_normalize_phone(cc.phone) = v_phone
          )
        )
      )
      OR (
        v_name_key <> ''
        AND lower(
          regexp_replace(
            public.client_sanitize_text(c.name),
            '[^a-zA-Z0-9]+',
            ' ',
            'g'
          )
        ) = v_name_key
      )
    )
    AND array_length(
      array_remove(
        ARRAY[
          CASE
            WHEN cardinality(v_emails) > 0
              AND (
                public.client_email_parts(c.email) && v_emails
                OR EXISTS (
                  SELECT 1 FROM public.client_contacts cc
                  WHERE cc.client_id = c.id
                    AND cc.active IS TRUE
                    AND cc.email IS NOT NULL
                    AND lower(cc.email) = ANY (v_emails)
                )
              )
            THEN 'email'
          END,
          CASE
            WHEN v_phone IS NOT NULL AND (
              public.client_normalize_phone(c.phone) = v_phone
              OR EXISTS (
                SELECT 1 FROM public.client_contacts cc
                WHERE cc.client_id = c.id
                  AND cc.active IS TRUE
                  AND cc.phone IS NOT NULL
                  AND public.client_normalize_phone(cc.phone) = v_phone
              )
            )
            THEN 'phone'
          END,
          CASE
            WHEN v_name_key <> ''
              AND lower(
                regexp_replace(
                  public.client_sanitize_text(c.name),
                  '[^a-zA-Z0-9]+',
                  ' ',
                  'g'
                )
              ) = v_name_key
            THEN 'name'
          END
        ],
        NULL
      ),
      1
    ) >= 1;
END;
$$;

REVOKE ALL ON FUNCTION public.find_client_duplicate_candidates(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.find_client_duplicate_candidates(text, text, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
