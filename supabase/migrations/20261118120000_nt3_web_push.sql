-- NT3: Web Push subscriptions, profile prefs, pg_net trigger → /api/push/send
SET lock_timeout = '5s';

CREATE EXTENSION IF NOT EXISTS pg_net;

-- ---------------------------------------------------------------------------
-- push_subscriptions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint)
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_id_idx
  ON public.push_subscriptions (user_id);

COMMENT ON TABLE public.push_subscriptions IS
  'NT3: browser Web Push endpoints per user. Ephemeral; deleted on 404/410.';

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS push_subscriptions_select_own ON public.push_subscriptions;
CREATE POLICY push_subscriptions_select_own
  ON public.push_subscriptions FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS push_subscriptions_insert_own ON public.push_subscriptions;
CREATE POLICY push_subscriptions_insert_own
  ON public.push_subscriptions FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS push_subscriptions_update_own ON public.push_subscriptions;
CREATE POLICY push_subscriptions_update_own
  ON public.push_subscriptions FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS push_subscriptions_delete_own ON public.push_subscriptions;
CREATE POLICY push_subscriptions_delete_own
  ON public.push_subscriptions FOR DELETE TO authenticated
  USING (user_id = auth.uid());

REVOKE ALL ON TABLE public.push_subscriptions FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.push_subscriptions TO authenticated;
GRANT ALL ON TABLE public.push_subscriptions TO service_role;

INSERT INTO public.audit_trigger_exclusions (table_name, reason)
SELECT
  'push_subscriptions',
  'NT3 ephemeral browser push endpoints; rotated/deleted on 410; not durable business state'
WHERE NOT EXISTS (
  SELECT 1 FROM public.audit_trigger_exclusions WHERE table_name = 'push_subscriptions'
);

-- ---------------------------------------------------------------------------
-- Profile prefs
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS desktop_push_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS desktop_push_new_requests boolean NOT NULL DEFAULT true;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS desktop_push_reminders boolean NOT NULL DEFAULT true;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS desktop_push_my_request_updated boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.profiles.desktop_push_enabled IS
  'NT3: user opted into desktop OS pop-ups (Web Push).';
COMMENT ON COLUMN public.profiles.desktop_push_new_requests IS
  'NT3: push for request_submitted / request_resubmitted.';
COMMENT ON COLUMN public.profiles.desktop_push_reminders IS
  'NT3: push for request_unclaimed_reminder.';
COMMENT ON COLUMN public.profiles.desktop_push_my_request_updated IS
  'NT3: push for units issued / rejected / cancelled / serviced / closed / atlas restored.';

CREATE OR REPLACE FUNCTION public.update_my_desktop_push_prefs(
  p_enabled boolean,
  p_new_requests boolean,
  p_reminders boolean,
  p_my_request_updated boolean
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
    RAISE EXCEPTION 'update_my_desktop_push_prefs: not authenticated'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.profiles
  SET
    desktop_push_enabled = coalesce(p_enabled, false),
    desktop_push_new_requests = coalesce(p_new_requests, true),
    desktop_push_reminders = coalesce(p_reminders, true),
    desktop_push_my_request_updated = coalesce(p_my_request_updated, true),
    updated_at = now()
  WHERE id = v_uid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'update_my_desktop_push_prefs: profile missing'
      USING ERRCODE = 'P0002';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.update_my_desktop_push_prefs(boolean, boolean, boolean, boolean) IS
  'NT3: signed-in user updates own desktop push prefs.';

REVOKE ALL ON FUNCTION public.update_my_desktop_push_prefs(boolean, boolean, boolean, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_my_desktop_push_prefs(boolean, boolean, boolean, boolean)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- pg_net trigger: never fail / never block the INSERT
-- Vault secret names: push_send_url, push_send_secret
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notifications_enqueue_web_push()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net, vault
AS $$
DECLARE
  v_url text;
  v_secret text;
  v_eligible boolean := false;
BEGIN
  BEGIN
    IF NEW.type IN ('request_submitted', 'request_resubmitted') THEN
      v_eligible := true;
    ELSIF NEW.type = 'request_unclaimed_reminder' THEN
      v_eligible := true;
    ELSIF NEW.type IN (
      'request_units_issued',
      'request_rejected',
      'request_cancelled',
      'request_serviced',
      'request_closed',
      'atlas_link_restored'
    ) THEN
      v_eligible := true;
    END IF;

    IF NOT v_eligible THEN
      RETURN NEW;
    END IF;

    SELECT ds.decrypted_secret INTO v_url
    FROM vault.decrypted_secrets AS ds
    WHERE ds.name = 'push_send_url'
    LIMIT 1;

    SELECT ds.decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets AS ds
    WHERE ds.name = 'push_send_secret'
    LIMIT 1;

    IF v_url IS NULL OR btrim(v_url) = '' OR v_secret IS NULL OR btrim(v_secret) = '' THEN
      RETURN NEW;
    END IF;

    PERFORM net.http_post(
      url := btrim(v_url),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || btrim(v_secret)
      ),
      body := jsonb_build_object('notification_id', NEW.id::text)
    );
  EXCEPTION
    WHEN OTHERS THEN
      -- Never fail or slow the notification insert.
      NULL;
  END;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.notifications_enqueue_web_push() IS
  'NT3: after INSERT on push-eligible notifications, async http_post to /api/push/send. No-op if Vault secrets missing. Errors swallowed.';

DROP TRIGGER IF EXISTS notifications_enqueue_web_push_trg ON public.notifications;
CREATE TRIGGER notifications_enqueue_web_push_trg
  AFTER INSERT ON public.notifications
  FOR EACH ROW
  EXECUTE FUNCTION public.notifications_enqueue_web_push();
