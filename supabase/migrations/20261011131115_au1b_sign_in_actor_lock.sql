-- AU1b: record Microsoft sign-ins into audit_log; lock maintenance actor override
-- to non-app database roles (not authenticated / anon / service_role JWT).
-- No BEGIN/COMMIT: rehearse and apply wrap their own transactions.

-- -----------------------------------------------------------------------------
-- 1. Allow action = sign_in on audit_log
-- -----------------------------------------------------------------------------
ALTER TABLE public.audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE public.audit_log
  ADD CONSTRAINT audit_log_action_check
  CHECK (action IN ('insert', 'update', 'delete', 'sign_in'));

COMMENT ON COLUMN public.audit_log.action IS
  'insert|update|delete from table triggers; sign_in from record_sign_in after Microsoft OAuth.';

-- -----------------------------------------------------------------------------
-- 2. audit_capture: maintenance override only without an app JWT role
-- -----------------------------------------------------------------------------
-- Inside this SECURITY DEFINER trigger current_user is the function owner, so we
-- gate on auth.role() (JWT): authenticated / anon / service_role cannot spoof
-- app.audit_source=maintenance or app.audit_actor. Migrations run as postgres
-- with no JWT → override still works.

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
  v_raw_source text;
  v_jwt_role text := coalesce(auth.role(), '');
  v_maintenance_ok boolean;
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

  v_raw_source := coalesce(
    nullif(current_setting('app.movement_type', true), ''),
    nullif(current_setting('app.audit_source', true), ''),
    'direct'
  );
  v_reason := nullif(btrim(coalesce(current_setting('app.audit_reason', true), '')), '');

  -- App JWT roles cannot claim maintenance or rename the actor.
  v_maintenance_ok :=
    v_raw_source = 'maintenance'
    AND v_jwt_role NOT IN ('authenticated', 'anon', 'service_role');

  IF v_maintenance_ok THEN
    v_source := 'maintenance';
    v_actor := coalesce(
      nullif(btrim(current_setting('app.audit_actor', true)), ''),
      'maintenance'
    );
  ELSE
    IF v_raw_source = 'maintenance' THEN
      v_source := coalesce(nullif(current_setting('app.movement_type', true), ''), 'direct');
    ELSE
      v_source := v_raw_source;
    END IF;
    v_actor := coalesce(auth.uid()::text, session_user);
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

COMMENT ON FUNCTION public.audit_capture() IS
  'A1 audit trigger. app.audit_source=maintenance and app.audit_actor apply only when auth.role() is not authenticated, anon, or service_role (migration owner).';

-- -----------------------------------------------------------------------------
-- 3. record_sign_in — one audit row per successful Microsoft OAuth callback
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_sign_in(
  p_ip text DEFAULT NULL,
  p_user_agent text DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_actor text;
  v_changed jsonb;
  v_at timestamptz := clock_timestamp();
  v_txid bigint := txid_current();
  v_prev_seq bigint;
  v_prev_hash text;
  v_seq bigint;
  v_canonical text;
  v_hash text;
  v_id bigint;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'record_sign_in: signed-in user required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_actor := v_uid::text;
  v_changed := jsonb_strip_nulls(jsonb_build_object(
    'ip', to_jsonb(nullif(btrim(coalesce(p_ip, '')), '')),
    'user_agent', to_jsonb(nullif(btrim(coalesce(p_user_agent, '')), ''))
  ));

  PERFORM pg_advisory_xact_lock(872314001);

  SELECT coalesce(max(seq), 0) INTO v_prev_seq FROM public.audit_log;
  IF v_prev_seq > 0 THEN
    SELECT row_hash INTO v_prev_hash FROM public.audit_log WHERE seq = v_prev_seq;
  ELSE
    v_prev_hash := '';
  END IF;

  v_seq := v_prev_seq + 1;
  v_canonical := public.audit_row_canonical(
    'auth', v_actor, 'sign_in', v_changed, v_actor, 'sign_in', NULL, v_at, v_txid
  );
  v_hash := encode(
    extensions.digest(coalesce(v_prev_hash, '') || v_canonical, 'sha256'),
    'hex'
  );

  INSERT INTO public.audit_log (
    table_name, row_id, action, changed, actor, source, reason, at, transaction_id, seq, row_hash
  )
  VALUES (
    'auth', v_actor, 'sign_in', v_changed, v_actor, 'sign_in', NULL, v_at, v_txid, v_seq, v_hash
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.record_sign_in(text, text) IS
  'Writes one audit_log sign_in row for the current auth.uid(). Called once from the OAuth callback, not on token refresh.';

REVOKE ALL ON FUNCTION public.record_sign_in(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_sign_in(text, text) TO authenticated, service_role;

-- Prefer audit_log sign_ins in the reader used by Settings → Audit (keep auth.audit_log_entries as fallback empty).
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
        log.id::text AS id,
        log.at,
        nullif(log.changed->>'ip', '') AS ip_address,
        'sign_in'::text AS action,
        log.actor AS actor_id,
        profile.email AS actor_email,
        coalesce(nullif(btrim(profile.display_name), ''), profile.email) AS actor_name,
        log.changed->>'user_agent' AS user_agent,
        log.changed AS payload
      FROM public.audit_log AS log
      LEFT JOIN public.profiles AS profile ON profile.id::text = log.actor
      WHERE log.action = 'sign_in'
        AND (
          v_user IS NULL
          OR log.actor = v_user
          OR profile.display_name ILIKE '%' || v_user || '%'
          OR profile.email ILIKE '%' || v_user || '%'
        )
        AND (p_from IS NULL OR (log.at AT TIME ZONE v_tz)::date >= p_from)
        AND (p_to IS NULL OR (log.at AT TIME ZONE v_tz)::date <= p_to)
      ORDER BY log.at DESC
      LIMIT 500
    ) AS entry
  );
END;
$$;

COMMENT ON FUNCTION public.auth_sign_ins_read(text, date, date) IS
  'Admin/Admin viewer read of audit_log sign_in rows (Microsoft OAuth callbacks).';

REVOKE ALL ON FUNCTION public.auth_sign_ins_read(text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auth_sign_ins_read(text, date, date) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
