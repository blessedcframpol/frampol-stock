-- RQ2b: sequential request numbers; awaiting-invoice reminders only for
-- request-linked pending batches (never legacy sales); dry-run support;
-- request numbers in notification titles.

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. REQ-#### numbers (sequence-backed; never reused)
-- -----------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS public.stock_request_number_seq;

CREATE OR REPLACE FUNCTION public.next_stock_request_number()
RETURNS text
LANGUAGE sql
AS $$
  SELECT 'REQ-' || lpad(nextval('public.stock_request_number_seq')::text, 4, '0');
$$;

REVOKE ALL ON FUNCTION public.next_stock_request_number() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.next_stock_request_number() TO service_role;

ALTER TABLE public.stock_requests
  ADD COLUMN IF NOT EXISTS request_number text;

-- Backfill existing rows in created_at order (the 3 live cancelled requests → REQ-0001…).
WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY created_at ASC, id ASC) AS n
  FROM public.stock_requests
  WHERE request_number IS NULL
)
UPDATE public.stock_requests AS req
SET request_number = 'REQ-' || lpad(ordered.n::text, 4, '0')
FROM ordered
WHERE req.id = ordered.id;

SELECT setval(
  'public.stock_request_number_seq',
  greatest(
    coalesce(
      (SELECT max(substring(request_number FROM 5)::bigint)
       FROM public.stock_requests
       WHERE request_number ~ '^REQ-[0-9]+$'),
      0
    ),
    1
  ),
  true
);

ALTER TABLE public.stock_requests
  ALTER COLUMN request_number SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stock_requests_request_number_key'
  ) THEN
    ALTER TABLE public.stock_requests
      ADD CONSTRAINT stock_requests_request_number_key UNIQUE (request_number);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.tr_stock_requests_assign_number()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.request_number IS NULL OR btrim(NEW.request_number) = '' THEN
    NEW.request_number := public.next_stock_request_number();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stock_requests_assign_number ON public.stock_requests;
CREATE TRIGGER stock_requests_assign_number
  BEFORE INSERT ON public.stock_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.tr_stock_requests_assign_number();

COMMENT ON COLUMN public.stock_requests.request_number IS
  'Human-readable sequential id (REQ-0001…). Assigned by trigger from stock_request_number_seq; never reused.';

-- -----------------------------------------------------------------------------
-- 2. Notifications carry the request number
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_stock_request(
  p_user_id uuid,
  p_type text,
  p_title text,
  p_body text,
  p_request_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_num text;
  v_title text := p_title;
  v_body text := p_body;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN;
  END IF;
  IF p_request_id IS NOT NULL THEN
    SELECT request_number INTO v_num FROM public.stock_requests WHERE id = p_request_id;
    IF v_num IS NOT NULL THEN
      v_title := v_num || ' · ' || p_title;
      v_body := v_num || ': ' || p_body;
    END IF;
  END IF;
  INSERT INTO public.notifications (user_id, type, title, body, metadata)
  VALUES (
    p_user_id,
    p_type,
    v_title,
    v_body,
    jsonb_build_object(
      'request_id', p_request_id::text,
      'request_number', v_num
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_stock_request_admins(
  p_type text,
  p_title text,
  p_body text,
  p_request_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_num text;
  v_title text := p_title;
  v_body text := p_body;
BEGIN
  IF p_request_id IS NOT NULL THEN
    SELECT request_number INTO v_num FROM public.stock_requests WHERE id = p_request_id;
    IF v_num IS NOT NULL THEN
      v_title := v_num || ' · ' || p_title;
      v_body := v_num || ': ' || p_body;
    END IF;
  END IF;
  INSERT INTO public.notifications (user_id, type, title, body, metadata)
  SELECT
    profile.id,
    p_type,
    v_title,
    v_body,
    jsonb_build_object(
      'request_id', p_request_id::text,
      'request_number', v_num
    )
  FROM public.profiles AS profile
  WHERE profile.role = 'admin'
    AND profile.active IS TRUE
    AND profile.id IS DISTINCT FROM auth.uid();
END;
$$;

REVOKE ALL ON FUNCTION public.notify_stock_request(uuid, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_stock_request_admins(text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_stock_request(uuid, text, text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.notify_stock_request_admins(text, text, text, uuid) TO service_role;

-- -----------------------------------------------------------------------------
-- 3. Reminder: only request-linked pending batches; optional dry-run (no inserts)
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.notify_awaiting_invoice_reminders(timestamptz);

CREATE OR REPLACE FUNCTION public.notify_awaiting_invoice_reminders(
  p_as_of timestamptz DEFAULT now(),
  p_dry_run boolean DEFAULT false
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tz text;
  v_local timestamp;
  v_dow integer;
  v_n integer := 0;
  r record;
  v_body text;
BEGIN
  SELECT coalesce(nullif(btrim(timezone), ''), 'Africa/Harare')
  INTO v_tz
  FROM public.app_settings
  WHERE id IS TRUE;

  v_local := (p_as_of AT TIME ZONE v_tz);
  v_dow := extract(isodow FROM v_local)::integer; -- 1=Mon … 7=Sun

  IF v_dow > 5 THEN
    RETURN 0;
  END IF;

  -- Only requests that have at least one non-reversed batch with a pending
  -- batch_invoices row. Legacy sales (no request_id on the batch) are never included.
  FOR r IN
    SELECT
      req.created_by AS user_id,
      count(DISTINCT req.id)::int AS n,
      string_agg(req.id::text, ', ' ORDER BY req.created_at, req.id) AS ids,
      string_agg(req.request_number, ', ' ORDER BY req.created_at, req.id) AS numbers
    FROM public.stock_requests AS req
    WHERE req.review_state NOT IN ('cancelled', 'closed', 'rejected')
      AND EXISTS (
        SELECT 1
        FROM public.transactions AS txn
        JOIN public.batch_invoices AS inv ON inv.batch_id = txn.batch_id
        WHERE txn.request_id = req.id
          AND inv.status = 'pending'
          AND txn.type IS DISTINCT FROM 'Reversal'
          AND NOT public.batch_is_currently_reversed(txn.batch_id)
      )
    GROUP BY req.created_by
  LOOP
    v_n := v_n + 1;
    IF p_dry_run THEN
      CONTINUE;
    END IF;
    v_body := format(
      'You have %s request(s) still awaiting an invoice number (%s). Open Requests to add the number.',
      r.n,
      r.numbers
    );
    INSERT INTO public.notifications (user_id, type, title, body, metadata)
    VALUES (
      r.user_id,
      'request_awaiting_invoice_reminder',
      'Invoice number still needed',
      v_body,
      jsonb_build_object(
        'request_ids', to_jsonb(string_to_array(r.ids, ', ')),
        'request_numbers', to_jsonb(string_to_array(r.numbers, ', ')),
        'as_of', p_as_of
      )
    );
  END LOOP;

  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION public.notify_awaiting_invoice_reminders(timestamptz, boolean) IS
  'One reminder per requester who has request-linked batches with pending invoices. '
  'Never includes legacy sales. No-ops Sat/Sun Africa/Harare. p_dry_run skips inserts.';

REVOKE ALL ON FUNCTION public.notify_awaiting_invoice_reminders(timestamptz, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_awaiting_invoice_reminders(timestamptz, boolean)
  TO service_role;

COMMIT;
