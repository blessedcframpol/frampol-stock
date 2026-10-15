-- NT1c — advisory issue lock (fresh-only UI), take-over event, recipient migration report.

-- -----------------------------------------------------------------------------
-- 1. Persist emails that did not map to an active profile during email→uuid migration.
--    (Populated when legacy columns still exist; empty if NT1b already dropped them.)
-- -----------------------------------------------------------------------------
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS problem_report_recipient_migration_skipped text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS audit_report_recipient_migration_skipped text[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN public.app_settings.problem_report_recipient_migration_skipped IS
  'Problem-report recipient emails from pre-uuid migration with no matching active profile.';
COMMENT ON COLUMN public.app_settings.audit_report_recipient_migration_skipped IS
  'Audit-report recipient emails from pre-uuid migration with no matching active profile.';

DO $capture_skipped$
DECLARE
  v_problem text[];
  v_audit text[];
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'app_settings' AND column_name = 'problem_report_recipients'
  ) THEN
    SELECT coalesce(array_agg(DISTINCT lower(btrim(e.email))), '{}'::text[])
    INTO v_problem
    FROM public.app_settings AS s
    CROSS JOIN unnest(s.problem_report_recipients) AS e(email)
    WHERE s.id IS TRUE
      AND NOT EXISTS (
        SELECT 1 FROM public.profiles AS p
        WHERE lower(btrim(p.email)) = lower(btrim(e.email))
          AND p.active IS TRUE
      );

    UPDATE public.app_settings
    SET problem_report_recipient_migration_skipped = v_problem
    WHERE id IS TRUE;

    RAISE NOTICE 'NT1c problem_report_recipient_migration_skipped: %', v_problem;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'app_settings' AND column_name = 'audit_report_recipients'
  ) THEN
    SELECT coalesce(array_agg(DISTINCT lower(btrim(e.email))), '{}'::text[])
    INTO v_audit
    FROM public.app_settings AS s
    CROSS JOIN unnest(s.audit_report_recipients) AS e(email)
    WHERE s.id IS TRUE
      AND NOT EXISTS (
        SELECT 1 FROM public.profiles AS p
        WHERE lower(btrim(p.email)) = lower(btrim(e.email))
          AND p.active IS TRUE
      );

    UPDATE public.app_settings
    SET audit_report_recipient_migration_skipped = v_audit
    WHERE id IS TRUE;

    RAISE NOTICE 'NT1c audit_report_recipient_migration_skipped: %', v_audit;
  END IF;
END;
$capture_skipped$;

-- -----------------------------------------------------------------------------
-- 2. Fresh lock helper + list query (To issue banner).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.stock_request_issue_lock_is_fresh(p_since timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT p_since IS NOT NULL AND p_since > now() - interval '3 minutes';
$$;

COMMENT ON FUNCTION public.stock_request_issue_lock_is_fresh(timestamptz) IS
  'True while issue_lock_since was touched within the last 3 minutes.';

CREATE OR REPLACE FUNCTION public.stock_request_fresh_issue_locks(p_request_ids uuid[])
RETURNS TABLE (
  request_id uuid,
  issue_lock_active_user_id uuid,
  issue_lock_active_since timestamptz
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    sr.id,
    CASE
      WHEN public.stock_request_issue_lock_is_fresh(sr.issue_lock_since) THEN sr.issue_lock_user_id
    END,
    CASE
      WHEN public.stock_request_issue_lock_is_fresh(sr.issue_lock_since) THEN sr.issue_lock_since
    END
  FROM public.stock_requests AS sr
  WHERE sr.id = ANY(p_request_ids);
$$;

REVOKE ALL ON FUNCTION public.stock_request_fresh_issue_locks(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_request_fresh_issue_locks(uuid[]) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. Advisory begin / take-over (issue_units never checks the lock).
-- -----------------------------------------------------------------------------
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
  v_other_fresh boolean;
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

  v_other_fresh :=
    v_req.issue_lock_user_id IS NOT NULL
    AND v_req.issue_lock_user_id IS DISTINCT FROM v_uid
    AND public.stock_request_issue_lock_is_fresh(v_req.issue_lock_since);

  IF NOT v_other_fresh THEN
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
    'held_by_me', v_holder IS NOT DISTINCT FROM v_uid,
    'needs_takeover', v_other_fresh
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.take_over_request_issue(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_req public.stock_requests%ROWTYPE;
  v_previous uuid;
  v_name text;
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

  v_previous := v_req.issue_lock_user_id;

  IF v_previous IS NULL
     OR NOT public.stock_request_issue_lock_is_fresh(v_req.issue_lock_since)
     OR v_previous IS NOT DISTINCT FROM v_uid THEN
    UPDATE public.stock_requests
    SET issue_lock_user_id = v_uid, issue_lock_since = now()
    WHERE id = p_request_id;
  ELSE
    UPDATE public.stock_requests
    SET issue_lock_user_id = v_uid, issue_lock_since = now()
    WHERE id = p_request_id;

    PERFORM public.log_stock_request_event(
      p_request_id,
      'issue_lock_takeover',
      NULL,
      NULL,
      jsonb_build_object('previous_holder_id', v_previous),
      v_uid
    );
  END IF;

  SELECT coalesce(nullif(btrim(display_name), ''), nullif(btrim(email), ''), id::text)
  INTO v_name
  FROM public.profiles
  WHERE id = v_uid;

  RETURN jsonb_build_object(
    'user_id', v_uid,
    'since', now(),
    'display_name', v_name,
    'held_by_me', true,
    'needs_takeover', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.take_over_request_issue(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.take_over_request_issue(uuid) TO authenticated, service_role;

COMMENT ON COLUMN public.stock_requests.issue_lock_user_id IS
  'Advisory: admin/accounts on fulfill screen; hidden in lists when touch is older than 3 minutes.';
COMMENT ON COLUMN public.stock_requests.issue_lock_since IS
  'Last issue-lock touch; fresh for 3 minutes. Client stops touching after 10 minutes idle.';

NOTIFY pgrst, 'reload schema';
