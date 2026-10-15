-- NT1b: role-based submit notifications, issue lock, profile-id report recipients.
-- No outer BEGIN/COMMIT (rehearse/apply wrap transactions).

-- -----------------------------------------------------------------------------
-- 1. Submit/resubmit watchers: all active admins; Fortinet also active accounts.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_stock_request_issuers(
  p_request_id uuid,
  p_type text,
  p_title text,
  p_body text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_num text;
  v_title text := p_title;
  v_body text := p_body;
  v_fortinet boolean := false;
BEGIN
  IF p_request_id IS NULL THEN
    RETURN;
  END IF;

  SELECT request_number INTO v_num FROM public.stock_requests WHERE id = p_request_id;
  IF v_num IS NOT NULL THEN
    v_title := v_num || ' · ' || p_title;
    v_body := v_num || ': ' || p_body;
  END IF;

  v_fortinet := public.stock_request_is_all_fortinet(p_request_id);

  INSERT INTO public.notifications (user_id, type, title, body, metadata)
  SELECT
    profile.id,
    p_type,
    v_title,
    v_body,
    jsonb_build_object(
      'request_id', p_request_id::text,
      'request_number', v_num,
      'href', '/requests/' || p_request_id::text || '/fulfill'
    )
  FROM public.profiles AS profile
  WHERE profile.active IS TRUE
    AND profile.id IS DISTINCT FROM auth.uid()
    AND (
      profile.role = 'admin'::public.app_role
      OR (v_fortinet AND profile.role = 'accounts'::public.app_role)
    );
END;
$$;

COMMENT ON FUNCTION public.notify_stock_request_issuers(uuid, text, text, text) IS
  'Notify all active admins on submit/resubmit; Fortinet requests also notify active accounts.';

DROP TRIGGER IF EXISTS tr_app_settings_validate_stock_request_issuers ON public.app_settings;
DROP FUNCTION IF EXISTS public.validate_app_settings_stock_request_issuers();

ALTER TABLE public.app_settings
  DROP COLUMN IF EXISTS stock_request_issuer_recipients_default,
  DROP COLUMN IF EXISTS stock_request_issuer_recipients_fortinet;

-- -----------------------------------------------------------------------------
-- 2. Problem / audit report recipients → profile ids (active only at notify time).
-- -----------------------------------------------------------------------------
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS problem_report_recipient_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS audit_report_recipient_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS problem_report_recipient_migration_skipped text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS audit_report_recipient_migration_skipped text[] NOT NULL DEFAULT '{}'::text[];

DO $migrate_problem$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'app_settings' AND column_name = 'problem_report_recipients'
  ) THEN
    UPDATE public.app_settings AS s
    SET problem_report_recipient_migration_skipped = coalesce(
      (
        SELECT array_agg(DISTINCT lower(btrim(e.email)))
        FROM unnest(s.problem_report_recipients) AS e(email)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.profiles AS p
          WHERE lower(btrim(p.email)) = lower(btrim(e.email))
            AND p.active IS TRUE
        )
      ),
      '{}'::text[]
    )
    WHERE id IS TRUE;

    UPDATE public.app_settings AS s
    SET problem_report_recipient_ids = coalesce(
      (
        SELECT array_agg(DISTINCT p.id)
        FROM unnest(s.problem_report_recipients) AS e(email)
        JOIN public.profiles AS p ON lower(btrim(p.email)) = lower(btrim(e.email))
        WHERE p.active IS TRUE
      ),
      '{}'::uuid[]
    )
    WHERE id IS TRUE;
  END IF;
END;
$migrate_problem$;

DO $migrate_audit$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'app_settings' AND column_name = 'audit_report_recipients'
  ) THEN
    UPDATE public.app_settings AS s
    SET audit_report_recipient_migration_skipped = coalesce(
      (
        SELECT array_agg(DISTINCT lower(btrim(e.email)))
        FROM unnest(s.audit_report_recipients) AS e(email)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.profiles AS p
          WHERE lower(btrim(p.email)) = lower(btrim(e.email))
            AND p.active IS TRUE
        )
      ),
      '{}'::text[]
    )
    WHERE id IS TRUE;

    UPDATE public.app_settings AS s
    SET audit_report_recipient_ids = coalesce(
      (
        SELECT array_agg(DISTINCT p.id)
        FROM unnest(s.audit_report_recipients) AS e(email)
        JOIN public.profiles AS p ON lower(btrim(p.email)) = lower(btrim(e.email))
        WHERE p.active IS TRUE
      ),
      '{}'::uuid[]
    )
    WHERE id IS TRUE;
  END IF;
END;
$migrate_audit$;

DROP TRIGGER IF EXISTS tr_app_settings_validate_problem_recipients ON public.app_settings;
DROP FUNCTION IF EXISTS public.validate_app_settings_problem_recipients();
DROP TRIGGER IF EXISTS tr_app_settings_validate_audit_recipients ON public.app_settings;
DROP FUNCTION IF EXISTS public.validate_app_settings_audit_recipients();

ALTER TABLE public.app_settings
  DROP COLUMN IF EXISTS problem_report_recipients,
  DROP COLUMN IF EXISTS audit_report_recipients;

CREATE OR REPLACE FUNCTION public.validate_app_settings_report_recipient_ids()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  pid uuid;
BEGIN
  FOREACH pid IN ARRAY coalesce(NEW.problem_report_recipient_ids, '{}'::uuid[]) LOOP
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = pid) THEN
      RAISE EXCEPTION 'problem_report_recipient_ids: unknown profile %', pid
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END LOOP;
  FOREACH pid IN ARRAY coalesce(NEW.audit_report_recipient_ids, '{}'::uuid[]) LOOP
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = pid) THEN
      RAISE EXCEPTION 'audit_report_recipient_ids: unknown profile %', pid
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_app_settings_report_recipient_ids() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tr_app_settings_validate_report_recipient_ids ON public.app_settings;
CREATE TRIGGER tr_app_settings_validate_report_recipient_ids
  BEFORE INSERT OR UPDATE OF problem_report_recipient_ids, audit_report_recipient_ids
  ON public.app_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_app_settings_report_recipient_ids();

CREATE OR REPLACE FUNCTION public.notify_problem_report_recipients(
  p_type text,
  p_title text,
  p_body text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ids uuid[];
  v_count integer := 0;
BEGIN
  SELECT coalesce(problem_report_recipient_ids, '{}'::uuid[])
  INTO v_ids
  FROM public.app_settings
  WHERE id IS TRUE;

  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN
    INSERT INTO public.notifications (user_id, type, title, body, metadata)
    SELECT profile.id, p_type, p_title, p_body, coalesce(p_metadata, '{}'::jsonb)
    FROM public.profiles AS profile
    WHERE profile.role = 'admin'::public.app_role AND profile.active IS TRUE;
  ELSE
    INSERT INTO public.notifications (user_id, type, title, body, metadata)
    SELECT profile.id, p_type, p_title, p_body, coalesce(p_metadata, '{}'::jsonb)
    FROM public.profiles AS profile
    WHERE profile.active IS TRUE
      AND profile.id = ANY (v_ids);
  END IF;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_audit_recipients(
  p_type text,
  p_title text,
  p_body text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ids uuid[];
  v_count integer := 0;
BEGIN
  SELECT coalesce(audit_report_recipient_ids, '{}'::uuid[])
  INTO v_ids
  FROM public.app_settings
  WHERE id IS TRUE;

  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN
    INSERT INTO public.notifications (user_id, type, title, body, metadata)
    SELECT profile.id, p_type, p_title, p_body, coalesce(p_metadata, '{}'::jsonb)
    FROM public.profiles AS profile
    WHERE profile.role = 'admin'::public.app_role AND profile.active IS TRUE;
  ELSE
    INSERT INTO public.notifications (user_id, type, title, body, metadata)
    SELECT profile.id, p_type, p_title, p_body, coalesce(p_metadata, '{}'::jsonb)
    FROM public.profiles AS profile
    WHERE profile.active IS TRUE
      AND profile.id = ANY (v_ids);
  END IF;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. Issue lock (scan-to-issue screen).
-- -----------------------------------------------------------------------------
ALTER TABLE public.stock_requests
  ADD COLUMN IF NOT EXISTS issue_lock_user_id uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS issue_lock_since timestamptz;

COMMENT ON COLUMN public.stock_requests.issue_lock_user_id IS
  'Admin/accounts user currently on the fulfill screen; cleared on leave or after issue.';
COMMENT ON COLUMN public.stock_requests.issue_lock_since IS
  'When issue_lock_user_id was set; stale after 3 minutes without touch.';

CREATE OR REPLACE FUNCTION public.stock_request_issue_lock_allowed(p_request_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role public.app_role := public.get_my_role();
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  IF v_role = 'admin'::public.app_role THEN
    RETURN true;
  END IF;
  IF v_role = 'accounts'::public.app_role
     AND public.stock_request_is_all_fortinet(p_request_id) THEN
    RETURN true;
  END IF;
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.stock_request_issue_lock_allowed(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_request_issue_lock_allowed(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.begin_request_issue(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_req public.stock_requests%ROWTYPE;
  v_name text;
  v_holder uuid;
  v_since timestamptz;
BEGIN
  IF NOT public.stock_request_issue_lock_allowed(p_request_id) THEN
    RAISE EXCEPTION 'You cannot issue on this request'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_req FROM public.stock_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request was not found';
  END IF;
  IF v_req.review_state IS DISTINCT FROM 'submitted' THEN
    RAISE EXCEPTION 'Request is not open for issuing'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_req.issue_lock_user_id IS NULL
     OR v_req.issue_lock_user_id = v_uid
     OR v_req.issue_lock_since IS NULL
     OR v_req.issue_lock_since < now() - interval '3 minutes' THEN
    UPDATE public.stock_requests
    SET issue_lock_user_id = v_uid, issue_lock_since = now()
    WHERE id = p_request_id;
  END IF;

  SELECT issue_lock_user_id, issue_lock_since
  INTO v_holder, v_since
  FROM public.stock_requests
  WHERE id = p_request_id;

  SELECT coalesce(nullif(btrim(display_name), ''), nullif(btrim(email), ''), id::text)
  INTO v_name
  FROM public.profiles
  WHERE id = v_holder;

  RETURN jsonb_build_object(
    'user_id', v_holder,
    'since', v_since,
    'display_name', v_name,
    'held_by_me', v_holder = v_uid
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.touch_request_issue(p_request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.stock_requests
  SET issue_lock_since = now()
  WHERE id = p_request_id
    AND issue_lock_user_id = auth.uid();
END;
$$;

CREATE OR REPLACE FUNCTION public.end_request_issue(p_request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.stock_requests
  SET issue_lock_user_id = NULL, issue_lock_since = NULL
  WHERE id = p_request_id
    AND issue_lock_user_id = auth.uid();
END;
$$;

REVOKE ALL ON FUNCTION public.begin_request_issue(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.touch_request_issue(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.end_request_issue(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.begin_request_issue(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.touch_request_issue(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.end_request_issue(uuid) TO authenticated, service_role;

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

  IF position('issue_lock_user_id' IN def) > 0 THEN
    RETURN;
  END IF;

  def := regexp_replace(
    def,
    E'(PERFORM public\\.notify_stock_request\\()',
    E'UPDATE public.stock_requests SET issue_lock_user_id = NULL, issue_lock_since = NULL WHERE id = p_request_id;\n  \\1',
    ''
  );
  EXECUTE def;
END;
$issue$;

NOTIFY pgrst, 'reload schema';
