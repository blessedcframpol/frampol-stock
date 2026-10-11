-- AU1: audit trail coverage, tamper-evident hash chain, daily digest, weekly exceptions.
-- No BEGIN/COMMIT: rehearse-migration and supabase apply wrap their own transactions.
-- Maintenance writes should set:
--   SELECT set_config('app.audit_source', 'maintenance', true);
--   SELECT set_config('app.audit_actor', 'admin:Joshua Goredema', true);

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- -----------------------------------------------------------------------------
-- 1. Exclusion registry (schema-rules reads this)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audit_trigger_exclusions (
  table_name text PRIMARY KEY,
  reason text NOT NULL
);

COMMENT ON TABLE public.audit_trigger_exclusions IS
  'Public tables that must not carry the A1 audit_capture trigger. Every other public table must.';

ALTER TABLE public.audit_trigger_exclusions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_trigger_exclusions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.audit_trigger_exclusions TO service_role;

INSERT INTO public.audit_trigger_exclusions (table_name, reason) VALUES
  ('audit_log', 'Audit trail itself; protected by append-only trigger'),
  ('audit_trigger_exclusions', 'Registry for schema-rules; not business state'),
  ('audit_daily_digest', 'Derived daily seal of audit_log; not a business write path'),
  ('notifications', 'Ephemeral portal inbox; not durable business state'),
  ('stock_request_number_years', 'Monotonic request-number counter only'),
  ('app_event_logs', 'Application error/telemetry log; separate from business audit'),
  ('profile_access_events', 'Already an access-event stream with its own append semantics')
ON CONFLICT (table_name) DO UPDATE SET reason = EXCLUDED.reason;

-- -----------------------------------------------------------------------------
-- 2. app_settings: portal recipients for digest + weekly exceptions
-- -----------------------------------------------------------------------------
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS audit_report_recipients text[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN public.app_settings.audit_report_recipients IS
  'Emails of portal users who receive audit daily digest and weekly exceptions notifications.';

CREATE OR REPLACE FUNCTION public.validate_app_settings_audit_recipients()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  recipient text;
BEGIN
  FOREACH recipient IN ARRAY NEW.audit_report_recipients LOOP
    IF recipient !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
      RAISE EXCEPTION 'Invalid audit report recipient email: %', recipient
        USING ERRCODE = '22023';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_app_settings_audit_recipients() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tr_app_settings_validate_audit_recipients ON public.app_settings;
CREATE TRIGGER tr_app_settings_validate_audit_recipients
  BEFORE INSERT OR UPDATE OF audit_report_recipients
  ON public.app_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_app_settings_audit_recipients();

UPDATE public.app_settings
SET audit_report_recipients = ARRAY['joshuag@frampolafrica.com']
WHERE id IS TRUE
  AND (audit_report_recipients IS NULL OR audit_report_recipients = '{}'::text[]);

-- -----------------------------------------------------------------------------
-- 3. audit_log: seq + row_hash
-- -----------------------------------------------------------------------------
ALTER TABLE public.audit_log
  ADD COLUMN IF NOT EXISTS seq bigint,
  ADD COLUMN IF NOT EXISTS row_hash text;

COMMENT ON COLUMN public.audit_log.seq IS
  'Strictly increasing chain sequence assigned under advisory lock in audit_capture.';
COMMENT ON COLUMN public.audit_log.row_hash IS
  'sha256(previous row_hash || canonical content) for tamper evidence.';

CREATE OR REPLACE FUNCTION public.audit_row_canonical(
  p_table_name text,
  p_row_id text,
  p_action text,
  p_changed jsonb,
  p_actor text,
  p_source text,
  p_reason text,
  p_at timestamptz,
  p_transaction_id bigint
)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object(
    'table_name', p_table_name,
    'row_id', p_row_id,
    'action', p_action,
    'changed', coalesce(p_changed, '{}'::jsonb),
    'actor', p_actor,
    'source', p_source,
    'reason', p_reason,
    'at', p_at,
    'transaction_id', p_transaction_id
  )::text;
$$;

REVOKE ALL ON FUNCTION public.audit_row_canonical(text, text, text, jsonb, text, text, text, timestamptz, bigint)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.audit_capture()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old jsonb := '{}'::jsonb;
  v_new jsonb := '{}'::jsonb;
  v_changed jsonb;
  v_action text;
  v_row text;
  v_pk text := CASE WHEN TG_NARGS >= 1 THEN nullif(btrim(TG_ARGV[0]), '') ELSE NULL END;
  v_actor text;
  v_source text;
  v_reason text;
  v_at timestamptz := clock_timestamp();
  v_txid bigint := txid_current();
  v_prev_seq bigint;
  v_prev_hash text;
  v_seq bigint;
  v_canonical text;
  v_hash text;
  v_payload jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'insert';
    v_new := to_jsonb(NEW);
    v_payload := v_new;
  ELSIF TG_OP = 'UPDATE' THEN
    v_action := 'update';
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    v_payload := v_new;
  ELSE
    v_action := 'delete';
    v_old := to_jsonb(OLD);
    v_payload := v_old;
  END IF;

  v_row := coalesce(
    CASE WHEN v_pk IS NOT NULL THEN v_payload ->> v_pk END,
    v_payload ->> 'id'
  );
  IF v_row IS NULL OR btrim(v_row) = '' THEN
    RAISE EXCEPTION 'audit_capture: could not resolve row id for %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;

  v_changed := public.audit_field_changes(v_old, v_new);
  IF v_action = 'update' AND v_changed = '{}'::jsonb THEN
    RETURN NULL;
  END IF;

  v_source := coalesce(
    nullif(current_setting('app.movement_type', true), ''),
    nullif(current_setting('app.audit_source', true), ''),
    'direct'
  );
  v_reason := nullif(btrim(coalesce(current_setting('app.audit_reason', true), '')), '');

  IF v_source = 'maintenance' THEN
    v_actor := coalesce(
      nullif(btrim(current_setting('app.audit_actor', true)), ''),
      'maintenance'
    );
  ELSE
    v_actor := coalesce(auth.uid()::text, current_user);
  END IF;

  PERFORM pg_advisory_xact_lock(872314001);

  SELECT coalesce(max(seq), 0) INTO v_prev_seq FROM public.audit_log;
  IF v_prev_seq > 0 THEN
    SELECT row_hash INTO v_prev_hash FROM public.audit_log WHERE seq = v_prev_seq;
  ELSE
    v_prev_hash := '';
  END IF;

  v_seq := v_prev_seq + 1;
  v_canonical := public.audit_row_canonical(
    TG_TABLE_NAME, v_row, v_action, v_changed, v_actor, v_source, v_reason, v_at, v_txid
  );
  v_hash := encode(
    extensions.digest(coalesce(v_prev_hash, '') || v_canonical, 'sha256'),
    'hex'
  );

  INSERT INTO public.audit_log (
    table_name, row_id, action, changed, actor, source, reason, at, transaction_id, seq, row_hash
  )
  VALUES (
    TG_TABLE_NAME, v_row, v_action, v_changed, v_actor, v_source, v_reason, v_at, v_txid, v_seq, v_hash
  );

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_capture() FROM PUBLIC, anon, authenticated;

-- Backfill chain for existing rows (append-only trigger off briefly).
ALTER TABLE public.audit_log DISABLE TRIGGER tr_audit_log_append_only;

DO $$
DECLARE
  rec record;
  v_prev_hash text := '';
  v_seq bigint := 0;
  v_canonical text;
  v_hash text;
BEGIN
  FOR rec IN
    SELECT id, table_name, row_id, action, changed, actor, source, reason, at, transaction_id
    FROM public.audit_log
    ORDER BY id ASC
  LOOP
    v_seq := v_seq + 1;
    v_canonical := public.audit_row_canonical(
      rec.table_name, rec.row_id, rec.action, rec.changed, rec.actor, rec.source,
      rec.reason, rec.at, rec.transaction_id
    );
    v_hash := encode(extensions.digest(v_prev_hash || v_canonical, 'sha256'), 'hex');
    UPDATE public.audit_log
    SET seq = v_seq, row_hash = v_hash
    WHERE id = rec.id;
    v_prev_hash := v_hash;
  END LOOP;
END;
$$;

ALTER TABLE public.audit_log ENABLE TRIGGER tr_audit_log_append_only;

ALTER TABLE public.audit_log ALTER COLUMN seq SET NOT NULL;
ALTER TABLE public.audit_log ALTER COLUMN row_hash SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS audit_log_seq_uidx ON public.audit_log (seq);
CREATE INDEX IF NOT EXISTS audit_log_action_at_idx ON public.audit_log (action, at DESC);

-- -----------------------------------------------------------------------------
-- 4. verify_audit_chain
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_audit_chain(
  p_from_seq bigint DEFAULT NULL,
  p_to_seq bigint DEFAULT NULL
)
RETURNS TABLE (broken_seq bigint, detail text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec record;
  v_prev_hash text := '';
  v_expect text;
  v_canonical text;
  v_lo bigint := coalesce(p_from_seq, 1);
  v_hi bigint := coalesce(p_to_seq, (SELECT coalesce(max(seq), 0) FROM public.audit_log));
  v_prev_seq bigint := v_lo - 1;
BEGIN
  IF v_lo > 1 THEN
    SELECT row_hash INTO v_prev_hash FROM public.audit_log WHERE seq = v_lo - 1;
    IF v_prev_hash IS NULL THEN
      broken_seq := v_lo;
      detail := format('missing previous seq %s for range start', v_lo - 1);
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  FOR rec IN
    SELECT seq, table_name, row_id, action, changed, actor, source, reason, at, transaction_id, row_hash
    FROM public.audit_log
    WHERE seq >= v_lo AND seq <= v_hi
    ORDER BY seq ASC
  LOOP
    IF rec.seq <> v_prev_seq + 1 THEN
      broken_seq := rec.seq;
      detail := format('gap: expected seq %s, found %s', v_prev_seq + 1, rec.seq);
      RETURN NEXT;
      RETURN;
    END IF;

    v_canonical := public.audit_row_canonical(
      rec.table_name, rec.row_id, rec.action, rec.changed, rec.actor, rec.source,
      rec.reason, rec.at, rec.transaction_id
    );
    v_expect := encode(extensions.digest(coalesce(v_prev_hash, '') || v_canonical, 'sha256'), 'hex');
    IF rec.row_hash IS DISTINCT FROM v_expect THEN
      broken_seq := rec.seq;
      detail := format('hash mismatch at seq %s', rec.seq);
      RETURN NEXT;
      RETURN;
    END IF;

    v_prev_hash := rec.row_hash;
    v_prev_seq := rec.seq;
  END LOOP;

  RETURN;
END;
$$;

COMMENT ON FUNCTION public.verify_audit_chain(bigint, bigint) IS
  'Returns the first broken audit chain link in [from_seq, to_seq], or no rows if intact.';

REVOKE ALL ON FUNCTION public.verify_audit_chain(bigint, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_audit_chain(bigint, bigint) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. Attach audit_capture to every business table
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS tr_transactions_audit ON public.transactions;
CREATE TRIGGER tr_transactions_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture('id');

DROP TRIGGER IF EXISTS tr_inventory_items_audit ON public.inventory_items;
CREATE TRIGGER tr_inventory_items_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.inventory_items
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture('id');

DROP TRIGGER IF EXISTS tr_clients_audit ON public.clients;
CREATE TRIGGER tr_clients_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture('id');

DROP TRIGGER IF EXISTS tr_app_settings_audit ON public.app_settings;
CREATE TRIGGER tr_app_settings_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.app_settings
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture('id');

DROP TRIGGER IF EXISTS tr_batch_invoice_events_audit ON public.batch_invoice_events;
CREATE TRIGGER tr_batch_invoice_events_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.batch_invoice_events
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture('id');

DROP TRIGGER IF EXISTS tr_batch_invoices_audit ON public.batch_invoices;
CREATE TRIGGER tr_batch_invoices_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.batch_invoices
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture('batch_id');

DROP TRIGGER IF EXISTS tr_batch_restores_audit ON public.batch_restores;
CREATE TRIGGER tr_batch_restores_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.batch_restores
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture('id');

DROP TRIGGER IF EXISTS tr_batch_reversals_audit ON public.batch_reversals;
CREATE TRIGGER tr_batch_reversals_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.batch_reversals
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture('batch_id');

DROP TRIGGER IF EXISTS tr_holding_extensions_audit ON public.holding_extensions;
CREATE TRIGGER tr_holding_extensions_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.holding_extensions
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture('id');

DROP TRIGGER IF EXISTS tr_kit_case_events_audit ON public.kit_case_events;
CREATE TRIGGER tr_kit_case_events_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.kit_case_events
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture('id');

DROP TRIGGER IF EXISTS tr_kit_cases_audit ON public.kit_cases;
CREATE TRIGGER tr_kit_cases_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.kit_cases
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture('id');

DROP TRIGGER IF EXISTS tr_kit_inspections_audit ON public.kit_inspections;
CREATE TRIGGER tr_kit_inspections_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.kit_inspections
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture('id');

DROP TRIGGER IF EXISTS tr_outbound_batches_audit ON public.outbound_batches;
CREATE TRIGGER tr_outbound_batches_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.outbound_batches
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture('id');

DROP TRIGGER IF EXISTS tr_product_lines_audit ON public.product_lines;
CREATE TRIGGER tr_product_lines_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.product_lines
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture('id');

DROP TRIGGER IF EXISTS tr_profile_signup_email_domains_audit ON public.profile_signup_email_domains;
CREATE TRIGGER tr_profile_signup_email_domains_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.profile_signup_email_domains
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture('email_domain');

DROP TRIGGER IF EXISTS tr_profiles_audit ON public.profiles;
CREATE TRIGGER tr_profiles_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture('id');

DROP TRIGGER IF EXISTS tr_remediation_cases_audit ON public.remediation_cases;
CREATE TRIGGER tr_remediation_cases_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.remediation_cases
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture('id');

DROP TRIGGER IF EXISTS tr_remediation_providers_audit ON public.remediation_providers;
CREATE TRIGGER tr_remediation_providers_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.remediation_providers
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture('id');

DROP TRIGGER IF EXISTS tr_stock_pool_changes_audit ON public.stock_pool_changes;
CREATE TRIGGER tr_stock_pool_changes_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.stock_pool_changes
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture('id');

DROP TRIGGER IF EXISTS tr_stock_request_events_audit ON public.stock_request_events;
CREATE TRIGGER tr_stock_request_events_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.stock_request_events
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture('id');

DROP TRIGGER IF EXISTS tr_stock_request_lines_audit ON public.stock_request_lines;
CREATE TRIGGER tr_stock_request_lines_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.stock_request_lines
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture('id');

DROP TRIGGER IF EXISTS tr_stock_requests_audit ON public.stock_requests;
CREATE TRIGGER tr_stock_requests_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.stock_requests
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture('id');

DROP TRIGGER IF EXISTS tr_stock_takes_audit ON public.stock_takes;
CREATE TRIGGER tr_stock_takes_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.stock_takes
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture('id');

-- -----------------------------------------------------------------------------
-- 6. Daily digest + weekly exceptions notifications
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audit_daily_digest (
  day date PRIMARY KEY,
  last_seq bigint NOT NULL,
  last_hash text NOT NULL,
  action_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.audit_daily_digest IS
  'Daily seal of the audit chain (last seq/hash + action counts) in Africa/Harare days.';

ALTER TABLE public.audit_daily_digest ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_daily_digest FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.audit_daily_digest TO service_role;

CREATE OR REPLACE FUNCTION public.notify_audit_recipients(
  p_type text,
  p_title text,
  p_body text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_emails text[];
  v_count integer := 0;
BEGIN
  SELECT coalesce(audit_report_recipients, '{}'::text[])
  INTO v_emails
  FROM public.app_settings
  WHERE id IS TRUE;

  IF v_emails IS NULL OR cardinality(v_emails) = 0 THEN
    INSERT INTO public.notifications (user_id, type, title, body, metadata)
    SELECT profile.id, p_type, p_title, p_body, coalesce(p_metadata, '{}'::jsonb)
    FROM public.profiles AS profile
    WHERE profile.role = 'admin' AND profile.active IS TRUE;
  ELSE
    INSERT INTO public.notifications (user_id, type, title, body, metadata)
    SELECT profile.id, p_type, p_title, p_body, coalesce(p_metadata, '{}'::jsonb)
    FROM public.profiles AS profile
    WHERE profile.active IS TRUE
      AND lower(profile.email) = ANY (SELECT lower(unnest(v_emails)));
  END IF;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_audit_recipients(text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_audit_recipients(text, text, text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.write_audit_daily_digest(
  p_as_of timestamptz DEFAULT clock_timestamp()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tz text;
  v_day date;
  v_start timestamptz;
  v_end timestamptz;
  v_last_seq bigint;
  v_last_hash text;
  v_counts jsonb;
  v_rows integer;
  v_notified integer;
BEGIN
  SELECT coalesce(nullif(btrim(timezone), ''), 'Africa/Harare')
  INTO v_tz
  FROM public.app_settings
  WHERE id IS TRUE;
  v_tz := coalesce(v_tz, 'Africa/Harare');

  v_day := (p_as_of AT TIME ZONE v_tz)::date;
  v_start := (v_day::timestamp AT TIME ZONE v_tz);
  v_end := ((v_day + 1)::timestamp AT TIME ZONE v_tz);

  SELECT coalesce(max(seq), 0) INTO v_last_seq
  FROM public.audit_log
  WHERE at >= v_start AND at < v_end;

  IF v_last_seq = 0 THEN
    SELECT coalesce(max(seq), 0) INTO v_last_seq FROM public.audit_log WHERE at < v_end;
  END IF;

  SELECT row_hash INTO v_last_hash FROM public.audit_log WHERE seq = v_last_seq;
  v_last_hash := coalesce(v_last_hash, '');

  SELECT coalesce(jsonb_object_agg(action, n), '{}'::jsonb), coalesce(sum(n), 0)::integer
  INTO v_counts, v_rows
  FROM (
    SELECT action, count(*)::integer AS n
    FROM public.audit_log
    WHERE at >= v_start AND at < v_end
    GROUP BY action
  ) AS counts;

  INSERT INTO public.audit_daily_digest (day, last_seq, last_hash, action_counts, row_count)
  VALUES (v_day, v_last_seq, v_last_hash, v_counts, v_rows)
  ON CONFLICT (day) DO UPDATE
  SET last_seq = EXCLUDED.last_seq,
      last_hash = EXCLUDED.last_hash,
      action_counts = EXCLUDED.action_counts,
      row_count = EXCLUDED.row_count,
      created_at = now();

  v_notified := public.notify_audit_recipients(
    'audit_daily_digest',
    'Audit digest · ' || to_char(v_day, 'DD/MM/YYYY'),
    format(
      'Day %s: %s audit row(s). Last seq %s. Actions: %s',
      to_char(v_day, 'DD/MM/YYYY'),
      v_rows,
      v_last_seq,
      v_counts::text
    ),
    jsonb_build_object(
      'day', v_day,
      'last_seq', v_last_seq,
      'last_hash', v_last_hash,
      'action_counts', v_counts,
      'href', '/settings#audit'
    )
  );

  RETURN jsonb_build_object(
    'day', v_day,
    'last_seq', v_last_seq,
    'last_hash', v_last_hash,
    'action_counts', v_counts,
    'row_count', v_rows,
    'notified', v_notified
  );
END;
$$;

COMMENT ON FUNCTION public.write_audit_daily_digest(timestamptz) IS
  'Writes the Africa/Harare day seal into audit_daily_digest and notifies audit_report_recipients.';

REVOKE ALL ON FUNCTION public.write_audit_daily_digest(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_audit_daily_digest(timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.audit_exceptions_read(
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tz text;
  v_from date;
  v_to date;
BEGIN
  IF coalesce(public.get_my_role()::text, '') NOT IN ('admin', 'viewer') THEN
    RAISE EXCEPTION 'audit_exceptions_read: admin or Admin viewer only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT coalesce(nullif(btrim(timezone), ''), 'Africa/Harare')
  INTO v_tz
  FROM public.app_settings
  WHERE id IS TRUE;
  v_tz := coalesce(v_tz, 'Africa/Harare');

  v_to := coalesce(p_to, (clock_timestamp() AT TIME ZONE v_tz)::date);
  v_from := coalesce(p_from, v_to - 7);

  RETURN (
    SELECT coalesce(jsonb_agg(to_jsonb(entry) ORDER BY entry.at DESC, entry.id DESC), '[]'::jsonb)
    FROM (
      SELECT
        log.id,
        log.seq,
        log.at,
        log.table_name,
        log.row_id,
        log.action,
        log.source,
        log.actor,
        coalesce(nullif(btrim(profile.display_name), ''), profile.email) AS actor_name,
        log.reason,
        log.changed,
        CASE
          WHEN log.table_name = 'batch_reversals'
               AND coalesce(log.changed #>> '{kind,1}', log.changed #>> '{kind,0}', '') = 'void'
            THEN 'void'
          WHEN log.table_name = 'batch_reversals' OR log.source = 'Reversal'
            THEN 'reversal'
          WHEN log.table_name = 'batch_restores'
            THEN 'restore'
          WHEN log.source = 'approve_not_invoiced'
               OR (log.changed::text ILIKE '%00000%' AND log.table_name IN ('batch_invoices', 'stock_requests', 'transactions'))
            THEN 'approval_00000'
          WHEN log.table_name = 'transactions'
               AND log.action = 'insert'
               AND coalesce(log.changed #>> '{type,1}', '') IN ('Sale', 'Rentals', 'POC Out')
               AND coalesce(log.changed #>> '{metadata,1,request_id}', '') = ''
               AND log.source IS DISTINCT FROM 'issue_units'
            THEN 'issue_without_request'
          WHEN log.table_name = 'stock_pool_changes'
            THEN 'pool_change'
          WHEN log.source IN ('edit_item', 'move_group')
            THEN 'kit_edit'
          WHEN log.changed ? 'invoice_number' OR log.source = 'sync_legacy_invoice'
            THEN 'invoice_number_change'
          WHEN log.table_name = 'stock_requests'
               AND (
                 coalesce(log.changed #>> '{status,1}', '') IN ('rejected', 'closed', 'cancelled')
                 OR log.source IN ('reject_request', 'close_request')
               )
            THEN 'request_reject_or_close'
          WHEN log.table_name = 'profiles' AND log.changed ? 'role'
            THEN 'role_change'
          WHEN log.table_name = 'holding_extensions'
               AND (log.changed ? 'cancelled_at' OR log.changed ? 'cancelled_by')
            THEN 'cancelled_extension'
          WHEN log.source = 'direct'
            THEN 'direct_sql'
          ELSE NULL
        END AS category
      FROM public.audit_log AS log
      LEFT JOIN public.profiles AS profile ON profile.id::text = log.actor
      WHERE (log.at AT TIME ZONE v_tz)::date >= v_from
        AND (log.at AT TIME ZONE v_tz)::date <= v_to
    ) AS entry
    WHERE entry.category IS NOT NULL
  );
END;
$$;

COMMENT ON FUNCTION public.audit_exceptions_read(date, date) IS
  'Admin/Admin viewer weekly exceptions categories from the audit log.';

REVOKE ALL ON FUNCTION public.audit_exceptions_read(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.audit_exceptions_read(date, date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.notify_audit_weekly_exceptions(
  p_as_of timestamptz DEFAULT clock_timestamp()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tz text;
  v_to date;
  v_from date;
  v_count integer;
  v_notified integer;
  v_items jsonb;
BEGIN
  SELECT coalesce(nullif(btrim(timezone), ''), 'Africa/Harare')
  INTO v_tz
  FROM public.app_settings
  WHERE id IS TRUE;
  v_tz := coalesce(v_tz, 'Africa/Harare');

  v_to := (p_as_of AT TIME ZONE v_tz)::date - 1;
  v_from := v_to - 6;

  -- Inline query: cron has no JWT so audit_exceptions_read's role gate cannot run here.
  v_items := (
    SELECT coalesce(jsonb_agg(to_jsonb(entry) ORDER BY entry.at DESC), '[]'::jsonb)
    FROM (
      SELECT
        log.id,
        log.at,
        log.source,
        log.actor,
        CASE
          WHEN log.table_name = 'batch_reversals'
               AND coalesce(log.changed #>> '{kind,1}', log.changed #>> '{kind,0}', '') = 'void'
            THEN 'void'
          WHEN log.table_name = 'batch_reversals' OR log.source = 'Reversal' THEN 'reversal'
          WHEN log.table_name = 'batch_restores' THEN 'restore'
          WHEN log.source = 'approve_not_invoiced'
               OR (log.changed::text ILIKE '%00000%' AND log.table_name IN ('batch_invoices', 'stock_requests', 'transactions'))
            THEN 'approval_00000'
          WHEN log.table_name = 'transactions'
               AND log.action = 'insert'
               AND coalesce(log.changed #>> '{type,1}', '') IN ('Sale', 'Rentals', 'POC Out')
               AND coalesce(log.changed #>> '{metadata,1,request_id}', '') = ''
               AND log.source IS DISTINCT FROM 'issue_units'
            THEN 'issue_without_request'
          WHEN log.table_name = 'stock_pool_changes' THEN 'pool_change'
          WHEN log.source IN ('edit_item', 'move_group') THEN 'kit_edit'
          WHEN log.changed ? 'invoice_number' OR log.source = 'sync_legacy_invoice' THEN 'invoice_number_change'
          WHEN log.table_name = 'stock_requests'
               AND (
                 coalesce(log.changed #>> '{status,1}', '') IN ('rejected', 'closed', 'cancelled')
                 OR log.source IN ('reject_request', 'close_request')
               )
            THEN 'request_reject_or_close'
          WHEN log.table_name = 'profiles' AND log.changed ? 'role' THEN 'role_change'
          WHEN log.table_name = 'holding_extensions'
               AND (log.changed ? 'cancelled_at' OR log.changed ? 'cancelled_by')
            THEN 'cancelled_extension'
          WHEN log.source = 'direct' THEN 'direct_sql'
          ELSE NULL
        END AS category
      FROM public.audit_log AS log
      WHERE (log.at AT TIME ZONE v_tz)::date >= v_from
        AND (log.at AT TIME ZONE v_tz)::date <= v_to
    ) AS entry
    WHERE entry.category IS NOT NULL
  );

  v_count := coalesce(jsonb_array_length(v_items), 0);
  v_notified := public.notify_audit_recipients(
    'audit_weekly_exceptions',
    'Weekly audit exceptions · ' || to_char(v_from, 'DD/MM') || '–' || to_char(v_to, 'DD/MM'),
    format('%s exception row(s) in the last week. Open the report for who and when.', v_count),
    jsonb_build_object(
      'from', v_from,
      'to', v_to,
      'count', v_count,
      'href', '/reports/audit-exceptions?from=' || v_from::text || '&to=' || v_to::text
    )
  );

  RETURN jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'count', v_count,
    'notified', v_notified
  );
END;
$$;

COMMENT ON FUNCTION public.notify_audit_weekly_exceptions(timestamptz) IS
  'Monday job: portal-notify audit_report_recipients with a link to the weekly exceptions report.';

REVOKE ALL ON FUNCTION public.notify_audit_weekly_exceptions(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_audit_weekly_exceptions(timestamptz) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'audit-daily-digest') THEN
    PERFORM cron.unschedule('audit-daily-digest');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'audit-weekly-exceptions') THEN
    PERFORM cron.unschedule('audit-weekly-exceptions');
  END IF;
EXCEPTION
  WHEN undefined_table THEN NULL;
  WHEN undefined_function THEN NULL;
END;
$$;

DO $$
BEGIN
  PERFORM cron.schedule(
    'audit-daily-digest',
    '0 16 * * *',
    $job$SELECT public.write_audit_daily_digest()$job$
  );
  PERFORM cron.schedule(
    'audit-weekly-exceptions',
    '0 6 * * 1',
    $job$SELECT public.notify_audit_weekly_exceptions()$job$
  );
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'AU1 pg_cron schedule skipped (%). Functions are ready; schedule manually if needed.', SQLERRM;
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. Read APIs: audit_log_read (+ action), auth sign-ins
-- -----------------------------------------------------------------------------
-- Drop prior 5-arg overload so defaulted calls are unambiguous.
DROP FUNCTION IF EXISTS public.audit_log_read(text, text, text, date, date);

CREATE OR REPLACE FUNCTION public.audit_log_read(
  p_table text DEFAULT NULL,
  p_row text DEFAULT NULL,
  p_user text DEFAULT NULL,
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_action text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tz text;
  v_user text := nullif(btrim(coalesce(p_user, '')), '');
  v_action text := nullif(btrim(coalesce(p_action, '')), '');
BEGIN
  IF coalesce(public.get_my_role()::text, '') NOT IN ('admin', 'viewer') THEN
    RAISE EXCEPTION 'audit_log_read: admin or Admin viewer only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT coalesce(nullif(btrim(timezone), ''), 'Africa/Harare')
  INTO v_tz
  FROM public.app_settings
  WHERE id IS TRUE;
  v_tz := coalesce(v_tz, 'Africa/Harare');

  RETURN (
    SELECT coalesce(jsonb_agg(to_jsonb(entry) ORDER BY entry.at DESC, entry.id DESC), '[]'::jsonb)
    FROM (
      SELECT
        log.id,
        log.seq,
        log.table_name,
        log.row_id,
        log.action,
        log.changed,
        log.actor,
        coalesce(nullif(btrim(profile.display_name), ''), profile.email) AS actor_name,
        log.source,
        log.reason,
        log.at,
        log.transaction_id,
        log.row_hash
      FROM public.audit_log AS log
      LEFT JOIN public.profiles AS profile ON profile.id::text = log.actor
      WHERE (nullif(btrim(coalesce(p_table, '')), '') IS NULL OR log.table_name = btrim(p_table))
        AND (nullif(btrim(coalesce(p_row, '')), '') IS NULL OR log.row_id = btrim(p_row))
        AND (
          v_user IS NULL
          OR log.actor = v_user
          OR profile.display_name ILIKE '%' || v_user || '%'
          OR profile.email ILIKE '%' || v_user || '%'
        )
        AND (v_action IS NULL OR log.action = v_action)
        AND (p_from IS NULL OR (log.at AT TIME ZONE v_tz)::date >= p_from)
        AND (p_to IS NULL OR (log.at AT TIME ZONE v_tz)::date <= p_to)
      ORDER BY log.at DESC, log.id DESC
      LIMIT 500
    ) AS entry
  );
END;
$$;

COMMENT ON FUNCTION public.audit_log_read(text, text, text, date, date, text) IS
  'Admin and Admin viewer read the audit log. Optional action filter. No writes.';

REVOKE ALL ON FUNCTION public.audit_log_read(text, text, text, date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.audit_log_read(text, text, text, date, date, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.auth_sign_ins_read(
  p_user text DEFAULT NULL,
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tz text;
  v_user text := nullif(btrim(coalesce(p_user, '')), '');
BEGIN
  IF coalesce(public.get_my_role()::text, '') NOT IN ('admin', 'viewer') THEN
    RAISE EXCEPTION 'auth_sign_ins_read: admin or Admin viewer only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT coalesce(nullif(btrim(timezone), ''), 'Africa/Harare')
  INTO v_tz
  FROM public.app_settings
  WHERE id IS TRUE;
  v_tz := coalesce(v_tz, 'Africa/Harare');

  RETURN (
    SELECT coalesce(jsonb_agg(to_jsonb(entry) ORDER BY entry.at DESC), '[]'::jsonb)
    FROM (
      SELECT
        entries.id,
        entries.created_at AS at,
        entries.ip_address,
        coalesce(entries.payload->>'action', entries.payload->>'action_type') AS action,
        coalesce(entries.payload->>'actor_id', entries.payload->'traits'->>'actor_id') AS actor_id,
        coalesce(
          entries.payload->>'actor_username',
          entries.payload->'traits'->>'email',
          profile.email
        ) AS actor_email,
        coalesce(nullif(btrim(profile.display_name), ''), profile.email) AS actor_name,
        entries.payload
      FROM auth.audit_log_entries AS entries
      LEFT JOIN public.profiles AS profile
        ON profile.id::text = coalesce(entries.payload->>'actor_id', entries.payload->'traits'->>'actor_id')
      WHERE coalesce(entries.payload->>'action', entries.payload->>'action_type', '') IN (
          'login', 'token_refreshed', 'user_signedup', 'logout'
        )
        AND (
          v_user IS NULL
          OR coalesce(entries.payload->>'actor_id', '') = v_user
          OR coalesce(entries.payload->>'actor_username', '') ILIKE '%' || v_user || '%'
          OR profile.display_name ILIKE '%' || v_user || '%'
          OR profile.email ILIKE '%' || v_user || '%'
        )
        AND (p_from IS NULL OR (entries.created_at AT TIME ZONE v_tz)::date >= p_from)
        AND (p_to IS NULL OR (entries.created_at AT TIME ZONE v_tz)::date <= p_to)
      ORDER BY entries.created_at DESC NULLS LAST
      LIMIT 500
    ) AS entry
  );
END;
$$;

COMMENT ON FUNCTION public.auth_sign_ins_read(text, date, date) IS
  'Admin/Admin viewer read of auth.audit_log_entries (login and related). Empty when Auth has not written any.';

REVOKE ALL ON FUNCTION public.auth_sign_ins_read(text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auth_sign_ins_read(text, date, date) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
