-- NC1 — new clients must be complete; existing rows editable field-by-field on UPDATE.

SET lock_timeout = '5s';

ALTER TABLE public.clients
  ALTER COLUMN company DROP NOT NULL;

COMMENT ON COLUMN public.clients.company IS
  'Legal company name when the client is a company; NULL for individuals (never a copy of the person name).';

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS duplicate_override_reason text;

COMMENT ON COLUMN public.clients.duplicate_override_reason IS
  'Admin-only reason when creating despite a possible duplicate match; NULL for normal creates; immutable after insert.';

-- -----------------------------------------------------------------------------
-- Shared validation (mirrors lib/client-complete.ts)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.client_sanitize_text(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT btrim(
    regexp_replace(
      regexp_replace(coalesce(p_value, ''), '^[\s.,;:/\\\-–—]+', '', 'g'),
      '[\s.,;:/\\\-–—]+$',
      '',
      'g'
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.client_is_placeholder(p_value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    v = ''
    OR v ~* '^(n/a|na|n\.a\.?|none|null|nil|tbd|tbc|\?+|\.+|,+|\/+|\\+|—|-+|0+|000+)$'
    OR regexp_replace(v, '\s', '', 'g') ~ '^0+$'
  FROM (SELECT lower(public.client_sanitize_text(p_value)) AS v) AS s;
$$;

CREATE OR REPLACE FUNCTION public.client_normalize_phone(p_value text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_trim text := btrim(coalesce(p_value, ''));
  v_digits text;
  v_national text;
BEGIN
  IF v_trim = '' THEN
    RETURN NULL;
  END IF;

  IF left(v_trim, 1) = '+' THEN
    v_digits := regexp_replace(substring(v_trim FROM 2), '\D', '', 'g');
    IF length(v_digits) < 10 OR length(v_digits) > 15 THEN
      RETURN NULL;
    END IF;
    IF v_digits ~ '^0+$' THEN
      RETURN NULL;
    END IF;
    RETURN '+' || v_digits;
  END IF;

  v_digits := regexp_replace(v_trim, '\D', '', 'g');
  IF v_digits = '' THEN
    RETURN NULL;
  END IF;

  IF v_digits LIKE '263%' THEN
    v_national := substring(v_digits FROM 4);
    IF length(v_national) >= 9 AND length(v_national) <= 10 AND v_national !~ '^0+$' THEN
      RETURN '+263' || v_national;
    END IF;
    RETURN NULL;
  END IF;

  IF v_digits LIKE '0%' THEN
    v_national := substring(v_digits FROM 2);
    IF length(v_national) >= 9 AND length(v_national) <= 10 AND v_national !~ '^0+$' THEN
      RETURN '+263' || v_national;
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.client_email_problem(p_email text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_raw text := btrim(coalesce(p_email, ''));
  v_at int;
BEGIN
  IF v_raw = '' THEN
    RETURN 'Email is required';
  END IF;
  IF position(';' IN v_raw) > 0 OR position(',' IN v_raw) > 0 THEN
    RETURN 'Use one email address only';
  END IF;
  IF public.client_is_placeholder(v_raw) THEN
    RETURN 'Email cannot be a placeholder';
  END IF;
  IF position(' ' IN v_raw) > 0 THEN
    RETURN 'Email cannot contain spaces';
  END IF;
  v_at := position('@' IN v_raw);
  IF v_at <= 1 OR v_at = length(v_raw) THEN
    RETURN 'Enter a valid email address';
  END IF;
  IF position('.' IN substring(v_raw FROM v_at + 1)) = 0 THEN
    RETURN 'Enter a valid email address';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.client_phone_problem(p_phone text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_norm text;
BEGIN
  IF btrim(coalesce(p_phone, '')) = '' THEN
    RETURN 'Phone is required';
  END IF;
  IF public.client_is_placeholder(p_phone) THEN
    RETURN 'Phone cannot be a placeholder';
  END IF;
  v_norm := public.client_normalize_phone(p_phone);
  IF v_norm IS NULL THEN
    RETURN 'Enter a valid phone number (e.g. 077 123 4567, +27 82 123 4567, or +260 97 123 4567)';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.client_site_address_problem(p_address text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v text := public.client_sanitize_text(p_address);
BEGIN
  IF v = '' THEN
    RETURN 'Physical address is required';
  END IF;
  IF public.client_is_placeholder(v) THEN
    RETURN 'Address cannot be a placeholder';
  END IF;
  IF char_length(v) < 5 THEN
    RETURN 'Enter a fuller physical address';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.client_sites_have_valid_primary(p_sites jsonb, p_address text)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_elem jsonb;
  v_addr text;
  v_problem text;
  v_found boolean := false;
BEGIN
  IF p_sites IS NOT NULL AND jsonb_typeof(p_sites) = 'array' THEN
    FOR v_elem IN SELECT value FROM jsonb_array_elements(p_sites)
    LOOP
      v_addr := public.client_sanitize_text(v_elem->>'address');
      IF v_addr <> '' THEN
        v_found := true;
        v_problem := public.client_site_address_problem(v_addr);
        IF v_problem IS NOT NULL THEN
          RETURN v_problem;
        END IF;
      END IF;
    END LOOP;
  END IF;
  IF NOT v_found THEN
    v_addr := public.client_sanitize_text(p_address);
    IF v_addr = '' THEN
      RETURN 'At least one physical address is required';
    END IF;
    RETURN public.client_site_address_problem(v_addr);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.clients_validate_insert_row(p_row public.clients)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_problem text;
  v_company text := nullif(public.client_sanitize_text(p_row.company), '');
  v_name text := public.client_sanitize_text(p_row.name);
BEGIN
  IF v_name = '' OR public.client_is_placeholder(v_name) THEN
    RAISE EXCEPTION 'Name is required and cannot be a placeholder'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_company IS NOT NULL THEN
    IF public.client_is_placeholder(v_company) THEN
      RAISE EXCEPTION 'Company name cannot be a placeholder'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  v_problem := public.client_email_problem(p_row.email);
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION '%', v_problem USING ERRCODE = 'check_violation';
  END IF;

  v_problem := public.client_phone_problem(p_row.phone);
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION '%', v_problem USING ERRCODE = 'check_violation';
  END IF;

  v_problem := public.client_sites_have_valid_primary(p_row.sites, p_row.address);
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION '%', v_problem USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.clients_validate_update_fields(
  p_old public.clients,
  p_new public.clients
)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_problem text;
  v_company text;
BEGIN
  IF p_new.name IS DISTINCT FROM p_old.name THEN
    IF public.client_sanitize_text(p_new.name) = '' OR public.client_is_placeholder(p_new.name) THEN
      RAISE EXCEPTION 'Name cannot be empty or a placeholder'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF p_new.company IS DISTINCT FROM p_old.company THEN
    v_company := nullif(public.client_sanitize_text(p_new.company), '');
    IF v_company IS NOT NULL AND public.client_is_placeholder(v_company) THEN
      RAISE EXCEPTION 'Company name cannot be a placeholder'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF p_new.email IS DISTINCT FROM p_old.email THEN
    v_problem := public.client_email_problem(p_new.email);
    IF v_problem IS NOT NULL THEN
      RAISE EXCEPTION '%', v_problem USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF p_new.phone IS DISTINCT FROM p_old.phone THEN
    v_problem := public.client_phone_problem(p_new.phone);
    IF v_problem IS NOT NULL THEN
      RAISE EXCEPTION '%', v_problem USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF p_new.sites IS DISTINCT FROM p_old.sites OR p_new.address IS DISTINCT FROM p_old.address THEN
    v_problem := public.client_sites_have_valid_primary(p_new.sites, p_new.address);
    IF v_problem IS NOT NULL THEN
      RAISE EXCEPTION '%', v_problem USING ERRCODE = 'check_violation';
    END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.clients_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_norm_phone text;
BEGIN
  IF NEW.company IS NOT NULL AND btrim(NEW.company) = '' THEN
    NEW.company := NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_norm_phone := public.client_normalize_phone(NEW.phone);
    IF v_norm_phone IS NOT NULL THEN
      NEW.phone := v_norm_phone;
    END IF;
    NEW.email := lower(btrim(NEW.email));
    NEW.name := public.client_sanitize_text(NEW.name);
    IF NEW.company IS NOT NULL THEN
      NEW.company := public.client_sanitize_text(NEW.company);
    END IF;
    IF NEW.duplicate_override_reason IS NOT NULL THEN
      NEW.duplicate_override_reason := btrim(NEW.duplicate_override_reason);
      IF NEW.duplicate_override_reason = '' THEN
        NEW.duplicate_override_reason := NULL;
      ELSIF char_length(NEW.duplicate_override_reason) < 10 THEN
        RAISE EXCEPTION 'Duplicate override reason must be at least 10 characters'
          USING ERRCODE = 'check_violation';
      ELSIF (SELECT public.get_my_role()) IS DISTINCT FROM 'admin' THEN
        RAISE EXCEPTION 'Only an admin can set a duplicate override reason'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    PERFORM public.clients_validate_insert_row(NEW);
  ELSIF TG_OP = 'UPDATE' THEN
    -- Immutable after insert (simpler than admin-only UPDATE).
    IF NEW.duplicate_override_reason IS DISTINCT FROM OLD.duplicate_override_reason THEN
      RAISE EXCEPTION 'duplicate_override_reason cannot be changed after create'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.phone IS DISTINCT FROM OLD.phone THEN
      v_norm_phone := public.client_normalize_phone(NEW.phone);
      IF v_norm_phone IS NOT NULL THEN
        NEW.phone := v_norm_phone;
      END IF;
    END IF;
    IF NEW.email IS DISTINCT FROM OLD.email THEN
      NEW.email := lower(btrim(NEW.email));
    END IF;
    IF NEW.name IS DISTINCT FROM OLD.name THEN
      NEW.name := public.client_sanitize_text(NEW.name);
    END IF;
    IF NEW.company IS DISTINCT FROM OLD.company AND NEW.company IS NOT NULL THEN
      NEW.company := public.client_sanitize_text(NEW.company);
    END IF;
    PERFORM public.clients_validate_update_fields(OLD, NEW);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_clients_nc1_validate ON public.clients;
CREATE TRIGGER tr_clients_nc1_validate
  BEFORE INSERT OR UPDATE ON public.clients
  FOR EACH ROW
  EXECUTE FUNCTION public.clients_before_write();

-- Duplicate lookup (warning UI; not a hard block)
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
  v_email text := lower(btrim(coalesce(p_email, '')));
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
        CASE WHEN v_email <> '' AND lower(btrim(c.email)) = v_email THEN 'email' END,
        CASE WHEN v_phone IS NOT NULL AND public.client_normalize_phone(c.phone) = v_phone THEN 'phone' END,
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
      (v_email <> '' AND lower(btrim(c.email)) = v_email)
      OR (v_phone IS NOT NULL AND public.client_normalize_phone(c.phone) = v_phone)
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
          CASE WHEN v_email <> '' AND lower(btrim(c.email)) = v_email THEN 'email' END,
          CASE WHEN v_phone IS NOT NULL AND public.client_normalize_phone(c.phone) = v_phone THEN 'phone' END,
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
