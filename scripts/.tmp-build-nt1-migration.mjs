import fs from "fs"

const hf1 = fs.readFileSync(
  "supabase/migrations/20261012140354_hf1_requester_atlas_catalogue.sql",
  "utf8",
)

const submitMatch = hf1.match(
  /CREATE OR REPLACE FUNCTION public\.submit_request[\s\S]*?END;\r?\n\$\$;/,
)
const resubmitMatch = hf1.match(
  /CREATE OR REPLACE FUNCTION public\.resubmit_request[\s\S]*?END;\r?\n\$\$;/,
)
if (!submitMatch || !resubmitMatch) throw new Error("submit/resubmit not found")

let submit = submitMatch[0]
let resubmit = resubmitMatch[0]

const issuerSubmit = `
  PERFORM public.notify_stock_request_issuers(
    v_id,
    'request_submitted',
    'New request to issue',
    format('A %s request was submitted and is ready to issue.', v_type)
  );
`

const issuerResubmit = `
  PERFORM public.notify_stock_request_issuers(
    p_request_id,
    'request_resubmitted',
    'Request resubmitted',
    format('A %s request was resubmitted and is ready to issue.', v_type)
  );
`

submit = submit.replace(
  "  RETURN v_id;\nEND;",
  `${issuerSubmit}\n\n  RETURN v_id;\nEND;`,
)
resubmit = resubmit.replace(
  "  END IF;\nEND;",
  `  END IF;\n${issuerResubmit}\nEND;`,
)

const head = `-- NT1: issuer notifications, app_settings recipients, realtime on notifications.
-- No BEGIN/COMMIT: rehearse and apply wrap their own transactions.

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS stock_request_issuer_recipients_default text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS stock_request_issuer_recipients_fortinet text[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN public.app_settings.stock_request_issuer_recipients_default IS
  'Portal user emails notified when a non-Fortinet stock request is submitted or resubmitted.';
COMMENT ON COLUMN public.app_settings.stock_request_issuer_recipients_fortinet IS
  'Portal user emails notified when an all-Fortinet stock request is submitted or resubmitted.';

CREATE OR REPLACE FUNCTION public.validate_app_settings_stock_request_issuers()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  recipient text;
BEGIN
  FOREACH recipient IN ARRAY coalesce(NEW.stock_request_issuer_recipients_default, '{}'::text[]) LOOP
    IF recipient !~* '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' THEN
      RAISE EXCEPTION 'stock_request_issuer_recipients_default: invalid email %', recipient;
    END IF;
  END LOOP;
  FOREACH recipient IN ARRAY coalesce(NEW.stock_request_issuer_recipients_fortinet, '{}'::text[]) LOOP
    IF recipient !~* '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' THEN
      RAISE EXCEPTION 'stock_request_issuer_recipients_fortinet: invalid email %', recipient;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_app_settings_stock_request_issuers() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tr_app_settings_validate_stock_request_issuers ON public.app_settings;
CREATE TRIGGER tr_app_settings_validate_stock_request_issuers
  BEFORE INSERT OR UPDATE OF stock_request_issuer_recipients_default, stock_request_issuer_recipients_fortinet
  ON public.app_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_app_settings_stock_request_issuers();

CREATE OR REPLACE FUNCTION public.stock_request_is_all_fortinet(p_request_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    bool_and(lower(btrim(coalesce(pl.vendor, ''))) = 'fortinet'),
    false
  )
  FROM public.stock_request_lines AS line
  JOIN public.product_lines AS pl ON pl.id = line.product_id
  WHERE line.request_id = p_request_id;
$$;

REVOKE ALL ON FUNCTION public.stock_request_is_all_fortinet(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_request_is_all_fortinet(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.notify_stock_request_issuers(
  p_request_id uuid,
  p_type text,
  p_title text,
  p_body text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_emails text[];
  v_num text;
  v_title text := p_title;
  v_body text := p_body;
BEGIN
  IF p_request_id IS NULL THEN
    RETURN;
  END IF;

  SELECT request_number INTO v_num FROM public.stock_requests WHERE id = p_request_id;
  IF v_num IS NOT NULL THEN
    v_title := v_num || ' · ' || p_title;
    v_body := v_num || ': ' || p_body;
  END IF;

  SELECT CASE
    WHEN public.stock_request_is_all_fortinet(p_request_id)
      THEN coalesce(s.stock_request_issuer_recipients_fortinet, '{}'::text[])
    ELSE coalesce(s.stock_request_issuer_recipients_default, '{}'::text[])
  END
  INTO v_emails
  FROM public.app_settings AS s
  WHERE s.id IS TRUE;

  IF coalesce(array_length(v_emails, 1), 0) = 0 THEN
    RETURN;
  END IF;

  INSERT INTO public.notifications (user_id, type, title, body, metadata)
  SELECT
    profile.id,
    p_type,
    v_title,
    v_body,
    jsonb_build_object(
      'request_id', p_request_id::text,
      'request_number', v_num,
      'href', '/requests/' || p_request_id::text || '/fulfill'
    )
  FROM public.profiles AS profile
  WHERE profile.active IS TRUE
    AND lower(btrim(profile.email)) = ANY (
      SELECT lower(btrim(e)) FROM unnest(v_emails) AS e
    )
    AND profile.id IS DISTINCT FROM auth.uid();
END;
$$;

COMMENT ON FUNCTION public.notify_stock_request_issuers(uuid, text, text, text) IS
  'Notify configured issuer emails when a request is submitted or resubmitted.';

REVOKE ALL ON FUNCTION public.notify_stock_request_issuers(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_stock_request_issuers(uuid, text, text, text) TO service_role;

ALTER TABLE public.notifications REPLICA IDENTITY FULL;

DO $realtime$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'notifications'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
    END IF;
  END IF;
END;
$realtime$;

`

const tail = `
REVOKE ALL ON FUNCTION public.submit_request(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_request(jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.resubmit_request(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resubmit_request(uuid, jsonb) TO authenticated, service_role;
`

fs.writeFileSync(
  "supabase/migrations/20261013111300_nt1_notifications_live.sql",
  `${head}\n${submit}\n\n${resubmit}\n${tail}`,
)
console.log("Wrote NT1 migration")
