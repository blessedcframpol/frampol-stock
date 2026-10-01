-- Profile creation is trigger-only. Non-admins cannot assign role/active.
-- New sign-ups are active only for allowlisted email domains. Catalog RPC is role-gated.

BEGIN;

-- =============================================================================
-- 1. Signup domain allowlist (single source of truth)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.profile_signup_email_domains (
  email_domain text PRIMARY KEY
);

COMMENT ON TABLE public.profile_signup_email_domains IS
  'Email domains that receive active=true on auth-triggered profile insert. All other domains get active=false.';

ALTER TABLE public.profile_signup_email_domains ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.profile_signup_email_domains FROM PUBLIC;
REVOKE ALL ON TABLE public.profile_signup_email_domains FROM anon, authenticated;

INSERT INTO public.profile_signup_email_domains (email_domain)
VALUES ('frampolafrica.com')
ON CONFLICT (email_domain) DO NOTHING;

CREATE OR REPLACE FUNCTION public.profile_signup_domain_is_allowed(p_email text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profile_signup_email_domains d
    WHERE d.email_domain = lower(split_part(trim(p_email), '@', 2))
  );
$$;

REVOKE ALL ON FUNCTION public.profile_signup_domain_is_allowed(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.profile_signup_domain_is_allowed(text) FROM anon, authenticated;

-- =============================================================================
-- 2. Auth trigger: role NULL; active only for allowlisted domains
-- =============================================================================

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
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM anon, authenticated;

-- Client inserts are not used. Profile rows come from handle_new_user (definer)
-- or service-role admin paths.
DROP POLICY IF EXISTS "Allow insert own profile" ON public.profiles;
REVOKE INSERT ON TABLE public.profiles FROM anon, authenticated;

-- =============================================================================
-- 3. Guard role/active writes (BEFORE profiles_log_access_change)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.tr_profiles_guard_access_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Service role, auth trigger, and other auth.uid()-empty contexts may write.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF (SELECT public.get_my_role()) IS NOT DISTINCT FROM 'admin'::public.app_role THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.role IS NOT NULL THEN
      RAISE EXCEPTION 'profiles: only an admin can assign a role';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role
    OR NEW.active IS DISTINCT FROM OLD.active
  THEN
    RAISE EXCEPTION 'profiles: only an admin can change role or active';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.tr_profiles_guard_access_fields() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tr_profiles_guard_access_fields() FROM anon, authenticated;

DROP TRIGGER IF EXISTS profiles_guard_access_fields ON public.profiles;
CREATE TRIGGER profiles_guard_access_fields
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.tr_profiles_guard_access_fields();

-- =============================================================================
-- 4. ensure_product_line: staff who actually call it from the app
--    (inventory movement / catalog: admin + technicians;
--     stock-request new product names: sales)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.ensure_product_line(p_product_name text, p_vendor text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key text := lower(trim(p_product_name));
  v_norm_vendor text := coalesce(nullif(trim(p_vendor), ''), 'General');
  v_id text;
  v_existing_vendor text;
  v_role public.app_role := public.get_my_role();
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('admin', 'technicians', 'sales') THEN
    RAISE EXCEPTION 'ensure_product_line: not permitted';
  END IF;

  IF v_key = '' THEN
    RAISE EXCEPTION 'ensure_product_line: product name is required';
  END IF;

  SELECT pl.id, pl.vendor
  INTO v_id, v_existing_vendor
  FROM public.product_lines pl
  WHERE lower(trim(pl.product_name)) = v_key
  LIMIT 1;

  IF v_id IS NOT NULL THEN
    IF v_existing_vendor IS DISTINCT FROM v_norm_vendor THEN
      RAISE EXCEPTION 'ensure_product_line: product "%" already exists under vendor "%" (cannot use vendor "%")',
        trim(p_product_name), v_existing_vendor, v_norm_vendor;
    END IF;
    RETURN v_id;
  END IF;

  BEGIN
    v_id := 'PL-' || replace(gen_random_uuid()::text, '-', '');
    INSERT INTO public.product_lines (id, product_name, vendor)
    VALUES (v_id, trim(p_product_name), v_norm_vendor);
    RETURN v_id;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT pl.id, pl.vendor INTO v_id, v_existing_vendor
      FROM public.product_lines pl
      WHERE lower(trim(pl.product_name)) = v_key
      LIMIT 1;
      IF v_id IS NULL THEN
        RAISE;
      END IF;
      IF v_existing_vendor IS DISTINCT FROM v_norm_vendor THEN
        RAISE EXCEPTION 'ensure_product_line: product "%" already exists under vendor "%" (cannot use vendor "%")',
          trim(p_product_name), v_existing_vendor, v_norm_vendor;
      END IF;
      RETURN v_id;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_product_line(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_product_line(text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.ensure_product_line(text, text) TO authenticated, service_role;

COMMIT;
