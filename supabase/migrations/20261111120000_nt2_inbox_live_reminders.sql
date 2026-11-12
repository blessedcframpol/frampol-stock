-- NT2: inbox live updates + unclaimed-request reminders + per-user alert sounds.
-- No outer BEGIN/COMMIT (rehearse/apply wrap transactions).

-- -----------------------------------------------------------------------------
-- 1. app_settings — reminder interval / max / optional admin recipient override
-- -----------------------------------------------------------------------------
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS unclaimed_request_reminder_interval_minutes integer NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS unclaimed_request_reminder_max_count integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS unclaimed_request_reminder_recipient_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS unclaimed_reminders_live_from timestamptz;

-- Go-live cutoff: set once when the column is first added (migration time).
UPDATE public.app_settings
SET unclaimed_reminders_live_from = coalesce(unclaimed_reminders_live_from, now())
WHERE id IS TRUE;

ALTER TABLE public.app_settings
  ALTER COLUMN unclaimed_reminders_live_from SET DEFAULT now(),
  ALTER COLUMN unclaimed_reminders_live_from SET NOT NULL;

COMMENT ON COLUMN public.app_settings.unclaimed_request_reminder_interval_minutes IS
  'NT2: minutes between unclaimed-request reminder pings (default 15).';
COMMENT ON COLUMN public.app_settings.unclaimed_request_reminder_max_count IS
  'NT2: max reminder pings per request (default 3).';
COMMENT ON COLUMN public.app_settings.unclaimed_request_reminder_recipient_ids IS
  'NT2: optional active-admin override for reminders only. Empty → usual issuer set.';
COMMENT ON COLUMN public.app_settings.unclaimed_reminders_live_from IS
  'NT2: only requests with created_at >= this timestamp get unclaimed reminders. Set by migration to now(); change only via migration/admin SQL — not the Settings UI.';

ALTER TABLE public.app_settings
  DROP CONSTRAINT IF EXISTS app_settings_unclaimed_reminder_interval_chk;
ALTER TABLE public.app_settings
  ADD CONSTRAINT app_settings_unclaimed_reminder_interval_chk
  CHECK (unclaimed_request_reminder_interval_minutes BETWEEN 1 AND 24 * 60);

ALTER TABLE public.app_settings
  DROP CONSTRAINT IF EXISTS app_settings_unclaimed_reminder_max_chk;
ALTER TABLE public.app_settings
  ADD CONSTRAINT app_settings_unclaimed_reminder_max_chk
  CHECK (unclaimed_request_reminder_max_count BETWEEN 1 AND 50);

CREATE OR REPLACE FUNCTION public.validate_app_settings_unclaimed_reminder_recipients()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  pid uuid;
BEGIN
  FOREACH pid IN ARRAY coalesce(NEW.unclaimed_request_reminder_recipient_ids, '{}'::uuid[]) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles AS p
      WHERE p.id = pid
        AND p.active IS TRUE
        AND p.role = 'admin'::public.app_role
    ) THEN
      RAISE EXCEPTION
        'unclaimed_request_reminder_recipient_ids: % must be an active admin',
        pid
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_app_settings_unclaimed_reminder_recipients()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tr_app_settings_validate_unclaimed_reminder_recipients ON public.app_settings;
CREATE TRIGGER tr_app_settings_validate_unclaimed_reminder_recipients
  BEFORE INSERT OR UPDATE OF unclaimed_request_reminder_recipient_ids
  ON public.app_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_app_settings_unclaimed_reminder_recipients();

-- -----------------------------------------------------------------------------
-- 2. profiles — per-user alert sound prefs (default OFF)
-- -----------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS alert_sound_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS alert_sound_id text NOT NULL DEFAULT 'chime',
  ADD COLUMN IF NOT EXISTS alert_sound_volume numeric(4, 3) NOT NULL DEFAULT 0.550;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_alert_sound_id_chk;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_alert_sound_id_chk
  CHECK (alert_sound_id = ANY (ARRAY[
    'chime'::text,
    'soft_ping'::text,
    'bright_ping'::text,
    'attention'::text,
    'alarm'::text
  ]));

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_alert_sound_volume_chk;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_alert_sound_volume_chk
  CHECK (alert_sound_volume >= 0 AND alert_sound_volume <= 1);

COMMENT ON COLUMN public.profiles.alert_sound_enabled IS
  'NT2: play Web Audio alert for new-request (issuers) and reminder pings. Default off.';
COMMENT ON COLUMN public.profiles.alert_sound_id IS
  'NT2: Web Audio preset id (chime, soft_ping, bright_ping, attention, alarm).';
COMMENT ON COLUMN public.profiles.alert_sound_volume IS
  'NT2: 0–1 gain for alert sound.';

CREATE OR REPLACE FUNCTION public.update_my_alert_sound_prefs(
  p_enabled boolean,
  p_sound_id text,
  p_volume numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'update_my_alert_sound_prefs: not authenticated'
      USING ERRCODE = '42501';
  END IF;
  IF p_sound_id IS NULL OR p_sound_id NOT IN (
    'chime', 'soft_ping', 'bright_ping', 'attention', 'alarm'
  ) THEN
    RAISE EXCEPTION 'update_my_alert_sound_prefs: invalid sound_id %', p_sound_id
      USING ERRCODE = '22023';
  END IF;
  IF p_volume IS NULL OR p_volume < 0 OR p_volume > 1 THEN
    RAISE EXCEPTION 'update_my_alert_sound_prefs: volume must be 0–1'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.profiles
  SET
    alert_sound_enabled = coalesce(p_enabled, false),
    alert_sound_id = p_sound_id,
    alert_sound_volume = round(p_volume::numeric, 3),
    updated_at = now()
  WHERE id = v_uid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'update_my_alert_sound_prefs: profile missing'
      USING ERRCODE = 'P0002';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.update_my_alert_sound_prefs(boolean, text, numeric) IS
  'NT2: signed-in user updates own alert-sound prefs (admin UPDATE policy bypass).';

REVOKE ALL ON FUNCTION public.update_my_alert_sound_prefs(boolean, text, numeric)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_my_alert_sound_prefs(boolean, text, numeric)
  TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. request_reminders — reminder state (not on stock_requests; AU1 exclusion)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.request_reminders (
  request_id uuid PRIMARY KEY REFERENCES public.stock_requests (id) ON DELETE CASCADE,
  sent_count integer NOT NULL DEFAULT 0
    CONSTRAINT request_reminders_sent_count_chk CHECK (sent_count >= 0),
  last_sent_at timestamptz,
  stopped_at timestamptz,
  stop_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.request_reminders IS
  'NT2: unclaimed-request reminder counters. Separate from stock_requests so AU1 is not spammed.';

INSERT INTO public.audit_trigger_exclusions (table_name, reason) VALUES
  (
    'request_reminders',
    'NT2 reminder counters updated by pg_cron every 5 minutes; not durable business state'
  )
ON CONFLICT (table_name) DO UPDATE SET reason = EXCLUDED.reason;

REVOKE ALL ON TABLE public.request_reminders FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.request_reminders TO authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE public.request_reminders TO service_role;

ALTER TABLE public.request_reminders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS request_reminders_select_staff ON public.request_reminders;
CREATE POLICY request_reminders_select_staff
  ON public.request_reminders
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles AS p
      WHERE p.id = auth.uid()
        AND p.active IS TRUE
        AND p.role IN (
          'admin'::public.app_role,
          'accounts'::public.app_role,
          'viewer'::public.app_role
        )
    )
  );

CREATE OR REPLACE FUNCTION public.request_reminders_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.request_reminders_touch_updated_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tr_request_reminders_touch ON public.request_reminders;
CREATE TRIGGER tr_request_reminders_touch
  BEFORE UPDATE ON public.request_reminders
  FOR EACH ROW
  EXECUTE FUNCTION public.request_reminders_touch_updated_at();

-- Permanent stop when review_state changes away from the original submitted value.
CREATE OR REPLACE FUNCTION public.stock_requests_stop_unclaimed_reminders()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.review_state IS DISTINCT FROM NEW.review_state
  THEN
    INSERT INTO public.request_reminders (request_id, sent_count, stopped_at, stop_reason)
    VALUES (NEW.id, 0, now(), 'status_change')
    ON CONFLICT (request_id) DO UPDATE
    SET
      stopped_at = coalesce(public.request_reminders.stopped_at, now()),
      stop_reason = coalesce(public.request_reminders.stop_reason, 'status_change'),
      updated_at = now();
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.stock_requests_stop_unclaimed_reminders()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tr_stock_requests_stop_unclaimed_reminders ON public.stock_requests;
CREATE TRIGGER tr_stock_requests_stop_unclaimed_reminders
  AFTER UPDATE OF review_state ON public.stock_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.stock_requests_stop_unclaimed_reminders();

-- -----------------------------------------------------------------------------
-- 4. Realtime — stock_requests (RLS-scoped) for live queues
-- -----------------------------------------------------------------------------
DO $realtime$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'stock_requests'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.stock_requests;
    END IF;
  END IF;
END;
$realtime$;

-- -----------------------------------------------------------------------------
-- 5. Reminder cron function
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_unclaimed_request_reminders(
  p_as_of timestamptz DEFAULT now()
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET lock_timeout = '5s'
AS $$
DECLARE
  v_tz text;
  v_local timestamp;
  v_dow integer;
  v_tod time;
  v_interval_min integer;
  v_max integer;
  v_override uuid[];
  v_live_from timestamptz;
  v_n integer := 0;
  r record;
  v_recipient uuid;
  v_fortinet boolean;
  v_title text;
  v_body text;
  v_lock_key bigint := hashtext('notify_unclaimed_request_reminders');
BEGIN
  -- Overlap guard: concurrent runs exit instead of double-sending.
  IF NOT pg_try_advisory_xact_lock(v_lock_key) THEN
    RETURN 0;
  END IF;

  SELECT
    coalesce(nullif(btrim(s.timezone), ''), 'Africa/Harare'),
    s.unclaimed_request_reminder_interval_minutes,
    s.unclaimed_request_reminder_max_count,
    coalesce(s.unclaimed_request_reminder_recipient_ids, '{}'::uuid[]),
    s.unclaimed_reminders_live_from
  INTO v_tz, v_interval_min, v_max, v_override, v_live_from
  FROM public.app_settings AS s
  WHERE s.id IS TRUE;

  v_local := (p_as_of AT TIME ZONE v_tz);
  v_dow := extract(isodow FROM v_local)::integer;
  v_tod := v_local::time;

  -- Mon–Fri 07:30–17:30 Africa/Harare (timezone from app_settings).
  IF v_dow > 5 OR v_tod < time '07:30' OR v_tod >= time '17:30' THEN
    RETURN 0;
  END IF;

  FOR r IN
    SELECT
      sr.id,
      sr.request_number,
      sr.created_by,
      sr.created_at,
      rr.sent_count,
      rr.last_sent_at,
      rr.stopped_at
    FROM public.stock_requests AS sr
    LEFT JOIN public.request_reminders AS rr ON rr.request_id = sr.id
    WHERE sr.review_state = 'submitted'
      AND sr.created_at >= v_live_from
      AND public.request_display_status(sr) = 'being_reviewed'
      AND rr.stopped_at IS NULL
      AND coalesce(rr.sent_count, 0) < v_max
      AND NOT public.stock_request_issue_lock_is_fresh(sr.issue_lock_since)
      AND (
        (
          rr.last_sent_at IS NULL
          AND sr.created_at + make_interval(mins => v_interval_min) <= p_as_of
        )
        OR (
          rr.last_sent_at IS NOT NULL
          AND rr.last_sent_at + make_interval(mins => v_interval_min) <= p_as_of
        )
      )
    ORDER BY sr.created_at ASC
  LOOP
    v_fortinet := public.stock_request_is_all_fortinet(r.id);
    v_title := coalesce(r.request_number, 'Request') || ' · Still waiting to be issued';
    v_body := coalesce(r.request_number, 'Request')
      || ': still unclaimed. Open To issue to take it.';

    IF cardinality(v_override) > 0 THEN
      FOR v_recipient IN
        SELECT p.id
        FROM public.profiles AS p
        WHERE p.active IS TRUE
          AND p.role = 'admin'::public.app_role
          AND p.id = ANY (v_override)
          AND p.id IS DISTINCT FROM r.created_by
      LOOP
        INSERT INTO public.notifications (user_id, type, title, body, metadata)
        VALUES (
          v_recipient,
          'request_unclaimed_reminder',
          v_title,
          v_body,
          jsonb_build_object(
            'request_id', r.id::text,
            'request_number', r.request_number,
            'href', '/requests/' || r.id::text || '/fulfill',
            'reminder', true
          )
        );
      END LOOP;
    ELSE
      FOR v_recipient IN
        SELECT p.id
        FROM public.profiles AS p
        WHERE p.active IS TRUE
          AND p.id IS DISTINCT FROM r.created_by
          AND (
            p.role = 'admin'::public.app_role
            OR (v_fortinet AND p.role = 'accounts'::public.app_role)
          )
      LOOP
        INSERT INTO public.notifications (user_id, type, title, body, metadata)
        VALUES (
          v_recipient,
          'request_unclaimed_reminder',
          v_title,
          v_body,
          jsonb_build_object(
            'request_id', r.id::text,
            'request_number', r.request_number,
            'href', '/requests/' || r.id::text || '/fulfill',
            'reminder', true
          )
        );
      END LOOP;
    END IF;

    INSERT INTO public.request_reminders (request_id, sent_count, last_sent_at)
    VALUES (r.id, 1, p_as_of)
    ON CONFLICT (request_id) DO UPDATE
    SET
      sent_count = public.request_reminders.sent_count + 1,
      last_sent_at = p_as_of,
      updated_at = now()
    WHERE public.request_reminders.stopped_at IS NULL;

    v_n := v_n + 1;
  END LOOP;

  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION public.notify_unclaimed_request_reminders(timestamptz) IS
  'NT2: pg_cron every 5 min. Reminds issuers of unclaimed requests whose display status is '
  'being_reviewed (via request_display_status), created_at >= unclaimed_reminders_live_from, '
  'no fresh issue lock. Mon–Fri 07:30–17:30 app timezone. Optional recipient override in app_settings.';

REVOKE ALL ON FUNCTION public.notify_unclaimed_request_reminders(timestamptz)
  FROM PUBLIC, anon, authenticated;
-- Cron runs as postgres / database owner; service_role kept for harness calls.
GRANT EXECUTE ON FUNCTION public.notify_unclaimed_request_reminders(timestamptz)
  TO postgres, service_role;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'nt2-unclaimed-request-reminders') THEN
      PERFORM cron.unschedule('nt2-unclaimed-request-reminders');
    END IF;
    PERFORM cron.schedule(
      'nt2-unclaimed-request-reminders',
      '*/5 * * * *',
      $job$SELECT public.notify_unclaimed_request_reminders()$job$
    );
  ELSE
    RAISE WARNING 'NT2: pg_cron missing — schedule nt2-unclaimed-request-reminders manually after enabling the extension.';
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'NT2 pg_cron schedule skipped (%). Function is ready.', SQLERRM;
END;
$cron$;
