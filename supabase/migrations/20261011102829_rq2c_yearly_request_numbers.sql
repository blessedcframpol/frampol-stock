-- RQ2c: yearly request numbers REQ-YY-NNNN (Africa/Harare year; per-year counter).

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Per-year counter (atomic allocate)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stock_request_number_years (
  year smallint PRIMARY KEY,
  last integer NOT NULL DEFAULT 0 CHECK (last >= 0)
);

COMMENT ON TABLE public.stock_request_number_years IS
  'Per-calendar-year counters for stock_requests.request_number (Africa/Harare).';

ALTER TABLE public.stock_request_number_years ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.stock_request_number_years FROM PUBLIC, anon, authenticated;
-- Only SECURITY DEFINER allocators touch this table.

CREATE OR REPLACE FUNCTION public.allocate_stock_request_number(
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

  INSERT INTO public.stock_request_number_years AS y (year, last)
  VALUES (v_year, 1)
  ON CONFLICT (year) DO UPDATE
    SET last = y.last + 1
  RETURNING last INTO v_n;

  v_pad := greatest(4, length(v_n::text));
  RETURN 'REQ-' || v_yy || '-' || lpad(v_n::text, v_pad, '0');
END;
$$;

REVOKE ALL ON FUNCTION public.allocate_stock_request_number(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_stock_request_number(timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.tr_stock_requests_assign_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.request_number IS NULL OR btrim(NEW.request_number) = '' THEN
    NEW.request_number := public.allocate_stock_request_number(
      coalesce(NEW.submitted_at, NEW.created_at, now())
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stock_requests_assign_number ON public.stock_requests;
CREATE TRIGGER stock_requests_assign_number
  BEFORE INSERT ON public.stock_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.tr_stock_requests_assign_number();

-- -----------------------------------------------------------------------------
-- 2. Renumber existing rows to REQ-26-NNNN; retire old sequence
-- -----------------------------------------------------------------------------
ALTER TABLE public.stock_requests
  DROP CONSTRAINT IF EXISTS stock_requests_request_number_key;

WITH ordered AS (
  SELECT
    id,
    extract(year FROM (created_at AT TIME ZONE coalesce(
      (SELECT nullif(btrim(timezone), '') FROM public.app_settings WHERE id IS TRUE),
      'Africa/Harare'
    )))::integer AS yr,
    row_number() OVER (
      PARTITION BY extract(year FROM (created_at AT TIME ZONE coalesce(
        (SELECT nullif(btrim(timezone), '') FROM public.app_settings WHERE id IS TRUE),
        'Africa/Harare'
      )))
      ORDER BY created_at ASC, id ASC
    ) AS n
  FROM public.stock_requests
)
UPDATE public.stock_requests AS req
SET request_number =
  'REQ-' || lpad((ordered.yr % 100)::text, 2, '0') || '-' ||
  lpad(ordered.n::text, greatest(4, length(ordered.n::text)), '0')
FROM ordered
WHERE req.id = ordered.id;

-- Seed counters from the highest number used per year.
INSERT INTO public.stock_request_number_years (year, last)
SELECT
  extract(year FROM (req.created_at AT TIME ZONE coalesce(
    (SELECT nullif(btrim(timezone), '') FROM public.app_settings WHERE id IS TRUE),
    'Africa/Harare'
  )))::integer AS year,
  max(substring(req.request_number FROM '[0-9]+$')::integer) AS last
FROM public.stock_requests AS req
WHERE req.request_number ~ '^REQ-[0-9]{2}-[0-9]+$'
GROUP BY 1
ON CONFLICT (year) DO UPDATE
  SET last = greatest(public.stock_request_number_years.last, EXCLUDED.last);

ALTER TABLE public.stock_requests
  ADD CONSTRAINT stock_requests_request_number_key UNIQUE (request_number);

ALTER TABLE public.stock_requests
  ALTER COLUMN request_number SET NOT NULL;

DROP FUNCTION IF EXISTS public.next_stock_request_number();
DROP SEQUENCE IF EXISTS public.stock_request_number_seq;

COMMENT ON COLUMN public.stock_requests.request_number IS
  'Human-readable id REQ-YY-NNNN. YY = submit year (Africa/Harare); NNNN restarts each year. '
  'Assigned by trigger via allocate_stock_request_number; never reused within a year.';

-- Match helper for search (full number or trailing digits).
CREATE OR REPLACE FUNCTION public.request_number_matches(p_number text, p_query text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  q text := lower(btrim(coalesce(p_query, '')));
  n text := lower(coalesce(p_number, ''));
  counter text;
  bare_counter text;
  bare_q text;
BEGIN
  IF q = '' THEN
    RETURN false;
  END IF;
  IF position(q IN n) > 0 THEN
    RETURN true;
  END IF;
  IF q ~ '^[0-9]+$' AND n ~ '^req-[0-9]{2}-[0-9]+$' THEN
    counter := substring(n FROM '[0-9]+$');
    bare_counter := nullif(ltrim(counter, '0'), '');
    IF bare_counter IS NULL THEN
      bare_counter := '0';
    END IF;
    bare_q := nullif(ltrim(q, '0'), '');
    IF bare_q IS NULL THEN
      bare_q := '0';
    END IF;
    IF bare_counter = bare_q OR counter = q OR counter LIKE '%' || q THEN
      RETURN true;
    END IF;
  END IF;
  RETURN false;
END;
$$;

COMMENT ON FUNCTION public.request_number_matches(text, text) IS
  'True when p_query matches the full request number (case-insensitive) or its trailing digits.';

REVOKE ALL ON FUNCTION public.request_number_matches(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_number_matches(text, text) TO authenticated, service_role;

COMMIT;
