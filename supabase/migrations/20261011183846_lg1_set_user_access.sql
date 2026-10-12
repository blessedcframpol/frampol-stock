-- LG1 §4: set_user_access — role/active/display_name changes as the signed-in admin.
-- Retires the service-role Users PATCH write path for these fields.
-- No BEGIN/COMMIT: rehearse and apply wrap their own transactions.

CREATE OR REPLACE FUNCTION public.set_user_access(
  p_profile_id uuid,
  p_role public.app_role,
  p_active boolean,
  p_display_name text DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_my_role public.app_role := public.get_my_role();
  v_target public.profiles%ROWTYPE;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  -- NULL display_name arg = leave unchanged; non-null (including '') = set / clear.
  v_set_name boolean := (p_display_name IS NOT NULL);
  v_name text := nullif(btrim(coalesce(p_display_name, '')), '');
BEGIN
  IF v_uid IS NULL OR v_my_role IS DISTINCT FROM 'admin'::public.app_role THEN
    RAISE EXCEPTION 'set_user_access: admin only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_profile_id IS NULL THEN
    RAISE EXCEPTION 'set_user_access: profile id is required'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_role IS NULL THEN
    RAISE EXCEPTION 'set_user_access: a role is required'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_active IS NULL THEN
    RAISE EXCEPTION 'set_user_access: active is required'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_target FROM public.profiles WHERE id = p_profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'set_user_access: profile not found'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF p_profile_id = v_uid
     AND (
       p_role IS DISTINCT FROM v_target.role
       OR p_active IS DISTINCT FROM v_target.active
     )
  THEN
    RAISE EXCEPTION 'set_user_access: you cannot change your own role or active state'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM set_config('app.audit_source', 'set_user_access', true);
  PERFORM set_config('app.audit_reason', coalesce(v_reason, ''), true);

  UPDATE public.profiles
  SET
    role = p_role,
    active = p_active,
    display_name = CASE WHEN v_set_name THEN v_name ELSE display_name END,
    updated_at = now()
  WHERE id = p_profile_id;

  PERFORM set_config('app.audit_source', '', true);
  PERFORM set_config('app.audit_reason', '', true);

  SELECT * INTO v_target FROM public.profiles WHERE id = p_profile_id;

  RETURN jsonb_build_object(
    'id', v_target.id,
    'email', v_target.email,
    'display_name', v_target.display_name,
    'role', v_target.role,
    'active', v_target.active,
    'updated_at', v_target.updated_at
  );
END;
$$;

COMMENT ON FUNCTION public.set_user_access(uuid, public.app_role, boolean, text, text) IS
  'Admin assigns role/active/display_name for another profile. Actor is auth.uid(). Self role/active change refused.';

REVOKE ALL ON FUNCTION public.set_user_access(uuid, public.app_role, boolean, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_user_access(uuid, public.app_role, boolean, text, text)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
