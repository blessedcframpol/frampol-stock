-- HY1: database hygiene bundle (grants, josh sound, oversight policy, idempotency_key,
-- duplicate-client DB gate). No outer BEGIN/COMMIT (apply wraps the transaction).

SET lock_timeout = '5s';

-- =============================================================================
-- 1. Write grants only when a matching RLS write policy exists; never TRUNCATE
-- =============================================================================
DO $$
DECLARE
  r record;
  has_ins boolean;
  has_upd boolean;
  has_del boolean;
BEGIN
  FOR r IN
    SELECT c.oid, c.relname, format('%I.%I', n.nspname, c.relname) AS fq
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
  LOOP
    EXECUTE format(
      'REVOKE TRUNCATE ON TABLE %s FROM authenticated, anon',
      r.fq
    );

    SELECT
      EXISTS (
        SELECT 1
        FROM pg_policies p
        WHERE p.schemaname = 'public'
          AND p.tablename = r.relname
          AND (p.cmd = 'INSERT' OR p.cmd = 'ALL')
          AND (
            p.roles = '{public}'
            OR 'authenticated' = ANY (p.roles)
            OR 'anon' = ANY (p.roles)
          )
      ),
      EXISTS (
        SELECT 1
        FROM pg_policies p
        WHERE p.schemaname = 'public'
          AND p.tablename = r.relname
          AND (p.cmd = 'UPDATE' OR p.cmd = 'ALL')
          AND (
            p.roles = '{public}'
            OR 'authenticated' = ANY (p.roles)
            OR 'anon' = ANY (p.roles)
          )
      ),
      EXISTS (
        SELECT 1
        FROM pg_policies p
        WHERE p.schemaname = 'public'
          AND p.tablename = r.relname
          AND (p.cmd = 'DELETE' OR p.cmd = 'ALL')
          AND (
            p.roles = '{public}'
            OR 'authenticated' = ANY (p.roles)
            OR 'anon' = ANY (p.roles)
          )
      )
    INTO has_ins, has_upd, has_del;

    IF has_table_privilege('authenticated', r.oid, 'INSERT') AND NOT has_ins THEN
      EXECUTE format('REVOKE INSERT ON TABLE %s FROM authenticated', r.fq);
    END IF;
    IF has_table_privilege('authenticated', r.oid, 'UPDATE') AND NOT has_upd THEN
      EXECUTE format('REVOKE UPDATE ON TABLE %s FROM authenticated', r.fq);
    END IF;
    IF has_table_privilege('authenticated', r.oid, 'DELETE') AND NOT has_del THEN
      EXECUTE format('REVOKE DELETE ON TABLE %s FROM authenticated', r.fq);
    END IF;
  END LOOP;
END $$;

-- Explicit RPC-only / event tables (idempotent; covers prod if still granted).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'stock_issue_batches',
    'live_stock_events',
    'stock_request_events',
    'notifications',
    'audit_log',
    'audit_daily_digest',
    'audit_trigger_exclusions',
    'profile_access_events',
    'batch_invoices',
    'batch_invoice_events'
  ]
  LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      -- notifications keeps UPDATE policy (mark read); only strip unmatched cmds above.
      IF t = 'notifications' THEN
        EXECUTE format(
          'REVOKE INSERT, DELETE, TRUNCATE ON TABLE public.%I FROM authenticated, anon',
          t
        );
      ELSE
        EXECUTE format(
          'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.%I FROM authenticated, anon',
          t
        );
      END IF;
    END IF;
  END LOOP;
END $$;

-- push_subscriptions: keep INSERT/UPDATE/DELETE (has policies); strip TRUNCATE only.
DO $$
BEGIN
  IF to_regclass('public.push_subscriptions') IS NOT NULL THEN
    REVOKE TRUNCATE ON TABLE public.push_subscriptions FROM authenticated, anon;
  END IF;
END $$;

-- =============================================================================
-- 2. Remove legacy alert sound id 'josh' (map any remaining rows to default chime)
-- =============================================================================
-- Production SELECT count of josh was 0 at Phase 0; still remapped for safety.
UPDATE public.profiles
SET alert_sound_id = 'chime',
    updated_at = now()
WHERE alert_sound_id = 'josh';

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
    'faaah'::text
  ]));

COMMENT ON COLUMN public.profiles.alert_sound_id IS
  'NT2/HY1: alert preset id (chime, soft_ping, bright_ping, attention, alarm, faaah). Default chime; playback off until enabled.';

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
  v_sound_id text := p_sound_id;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'update_my_alert_sound_prefs: not authenticated'
      USING ERRCODE = '42501';
  END IF;

  IF v_sound_id IS NULL OR v_sound_id NOT IN (
    'chime', 'soft_ping', 'bright_ping', 'attention', 'alarm', 'faaah'
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
    alert_sound_id = v_sound_id,
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
  'NT2/HY1: signed-in user updates own alert-sound prefs (no legacy josh id).';

REVOKE ALL ON FUNCTION public.update_my_alert_sound_prefs(boolean, text, numeric)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_my_alert_sound_prefs(boolean, text, numeric)
  TO authenticated, service_role;

-- =============================================================================
-- 3. Oversight SELECT policy: InitPlan wrapper on get_my_role() (idempotent)
-- =============================================================================
DROP POLICY IF EXISTS stock_request_events_select_oversight ON public.stock_request_events;
CREATE POLICY stock_request_events_select_oversight
  ON public.stock_request_events
  FOR SELECT
  TO authenticated
  USING ((SELECT public.get_my_role()) IN ('admin', 'accounts'));

-- =============================================================================
-- 4. Drop unused stock_request_events.idempotency_key (already dropped on test/prod)
-- =============================================================================
ALTER TABLE public.stock_request_events
  DROP COLUMN IF EXISTS idempotency_key;

-- =============================================================================
-- 5. Enforce duplicate-client gate in DB (UI-only today for non-admin creates)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.clients_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_norm_phone text;
  v_dup_count integer;
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

    SELECT count(*)::integer
    INTO v_dup_count
    FROM public.find_client_duplicate_candidates(NEW.email, NEW.phone, NEW.name);

    IF v_dup_count > 0 AND NEW.duplicate_override_reason IS NULL THEN
      RAISE EXCEPTION
        'Possible duplicate client — ask an admin to create it with an override reason'
        USING ERRCODE = 'check_violation';
    END IF;

    PERFORM public.clients_validate_insert_row(NEW);
  ELSIF TG_OP = 'UPDATE' THEN
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

COMMENT ON FUNCTION public.clients_before_write() IS
  'NC1/HY1: sanitize + validate client writes; block duplicate creates without admin override.';

-- =============================================================================
-- 6. Anon must not EXECUTE public RPCs (schema-rules anon_execute_none)
-- =============================================================================
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', r.sig);
  END LOOP;
END $$;
