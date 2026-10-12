-- LG1 §1–2: notify admins when a new profile waits for a role; last-sign-in helper for Users page.
-- No BEGIN/COMMIT.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  meta jsonb := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb);
  dn text;
  user_email text;
  v_id uuid;
  v_active boolean;
  v_label text;
BEGIN
  user_email := COALESCE(
    NULLIF(trim(NEW.email), ''),
    NULLIF(trim(meta->>'email'), ''),
    NULLIF(trim(meta->>'preferred_username'), ''),
    NULLIF(trim(meta #>> '{identities,0,identity_data,email}'), '')
  );

  IF user_email IS NULL OR user_email = '' THEN
    user_email := NEW.id::text || '@oauth.placeholder.local';
  END IF;

  dn := COALESCE(
    NULLIF(trim(meta->>'display_name'), ''),
    NULLIF(trim(meta->>'full_name'), ''),
    NULLIF(trim(meta->>'name'), ''),
    NULLIF(trim(meta->>'given_name'), '') || CASE
      WHEN NULLIF(trim(meta->>'family_name'), '') IS NOT NULL
      THEN ' ' || trim(meta->>'family_name')
      ELSE ''
    END
  );

  INSERT INTO public.profiles (id, email, display_name, role, active)
  VALUES (
    NEW.id,
    user_email,
    NULLIF(trim(dn), ''),
    NULL,
    public.profile_signup_domain_is_allowed(user_email)
  )
  ON CONFLICT (id) DO NOTHING
  RETURNING id, active INTO v_id, v_active;

  -- New active profile with no role → admins assign access on Users.
  IF v_id IS NOT NULL AND v_active IS TRUE THEN
    v_label := coalesce(nullif(trim(dn), ''), user_email);
    INSERT INTO public.notifications (user_id, type, title, body, metadata)
    SELECT
      profile.id,
      'pending_role',
      'New user waiting for a role',
      v_label || ' signed in and needs a role assigned.',
      jsonb_build_object(
        'profile_id', v_id::text,
        'href', '/users?user=' || v_id::text
      )
    FROM public.profiles AS profile
    WHERE profile.role = 'admin'
      AND profile.active IS TRUE
      AND profile.id IS DISTINCT FROM v_id;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.profile_last_sign_ins()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF coalesce(public.get_my_role()::text, '') NOT IN ('admin', 'viewer') THEN
    RAISE EXCEPTION 'profile_last_sign_ins: admin or Admin viewer only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN (
    SELECT coalesce(jsonb_object_agg(entry.actor, entry.at), '{}'::jsonb)
    FROM (
      SELECT DISTINCT ON (log.actor)
        log.actor,
        log.at
      FROM public.audit_log AS log
      WHERE log.action = 'sign_in'
      ORDER BY log.actor, log.at DESC
    ) AS entry
  );
END;
$$;

COMMENT ON FUNCTION public.profile_last_sign_ins() IS
  'Map of profile id → last audit_log sign_in timestamp for the Users page.';

REVOKE ALL ON FUNCTION public.profile_last_sign_ins() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.profile_last_sign_ins() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
