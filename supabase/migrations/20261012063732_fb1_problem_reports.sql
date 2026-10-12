-- FB1: problem reports (PR-YY-NNNN), recipients setting, private screenshots, status RPCs.
-- No BEGIN/COMMIT: rehearse and apply wrap their own transactions.

-- -----------------------------------------------------------------------------
-- 1. Status enum + yearly counter + table
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'problem_report_status'
  ) THEN
    CREATE TYPE public.problem_report_status AS ENUM ('open', 'in_progress', 'resolved');
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.problem_report_number_years (
  year smallint PRIMARY KEY,
  last integer NOT NULL DEFAULT 0 CHECK (last >= 0)
);

COMMENT ON TABLE public.problem_report_number_years IS
  'Per-calendar-year counters for problem_reports.report_number (app timezone).';

ALTER TABLE public.problem_report_number_years ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.problem_report_number_years FROM PUBLIC, anon, authenticated;

INSERT INTO public.audit_trigger_exclusions (table_name, reason)
VALUES ('problem_report_number_years', 'Monotonic problem-report-number counter only')
ON CONFLICT (table_name) DO UPDATE SET reason = EXCLUDED.reason;

CREATE OR REPLACE FUNCTION public.allocate_problem_report_number(
  p_at timestamptz DEFAULT now()
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tz text;
  v_year integer;
  v_yy text;
  v_n integer;
  v_pad integer;
BEGIN
  SELECT coalesce(nullif(btrim(timezone), ''), 'Africa/Harare')
  INTO v_tz
  FROM public.app_settings
  WHERE id IS TRUE;

  v_year := extract(year FROM (p_at AT TIME ZONE v_tz))::integer;
  v_yy := lpad((v_year % 100)::text, 2, '0');

  INSERT INTO public.problem_report_number_years AS y (year, last)
  VALUES (v_year, 1)
  ON CONFLICT (year) DO UPDATE
    SET last = y.last + 1
  RETURNING last INTO v_n;

  v_pad := greatest(4, length(v_n::text));
  RETURN 'PR-' || v_yy || '-' || lpad(v_n::text, v_pad, '0');
END;
$$;

REVOKE ALL ON FUNCTION public.allocate_problem_report_number(timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_problem_report_number(timestamptz) TO service_role;

CREATE TABLE IF NOT EXISTS public.problem_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_number text NOT NULL,
  created_by uuid NOT NULL REFERENCES public.profiles (id),
  what_happened text NOT NULL,
  what_expected text,
  screenshot_path text,
  page_url text NOT NULL,
  reporter_role public.app_role,
  browser text,
  device text,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  status public.problem_report_status NOT NULL DEFAULT 'open',
  resolution_note text,
  resolved_by uuid REFERENCES public.profiles (id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT problem_reports_what_happened_len CHECK (char_length(btrim(what_happened)) BETWEEN 1 AND 4000),
  CONSTRAINT problem_reports_what_expected_len CHECK (
    what_expected IS NULL OR char_length(btrim(what_expected)) <= 4000
  ),
  CONSTRAINT problem_reports_report_number_fmt CHECK (report_number ~ '^PR-[0-9]{2}-[0-9]{4,}$'),
  CONSTRAINT problem_reports_screenshot_path_fmt CHECK (
    screenshot_path IS NULL
    OR screenshot_path ~ '^problem-reports/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$'
  ),
  CONSTRAINT problem_reports_resolved_fields CHECK (
    (status = 'resolved' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
    OR (status IS DISTINCT FROM 'resolved' AND resolved_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS problem_reports_report_number_uidx
  ON public.problem_reports (report_number);

CREATE INDEX IF NOT EXISTS problem_reports_created_by_idx
  ON public.problem_reports (created_by, created_at DESC);

CREATE INDEX IF NOT EXISTS problem_reports_status_created_idx
  ON public.problem_reports (status, created_at DESC);

COMMENT ON TABLE public.problem_reports IS
  'In-app problem reports from signed-in staff. Screenshots are private storage paths only.';

ALTER TABLE public.problem_reports ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.problem_reports FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.problem_reports TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.problem_reports TO service_role;

DROP POLICY IF EXISTS problem_reports_select_own_or_admin ON public.problem_reports;
CREATE POLICY problem_reports_select_own_or_admin
  ON public.problem_reports
  FOR SELECT
  TO authenticated
  USING (
    created_by = auth.uid()
    OR coalesce(public.get_my_role()::text, '') = 'admin'
  );

-- Writes go through SECURITY DEFINER RPCs only.
DROP POLICY IF EXISTS problem_reports_insert_none ON public.problem_reports;
CREATE POLICY problem_reports_insert_none
  ON public.problem_reports
  FOR INSERT
  TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS problem_reports_update_none ON public.problem_reports;
CREATE POLICY problem_reports_update_none
  ON public.problem_reports
  FOR UPDATE
  TO authenticated
  USING (false)
  WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.tr_problem_reports_assign_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.report_number IS NULL OR btrim(NEW.report_number) = '' THEN
    NEW.report_number := public.allocate_problem_report_number(coalesce(NEW.created_at, now()));
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS problem_reports_assign_number ON public.problem_reports;
CREATE TRIGGER problem_reports_assign_number
  BEFORE INSERT ON public.problem_reports
  FOR EACH ROW
  EXECUTE FUNCTION public.tr_problem_reports_assign_number();

CREATE OR REPLACE FUNCTION public.tr_problem_reports_touch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS problem_reports_touch ON public.problem_reports;
CREATE TRIGGER problem_reports_touch
  BEFORE UPDATE ON public.problem_reports
  FOR EACH ROW
  EXECUTE FUNCTION public.tr_problem_reports_touch();

DROP TRIGGER IF EXISTS tr_problem_reports_audit ON public.problem_reports;
CREATE TRIGGER tr_problem_reports_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.problem_reports
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_capture('id');

-- -----------------------------------------------------------------------------
-- 2. Recipients setting (Blessed by default)
-- -----------------------------------------------------------------------------
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS problem_report_recipients text[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN public.app_settings.problem_report_recipients IS
  'Emails notified when a problem report is submitted. Default Blessed.';

CREATE OR REPLACE FUNCTION public.validate_app_settings_problem_recipients()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  recipient text;
BEGIN
  FOREACH recipient IN ARRAY NEW.problem_report_recipients LOOP
    IF recipient IS NULL OR btrim(recipient) = '' OR position('@' IN recipient) = 0 THEN
      RAISE EXCEPTION 'problem_report_recipients: invalid email %', recipient
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_app_settings_problem_recipients()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tr_app_settings_validate_problem_recipients ON public.app_settings;
CREATE TRIGGER tr_app_settings_validate_problem_recipients
  BEFORE INSERT OR UPDATE OF problem_report_recipients
  ON public.app_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_app_settings_problem_recipients();

UPDATE public.app_settings
SET problem_report_recipients = ARRAY['dev4@frampolafrica.com']
WHERE id IS TRUE
  AND (problem_report_recipients IS NULL OR problem_report_recipients = '{}'::text[]);

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
  v_emails text[];
  v_count integer := 0;
BEGIN
  SELECT coalesce(problem_report_recipients, '{}'::text[])
  INTO v_emails
  FROM public.app_settings
  WHERE id IS TRUE;

  IF v_emails IS NULL OR cardinality(v_emails) = 0 THEN
    INSERT INTO public.notifications (user_id, type, title, body, metadata)
    SELECT profile.id, p_type, p_title, p_body, coalesce(p_metadata, '{}'::jsonb)
    FROM public.profiles AS profile
    WHERE profile.role = 'admin' AND profile.active IS TRUE;
  ELSE
    INSERT INTO public.notifications (user_id, type, title, body, metadata)
    SELECT profile.id, p_type, p_title, p_body, coalesce(p_metadata, '{}'::jsonb)
    FROM public.profiles AS profile
    WHERE profile.active IS TRUE
      AND lower(profile.email) = ANY (SELECT lower(unnest(v_emails)));
  END IF;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_problem_report_recipients(text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_problem_report_recipients(text, text, text, jsonb)
  TO service_role;

-- -----------------------------------------------------------------------------
-- 3. Submit + status RPCs
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_problem_report(
  p_what_happened text,
  p_what_expected text DEFAULT NULL,
  p_screenshot_path text DEFAULT NULL,
  p_page_url text DEFAULT NULL,
  p_browser text DEFAULT NULL,
  p_device text DEFAULT NULL,
  p_context jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role public.app_role := public.get_my_role();
  v_happened text := nullif(btrim(coalesce(p_what_happened, '')), '');
  v_expected text := nullif(btrim(coalesce(p_what_expected, '')), '');
  v_path text := nullif(btrim(coalesce(p_screenshot_path, '')), '');
  v_url text := nullif(btrim(coalesce(p_page_url, '')), '');
  v_row public.problem_reports%ROWTYPE;
  v_prefix text;
BEGIN
  IF v_uid IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'submit_problem_report: signed-in staff only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_happened IS NULL THEN
    RAISE EXCEPTION 'submit_problem_report: what happened is required'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_url IS NULL THEN
    RAISE EXCEPTION 'submit_problem_report: page URL is required'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_path IS NOT NULL THEN
    v_prefix := 'problem-reports/' || v_uid::text || '/';
    IF left(v_path, length(v_prefix)) IS DISTINCT FROM v_prefix THEN
      RAISE EXCEPTION 'submit_problem_report: screenshot path must be under your private folder'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  PERFORM set_config('app.audit_source', 'submit_problem_report', true);

  INSERT INTO public.problem_reports (
    created_by,
    what_happened,
    what_expected,
    screenshot_path,
    page_url,
    reporter_role,
    browser,
    device,
    context
  )
  VALUES (
    v_uid,
    v_happened,
    v_expected,
    v_path,
    v_url,
    v_role,
    nullif(btrim(coalesce(p_browser, '')), ''),
    nullif(btrim(coalesce(p_device, '')), ''),
    coalesce(p_context, '{}'::jsonb)
  )
  RETURNING * INTO v_row;

  PERFORM set_config('app.audit_source', '', true);

  PERFORM public.notify_problem_report_recipients(
    'problem_report',
    'New problem report ' || v_row.report_number,
    left(v_happened, 160),
    jsonb_build_object(
      'problem_report_id', v_row.id::text,
      'report_number', v_row.report_number,
      'href', '/problems/' || v_row.id::text
    )
  );

  RETURN jsonb_build_object(
    'id', v_row.id,
    'report_number', v_row.report_number,
    'status', v_row.status,
    'created_at', v_row.created_at
  );
END;
$$;

COMMENT ON FUNCTION public.submit_problem_report(text, text, text, text, text, text, jsonb) IS
  'Any signed-in staff role files a problem report. Screenshot path must be private under their uid.';

REVOKE ALL ON FUNCTION public.submit_problem_report(text, text, text, text, text, text, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_problem_report(text, text, text, text, text, text, jsonb)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.update_problem_report_status(
  p_id uuid,
  p_status public.problem_report_status,
  p_resolution_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role public.app_role := public.get_my_role();
  v_note text := nullif(btrim(coalesce(p_resolution_note, '')), '');
  v_before public.problem_reports%ROWTYPE;
  v_row public.problem_reports%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR v_role IS DISTINCT FROM 'admin'::public.app_role THEN
    RAISE EXCEPTION 'update_problem_report_status: admin only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_id IS NULL OR p_status IS NULL THEN
    RAISE EXCEPTION 'update_problem_report_status: id and status are required'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_before FROM public.problem_reports WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'update_problem_report_status: report not found'
      USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM set_config('app.audit_source', 'update_problem_report_status', true);

  UPDATE public.problem_reports
  SET
    status = p_status,
    resolution_note = CASE
      WHEN p_status = 'resolved'::public.problem_report_status THEN coalesce(v_note, resolution_note)
      WHEN v_note IS NOT NULL THEN v_note
      ELSE resolution_note
    END,
    resolved_by = CASE
      WHEN p_status = 'resolved'::public.problem_report_status THEN v_uid
      ELSE NULL
    END,
    resolved_at = CASE
      WHEN p_status = 'resolved'::public.problem_report_status THEN now()
      ELSE NULL
    END
  WHERE id = p_id
  RETURNING * INTO v_row;

  PERFORM set_config('app.audit_source', '', true);

  IF p_status = 'resolved'::public.problem_report_status
     AND v_before.status IS DISTINCT FROM 'resolved'::public.problem_report_status
  THEN
    INSERT INTO public.notifications (user_id, type, title, body, metadata)
    VALUES (
      v_row.created_by,
      'problem_report_resolved',
      'Problem report ' || v_row.report_number || ' resolved',
      coalesce(v_row.resolution_note, 'Your report was marked resolved.'),
      jsonb_build_object(
        'problem_report_id', v_row.id::text,
        'report_number', v_row.report_number,
        'href', '/problems/' || v_row.id::text
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'id', v_row.id,
    'report_number', v_row.report_number,
    'status', v_row.status,
    'resolution_note', v_row.resolution_note,
    'resolved_by', v_row.resolved_by,
    'resolved_at', v_row.resolved_at,
    'updated_at', v_row.updated_at
  );
END;
$$;

COMMENT ON FUNCTION public.update_problem_report_status(uuid, public.problem_report_status, text) IS
  'Admin sets problem report status. Resolving notifies the reporter.';

REVOKE ALL ON FUNCTION public.update_problem_report_status(uuid, public.problem_report_status, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_problem_report_status(uuid, public.problem_report_status, text)
  TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. Private storage: problem-reports/{uid}/{uuid}.ext
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "uploads insert problem reports" ON storage.objects;
CREATE POLICY "uploads insert problem reports"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'uploads'
    AND (storage.foldername(name))[1] = 'problem-reports'
    AND (storage.foldername(name))[2] = auth.uid()::text
    AND coalesce(public.get_my_role()::text, '') IN (
      'admin', 'sales', 'accounts', 'technicians', 'viewer'
    )
  );

DROP POLICY IF EXISTS "uploads select problem reports" ON storage.objects;
CREATE POLICY "uploads select problem reports"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'uploads'
    AND (storage.foldername(name))[1] = 'problem-reports'
    AND (
      coalesce(public.get_my_role()::text, '') = 'admin'
      OR (storage.foldername(name))[2] = auth.uid()::text
    )
  );

DROP POLICY IF EXISTS "uploads delete problem reports own or admin" ON storage.objects;
CREATE POLICY "uploads delete problem reports own or admin"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'uploads'
    AND (storage.foldername(name))[1] = 'problem-reports'
    AND (
      coalesce(public.get_my_role()::text, '') = 'admin'
      OR (storage.foldername(name))[2] = auth.uid()::text
    )
  );

NOTIFY pgrst, 'reload schema';
