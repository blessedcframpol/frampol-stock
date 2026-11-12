-- NT2b: add Josh's file-based alert sound to the allowed alert_sound_id set.
-- No outer BEGIN/COMMIT (rehearse/apply wrap transactions).

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_alert_sound_id_chk;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_alert_sound_id_chk
  CHECK (alert_sound_id = ANY (ARRAY[
    'chime'::text,
    'soft_ping'::text,
    'bright_ping'::text,
    'attention'::text,
    'alarm'::text,
    'josh'::text
  ]));

COMMENT ON COLUMN public.profiles.alert_sound_id IS
  'NT2/NT2b: alert preset id (chime, soft_ping, bright_ping, attention, alarm, josh). Default chime; playback off until enabled.';

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
    'chime', 'soft_ping', 'bright_ping', 'attention', 'alarm', 'josh'
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
