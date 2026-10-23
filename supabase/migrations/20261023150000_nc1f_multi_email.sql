-- NC1f — allow 1–5 valid emails per client (semicolon/comma separated).
-- Does not re-apply NC1; replaces email helpers + duplicate email matching only.

SET lock_timeout = '5s';

-- Split on "," / ";" → trimmed lowercased non-empty parts; case-insensitive
-- first-seen order; repeats dropped (silent dedupe for normalisation).
CREATE OR REPLACE FUNCTION public.client_email_parts(p_email text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(
    array_agg(part ORDER BY ord),
    '{}'::text[]
  )
  FROM (
    SELECT
      lower(btrim(part)) AS part,
      min(ord) AS ord
    FROM unnest(
      regexp_split_to_array(
        regexp_replace(btrim(coalesce(p_email, '')), '\s*[;,]+\s*', ',', 'g'),
        ','
      )
    ) WITH ORDINALITY AS t(part, ord)
    WHERE btrim(part) <> ''
    GROUP BY lower(btrim(part))
  ) AS u;
$$;

-- Single-address checks (no separators). Returns problem text or NULL.
CREATE OR REPLACE FUNCTION public.client_one_email_problem(p_email text)
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

CREATE OR REPLACE FUNCTION public.client_email_problem(p_email text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_raw text := btrim(coalesce(p_email, ''));
  v_parts text[];
  v_part text;
  v_problem text;
BEGIN
  IF v_raw = '' THEN
    RETURN 'Email is required';
  END IF;

  -- Parts are already case-insensitively deduped (first-seen order).
  v_parts := public.client_email_parts(v_raw);
  IF cardinality(v_parts) = 0 THEN
    RETURN 'Email is required';
  END IF;
  IF cardinality(v_parts) > 5 THEN
    RETURN 'At most 5 email addresses allowed';
  END IF;

  FOREACH v_part IN ARRAY v_parts
  LOOP
    v_problem := public.client_one_email_problem(v_part);
    IF v_problem IS NOT NULL THEN
      RETURN v_problem || ': ' || v_part;
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

-- Canonical store form: "a@x.com; b@y.com"
CREATE OR REPLACE FUNCTION public.client_normalize_emails(p_email text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT array_to_string(public.client_email_parts(p_email), '; ');
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
    NEW.email := public.client_normalize_emails(NEW.email);
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
      NEW.email := public.client_normalize_emails(NEW.email);
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

-- Duplicate lookup: email match if ANY address overlaps (both sides split).
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
  v_emails text[] := public.client_email_parts(p_email);
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
        CASE
          WHEN cardinality(v_emails) > 0
            AND public.client_email_parts(c.email) && v_emails
          THEN 'email'
        END,
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
      (cardinality(v_emails) > 0 AND public.client_email_parts(c.email) && v_emails)
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
          CASE
            WHEN cardinality(v_emails) > 0
              AND public.client_email_parts(c.email) && v_emails
            THEN 'email'
          END,
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
