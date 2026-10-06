-- Tamper-evident audit trail for transactions, inventory items, and clients.
-- Posted transaction fields stay locked. sync_legacy_invoice may still refresh invoice_number.

BEGIN;

CREATE TABLE public.audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name text NOT NULL,
  row_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('insert', 'update', 'delete')),
  changed jsonb NOT NULL,
  actor text NOT NULL,
  source text NOT NULL,
  reason text,
  at timestamptz NOT NULL DEFAULT now(),
  transaction_id bigint NOT NULL DEFAULT txid_current()
);

COMMENT ON TABLE public.audit_log IS
  'Append-only record of inserts, updates, and deletes. Updates store {field: [old, new]} for fields that changed. Admins read it through audit_log_read.';

COMMENT ON COLUMN public.audit_log.actor IS 'auth.uid() when a session is present, otherwise the database role.';
COMMENT ON COLUMN public.audit_log.source IS 'app.movement_type or app.audit_source when set, otherwise direct.';
COMMENT ON COLUMN public.audit_log.reason IS 'Reason typed for an inventory edit or move. Empty for other writes.';
COMMENT ON COLUMN public.audit_log.transaction_id IS 'Database transaction id (txid_current()) of the write.';

CREATE INDEX audit_log_table_at_idx ON public.audit_log (table_name, at DESC, id DESC);
CREATE INDEX audit_log_row_idx ON public.audit_log (table_name, row_id);
CREATE INDEX audit_log_actor_idx ON public.audit_log (actor);

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.audit_log FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.audit_log TO service_role;

CREATE OR REPLACE FUNCTION public.audit_field_changes(p_old jsonb, p_new jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(
    jsonb_object_agg(keys.key, jsonb_build_array(p_old -> keys.key, p_new -> keys.key)),
    '{}'::jsonb
  )
  FROM (
    SELECT jsonb_object_keys(coalesce(p_old, '{}'::jsonb) || coalesce(p_new, '{}'::jsonb)) AS key
  ) AS keys
  WHERE (p_old -> keys.key) IS DISTINCT FROM (p_new -> keys.key);
$$;

REVOKE ALL ON FUNCTION public.audit_field_changes(jsonb, jsonb) FROM PUBLIC, anon, authenticated;

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
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'insert';
    v_new := to_jsonb(NEW);
    v_row := NEW.id::text;
  ELSIF TG_OP = 'UPDATE' THEN
    v_action := 'update';
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    v_row := NEW.id::text;
  ELSE
    v_action := 'delete';
    v_old := to_jsonb(OLD);
    v_row := OLD.id::text;
  END IF;

  v_changed := public.audit_field_changes(v_old, v_new);
  IF v_action = 'update' AND v_changed = '{}'::jsonb THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.audit_log (table_name, row_id, action, changed, actor, source, reason)
  VALUES (
    TG_TABLE_NAME,
    v_row,
    v_action,
    v_changed,
    coalesce(auth.uid()::text, current_user),
    coalesce(
      nullif(current_setting('app.movement_type', true), ''),
      nullif(current_setting('app.audit_source', true), ''),
      'direct'
    ),
    nullif(btrim(coalesce(current_setting('app.audit_reason', true), '')), '')
  );

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_capture() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.audit_log_forbid_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

REVOKE ALL ON FUNCTION public.audit_log_forbid_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tr_audit_log_append_only ON public.audit_log;
CREATE TRIGGER tr_audit_log_append_only
  BEFORE UPDATE OR DELETE ON public.audit_log
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_log_forbid_change();

DROP TRIGGER IF EXISTS tr_transactions_audit ON public.transactions;
CREATE TRIGGER tr_transactions_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_capture();

DROP TRIGGER IF EXISTS tr_inventory_items_audit ON public.inventory_items;
CREATE TRIGGER tr_inventory_items_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.inventory_items
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_capture();

DROP TRIGGER IF EXISTS tr_clients_audit ON public.clients;
CREATE TRIGGER tr_clients_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.clients
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_capture();

CREATE OR REPLACE FUNCTION public.transactions_reject_posted_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_correction text := nullif(current_setting('app.transaction_correction', true), '');
  v_invoice_only boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'transactions: posted rows cannot be deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_invoice_only :=
    v_correction = 'invoice_number'
    AND OLD.invoice_number IS DISTINCT FROM NEW.invoice_number
    AND OLD.type IS NOT DISTINCT FROM NEW.type
    AND OLD.date IS NOT DISTINCT FROM NEW.date
    AND OLD.client IS NOT DISTINCT FROM NEW.client
    AND OLD.client_id IS NOT DISTINCT FROM NEW.client_id
    AND OLD.item_name IS NOT DISTINCT FROM NEW.item_name
    AND OLD.serial_number IS NOT DISTINCT FROM NEW.serial_number
    AND OLD.from_location IS NOT DISTINCT FROM NEW.from_location
    AND OLD.to_location IS NOT DISTINCT FROM NEW.to_location
    AND OLD.batch_id IS NOT DISTINCT FROM NEW.batch_id;

  IF v_invoice_only THEN
    RETURN NEW;
  END IF;

  IF OLD.type IS DISTINCT FROM NEW.type
    OR OLD.date IS DISTINCT FROM NEW.date
    OR OLD.client IS DISTINCT FROM NEW.client
    OR OLD.client_id IS DISTINCT FROM NEW.client_id
    OR OLD.item_name IS DISTINCT FROM NEW.item_name
    OR OLD.serial_number IS DISTINCT FROM NEW.serial_number
    OR OLD.invoice_number IS DISTINCT FROM NEW.invoice_number
    OR OLD.from_location IS DISTINCT FROM NEW.from_location
    OR OLD.to_location IS DISTINCT FROM NEW.to_location
    OR OLD.batch_id IS DISTINCT FROM NEW.batch_id
  THEN
    RAISE EXCEPTION 'transactions: posted fields are locked'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.transactions_reject_posted_change() IS
  'Rejects changes to posted transaction fields and every delete. sync_legacy_invoice sets app.transaction_correction to invoice_number so it can refresh that column only.';

REVOKE ALL ON FUNCTION public.transactions_reject_posted_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tr_transactions_lock_posted ON public.transactions;
CREATE TRIGGER tr_transactions_lock_posted
  BEFORE UPDATE OR DELETE ON public.transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.transactions_reject_posted_change();

CREATE OR REPLACE FUNCTION public.sync_legacy_invoice(p_batch_id text, p_status text, p_number text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM set_config('app.transaction_correction', 'invoice_number', true);
  PERFORM set_config('app.audit_source', 'sync_legacy_invoice', true);
  UPDATE public.transactions
  SET invoice_number = CASE
    WHEN p_status = 'invoiced' THEN p_number
    WHEN p_status = 'not_invoiced' THEN '00000'
    ELSE NULL
  END
  WHERE coalesce(nullif(btrim(batch_id), ''), id) = p_batch_id
    AND type IN ('Sale', 'Rentals');
  PERFORM set_config('app.transaction_correction', '', true);
  PERFORM set_config('app.audit_source', '', true);
END;
$$;

REVOKE ALL ON FUNCTION public.sync_legacy_invoice(text, text, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.apply_inventory_edit(
  p_id text,
  p_patch jsonb,
  p_reason text,
  p_source text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  IF coalesce(public.get_my_role()::text, '') <> 'admin' THEN
    RAISE EXCEPTION 'apply_inventory_edit: admin only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_reason = '' THEN
    RAISE EXCEPTION 'apply_inventory_edit: a reason is required'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_source NOT IN ('edit_item', 'move_group') THEN
    RAISE EXCEPTION 'apply_inventory_edit: unknown source'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_patch IS NULL OR p_patch = '{}'::jsonb THEN
    RAISE EXCEPTION 'apply_inventory_edit: nothing to change'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('app.audit_source', p_source, true);
  PERFORM set_config('app.audit_reason', v_reason, true);

  UPDATE public.inventory_items
  SET
    product_id = CASE WHEN p_patch ? 'product_id' THEN p_patch->>'product_id' ELSE product_id END,
    location = CASE WHEN p_patch ? 'location' THEN p_patch->>'location' ELSE location END,
    notes = CASE WHEN p_patch ? 'notes' THEN nullif(p_patch->>'notes', '') ELSE notes END,
    purchase_date = CASE WHEN p_patch ? 'purchase_date' THEN nullif(p_patch->>'purchase_date', '') ELSE purchase_date END,
    warranty_end_date = CASE WHEN p_patch ? 'warranty_end_date' THEN nullif(p_patch->>'warranty_end_date', '') ELSE warranty_end_date END
  WHERE id = p_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'apply_inventory_edit: item not found'
      USING ERRCODE = 'no_data_found';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.apply_inventory_edit(text, jsonb, text, text) IS
  'Admin edit of a kit product, location, notes, or warranty dates. The reason is stored on the audit row.';

REVOKE ALL ON FUNCTION public.apply_inventory_edit(text, jsonb, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_inventory_edit(text, jsonb, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.audit_log_read(
  p_table text DEFAULT NULL,
  p_row text DEFAULT NULL,
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
  IF coalesce(public.get_my_role()::text, '') <> 'admin' THEN
    RAISE EXCEPTION 'audit_log_read: admin only'
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
        log.table_name,
        log.row_id,
        log.action,
        log.changed,
        log.actor,
        coalesce(nullif(btrim(profile.display_name), ''), profile.email) AS actor_name,
        log.source,
        log.reason,
        log.at,
        log.transaction_id
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
        AND (p_from IS NULL OR (log.at AT TIME ZONE v_tz)::date >= p_from)
        AND (p_to IS NULL OR (log.at AT TIME ZONE v_tz)::date <= p_to)
      ORDER BY log.at DESC, log.id DESC
      LIMIT 500
    ) AS entry
  );
END;
$$;

COMMENT ON FUNCTION public.audit_log_read(text, text, text, date, date) IS
  'Admin read of the audit log. service_role may select the table directly. The screen renders this payload.';

REVOKE ALL ON FUNCTION public.audit_log_read(text, text, text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.audit_log_read(text, text, text, date, date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.kit_history(p_item_id text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_item public.inventory_items%ROWTYPE;
  v_product text;
  v_tz text;
  v_today date;
  v_open jsonb;
  v_last jsonb;
  v_placements jsonb := '[]'::jsonb;
  v_timeline jsonb := '[]'::jsonb;
  v_tags text[] := ARRAY[]::text[];
  v_summary text;
  v_links jsonb := '[]'::jsonb;
  v_open_case uuid;
  v_seen_return boolean := false;
  v_sale_count integer := 0;
  v_resold boolean := false;
  v_rental boolean := false;
  v_demo boolean := false;
  v_decommissioned boolean := false;
  v_days integer;
  v_end text;
  v_from text;
  v_on text;
  rec record;
BEGIN
  IF p_item_id IS NULL OR btrim(p_item_id) = '' THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT * INTO v_item
  FROM public.inventory_items
  WHERE id = p_item_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT line.product_name INTO v_product
  FROM public.product_lines AS line
  WHERE line.id = v_item.product_id;

  SELECT coalesce(
    (SELECT settings.timezone FROM public.app_settings AS settings LIMIT 1),
    'Africa/Harare'
  )
  INTO v_tz;
  v_today := (timezone(v_tz, now()))::date;

  FOR rec IN
    SELECT
      txn.id,
      txn.type,
      txn.date,
      txn.client,
      txn.to_location,
      txn.after_location,
      txn.metadata,
      txn.previous_status,
      txn.batch_id,
      public.batch_is_currently_reversed(coalesce(nullif(btrim(txn.batch_id), ''), txn.id)) AS reversed_now,
      EXISTS (
        SELECT 1
        FROM public.batch_reversals AS reversal
        WHERE reversal.batch_id = txn.batch_id
          AND reversal.kind = 'void'
      ) AS was_void
    FROM public.transactions AS txn
    WHERE txn.serial_number = v_item.serial_number
      AND txn.type IS DISTINCT FROM 'Reversal'
    ORDER BY txn.date ASC, txn.created_at ASC NULLS LAST, txn.id ASC
  LOOP
    IF rec.was_void AND rec.reversed_now THEN
      CONTINUE;
    END IF;
    IF rec.reversed_now THEN
      CONTINUE;
    END IF;

    IF rec.type = 'Sale' THEN
      v_sale_count := v_sale_count + 1;
      IF v_seen_return OR v_sale_count >= 2 THEN
        v_resold := true;
      END IF;
      IF v_open IS NOT NULL
         AND v_open->>'kind' IN ('POC', 'Rental')
         AND coalesce(rec.metadata->>'converted_from', '') IN ('POC', 'POC Out', 'Rentals') THEN
        v_from := v_open->>'kind';
        v_open := v_open || jsonb_build_object(
          'kind', 'Sale',
          'changes', (v_open->'changes') || jsonb_build_array(jsonb_build_object(
            'from', v_from,
            'to', 'Sale',
            'at', left(rec.date, 10),
            'at_label', substring(left(rec.date, 10) FROM 9 FOR 2) || '/' || substring(left(rec.date, 10) FROM 6 FOR 2)
          ))
        );
      ELSE
        IF v_open IS NOT NULL THEN
          v_end := left(rec.date, 10);
          v_days := v_end::date - (v_open->>'start')::date;
          v_open := v_open || jsonb_build_object(
            'end', v_end,
            'end_label', substring(v_end FROM 9 FOR 2) || '/' || substring(v_end FROM 6 FOR 2) || '/' || substring(v_end FROM 1 FOR 4),
            'end_short', substring(v_end FROM 9 FOR 2) || '/' || substring(v_end FROM 6 FOR 2),
            'duration_days', v_days,
            'duration_label', CASE
              WHEN v_days < 60 THEN v_days::text || CASE WHEN v_days = 1 THEN ' day' ELSE ' days' END
              ELSE round(v_days / 30.44)::int::text || CASE WHEN round(v_days / 30.44)::int = 1 THEN ' month' ELSE ' months' END
            END
          );
          v_placements := v_placements || jsonb_build_array(v_open);
          v_last := v_open;
          v_open := NULL;
        END IF;
        v_open := jsonb_build_object(
          'client', nullif(btrim(coalesce(rec.client, '')), ''),
          'location', coalesce(nullif(btrim(coalesce(rec.to_location, '')), ''), nullif(btrim(coalesce(rec.after_location, '')), '')),
          'kind', 'Sale',
          'start', left(rec.date, 10),
          'start_label', substring(left(rec.date, 10) FROM 9 FOR 2) || '/' || substring(left(rec.date, 10) FROM 6 FOR 2) || '/' || substring(left(rec.date, 10) FROM 1 FOR 4),
          'start_short', substring(left(rec.date, 10) FROM 9 FOR 2) || '/' || substring(left(rec.date, 10) FROM 6 FOR 2),
          'end', 'current',
          'end_label', 'current',
          'end_short', 'current',
          'duration_days', v_today - left(rec.date, 10)::date,
          'duration_label', NULL,
          'changes', '[]'::jsonb
        );
      END IF;
    ELSIF rec.type = 'POC Out' THEN
      v_open := jsonb_build_object(
        'client', nullif(btrim(coalesce(rec.client, '')), ''),
        'location', coalesce(nullif(btrim(coalesce(rec.to_location, '')), ''), nullif(btrim(coalesce(rec.after_location, '')), '')),
        'kind', 'POC',
        'start', left(rec.date, 10),
        'start_label', substring(left(rec.date, 10) FROM 9 FOR 2) || '/' || substring(left(rec.date, 10) FROM 6 FOR 2) || '/' || substring(left(rec.date, 10) FROM 1 FOR 4),
        'start_short', substring(left(rec.date, 10) FROM 9 FOR 2) || '/' || substring(left(rec.date, 10) FROM 6 FOR 2),
        'end', 'current',
        'end_label', 'current',
        'end_short', 'current',
        'duration_days', v_today - left(rec.date, 10)::date,
        'duration_label', NULL,
        'changes', '[]'::jsonb
      );
    ELSIF rec.type = 'Rentals' THEN
      v_open := jsonb_build_object(
        'client', nullif(btrim(coalesce(rec.client, '')), ''),
        'location', coalesce(nullif(btrim(coalesce(rec.to_location, '')), ''), nullif(btrim(coalesce(rec.after_location, '')), '')),
        'kind', 'Rental',
        'start', left(rec.date, 10),
        'start_label', substring(left(rec.date, 10) FROM 9 FOR 2) || '/' || substring(left(rec.date, 10) FROM 6 FOR 2) || '/' || substring(left(rec.date, 10) FROM 1 FOR 4),
        'start_short', substring(left(rec.date, 10) FROM 9 FOR 2) || '/' || substring(left(rec.date, 10) FROM 6 FOR 2),
        'end', 'current',
        'end_label', 'current',
        'end_short', 'current',
        'duration_days', v_today - left(rec.date, 10)::date,
        'duration_label', NULL,
        'changes', '[]'::jsonb
      );
    ELSIF rec.type = 'Decommissioned' AND rec.previous_status IS NULL THEN
      v_end := left(rec.date, 10);
      v_placements := v_placements || jsonb_build_array(jsonb_build_object(
        'client', nullif(btrim(coalesce(rec.client, '')), ''),
        'location', coalesce(nullif(btrim(coalesce(rec.to_location, '')), ''), nullif(btrim(coalesce(rec.after_location, '')), '')),
        'kind', 'Decommissioned',
        'start', 'unknown',
        'start_label', 'unknown',
        'start_short', 'unknown',
        'end', v_end,
        'end_label', substring(v_end FROM 9 FOR 2) || '/' || substring(v_end FROM 6 FOR 2) || '/' || substring(v_end FROM 1 FOR 4),
        'end_short', substring(v_end FROM 9 FOR 2) || '/' || substring(v_end FROM 6 FOR 2),
        'duration_days', NULL,
        'duration_label', NULL,
        'changes', '[]'::jsonb
      ));
      v_last := v_placements->-1;
      v_seen_return := true;
    ELSIF rec.type IN ('POC Return', 'Rental Return', 'Decommissioned') THEN
      v_seen_return := true;
      IF v_open IS NOT NULL THEN
        v_end := left(rec.date, 10);
        v_days := CASE
          WHEN v_open->>'start' = 'unknown' THEN NULL
          ELSE v_end::date - (v_open->>'start')::date
        END;
        v_open := v_open || jsonb_build_object(
          'end', v_end,
          'end_label', substring(v_end FROM 9 FOR 2) || '/' || substring(v_end FROM 6 FOR 2) || '/' || substring(v_end FROM 1 FOR 4),
          'end_short', substring(v_end FROM 9 FOR 2) || '/' || substring(v_end FROM 6 FOR 2),
          'duration_days', v_days,
          'duration_label', CASE
            WHEN v_days IS NULL THEN NULL
            WHEN v_days < 60 THEN v_days::text || CASE WHEN v_days = 1 THEN ' day' ELSE ' days' END
            ELSE round(v_days / 30.44)::int::text || CASE WHEN round(v_days / 30.44)::int = 1 THEN ' month' ELSE ' months' END
          END
        );
        v_placements := v_placements || jsonb_build_array(v_open);
        v_last := v_open;
        v_open := NULL;
      END IF;
    END IF;
  END LOOP;

  IF v_open IS NOT NULL AND coalesce(v_open->>'start', '') <> 'unknown' THEN
    v_days := v_today - (v_open->>'start')::date;
    v_open := v_open || jsonb_build_object(
      'end', 'current',
      'end_label', 'current',
      'end_short', 'current',
      'duration_days', v_days,
      'duration_label', CASE
        WHEN v_days < 60 THEN v_days::text || CASE WHEN v_days = 1 THEN ' day' ELSE ' days' END
        ELSE round(v_days / 30.44)::int::text || CASE WHEN round(v_days / 30.44)::int = 1 THEN ' month' ELSE ' months' END
      END
    );
  END IF;

  IF v_open IS NOT NULL AND v_open->>'kind' = 'Sale' THEN
    v_on := coalesce(v_open #>> '{changes,-1,at_label}', v_open->>'start_short');
    v_summary := 'Sold to ' || coalesce(v_open->>'client', 'the client') || ' on ' || v_on;
  ELSIF v_open IS NOT NULL AND v_open->>'kind' = 'Rental' THEN
    v_summary := 'With ' || coalesce(v_open->>'client', 'the client')
      || ' on rental since ' || coalesce(v_open->>'start_short', '')
      || ' (' || coalesce(v_open->>'duration_days', '0') || ' days)';
  ELSIF v_open IS NOT NULL AND v_open->>'kind' = 'POC' THEN
    v_summary := 'With ' || coalesce(v_open->>'client', 'the client')
      || ' on POC since ' || coalesce(v_open->>'start_short', '')
      || ' (' || coalesce(v_open->>'duration_days', '0') || ' days)';
  ELSIF v_last IS NOT NULL AND v_last->>'start' = 'unknown' THEN
    v_summary := 'Returned on ' || coalesce(v_last->>'end_short', '') || ', previous start unknown';
  ELSIF v_last IS NOT NULL AND v_item.status = 'In Stock' THEN
    v_summary := 'Previously at ' || coalesce(v_last->>'client', 'the client')
      || ' for ' || coalesce(v_last->>'duration_label', '0 days')
      || ', now back in stock';
  ELSIF v_item.status = 'Pending Inspection' THEN
    v_summary := 'Returned on ' || coalesce(v_last->>'end_short', '') || ', pending inspection';
  ELSE
    v_summary := v_item.status;
  END IF;

  SELECT
    v_item.stock_pool = 'rental'
    OR EXISTS (
      SELECT 1
      FROM public.transactions AS txn
      WHERE txn.serial_number = v_item.serial_number
        AND txn.type = 'Rentals'
        AND NOT (
          EXISTS (
            SELECT 1 FROM public.batch_reversals AS reversal
            WHERE reversal.batch_id = txn.batch_id AND reversal.kind = 'void'
          )
          AND public.batch_is_currently_reversed(coalesce(nullif(btrim(txn.batch_id), ''), txn.id))
        )
    ),
    v_item.stock_pool = 'demo'
    OR EXISTS (
      SELECT 1 FROM public.transactions AS txn
      WHERE txn.serial_number = v_item.serial_number
        AND txn.after_stock_pool = 'demo'
    )
    OR EXISTS (
      SELECT 1 FROM public.stock_pool_changes AS change
      WHERE change.inventory_item_id = v_item.id
        AND change.to_pool = 'demo'
    ),
    EXISTS (
      SELECT 1
      FROM public.transactions AS txn
      WHERE txn.serial_number = v_item.serial_number
        AND txn.type = 'Decommissioned'
        AND NOT (
          EXISTS (
            SELECT 1 FROM public.batch_reversals AS reversal
            WHERE reversal.batch_id = txn.batch_id AND reversal.kind = 'void'
          )
          AND public.batch_is_currently_reversed(coalesce(nullif(btrim(txn.batch_id), ''), txn.id))
        )
    )
  INTO v_rental, v_demo, v_decommissioned;

  IF v_rental THEN v_tags := array_append(v_tags, 'Rental'); END IF;
  IF v_demo THEN v_tags := array_append(v_tags, 'Demo'); END IF;
  IF v_decommissioned THEN v_tags := array_append(v_tags, 'Decommissioned'); END IF;
  IF v_resold THEN v_tags := array_append(v_tags, 'Resold'); END IF;

  SELECT cases.id INTO v_open_case
  FROM public.kit_cases AS cases
  WHERE cases.inventory_item_id = v_item.id
    AND cases.stage = 'open'
  ORDER BY cases.opened_at ASC
  LIMIT 1;

  IF v_open_case IS NOT NULL THEN
    v_links := v_links || jsonb_build_array(jsonb_build_object(
      'label', 'Open inspection',
      'href', '/inventory/inspections/' || v_open_case::text
    ));
  END IF;
  v_links := v_links || jsonb_build_array(jsonb_build_object(
    'label', 'Inventory',
    'href', '/inventory?serial=' || replace(v_item.serial_number, ' ', '%20')
  ));

  v_timeline := (
  WITH actor AS (
    SELECT id, coalesce(nullif(btrim(display_name), ''), email) AS name
    FROM public.profiles
  ),
  entries AS (
    SELECT
      jsonb_build_object(
        'id', txn.id,
        'sort_at', coalesce(txn.created_at, left(txn.date, 10)::timestamptz),
        'date_label', substring(left(txn.date, 10) FROM 9 FOR 2) || '/' || substring(left(txn.date, 10) FROM 6 FOR 2) || '/' || substring(left(txn.date, 10) FROM 1 FOR 4),
        'kind', txn.type,
        'title', txn.type,
        'detail', concat_ws(
          ' · ',
          nullif(btrim(coalesce(txn.client, '')), ''),
          nullif(btrim(coalesce(txn.to_location, txn.after_location, '')), ''),
          CASE
            WHEN txn.previous_stock_pool IS NOT NULL
             AND txn.after_stock_pool IS NOT NULL
             AND txn.previous_stock_pool IS DISTINCT FROM txn.after_stock_pool
            THEN 'Pool ' || txn.previous_stock_pool || ' to ' || txn.after_stock_pool
            ELSE NULL
          END
        ),
        'who', who.name,
        'reversed', public.batch_is_currently_reversed(coalesce(nullif(btrim(txn.batch_id), ''), txn.id)),
        'voided', EXISTS (
          SELECT 1 FROM public.batch_reversals AS reversal
          WHERE reversal.batch_id = txn.batch_id AND reversal.kind = 'void'
        ),
        'reversal', (
          SELECT jsonb_build_object(
            'reason', reversal.reversal_reason,
            'who', rev_who.name,
            'when', to_char(reversal.reversed_at AT TIME ZONE v_tz, 'DD/MM/YYYY HH24:MI')
          )
          FROM public.batch_reversals AS reversal
          LEFT JOIN actor AS rev_who ON rev_who.id::text = reversal.reversed_by
          WHERE reversal.batch_id = txn.batch_id
        ),
        'restore', (
          SELECT jsonb_build_object(
            'reason', restored.restore_reason,
            'who', res_who.name,
            'when', to_char(restored.restored_at AT TIME ZONE v_tz, 'DD/MM/YYYY HH24:MI')
          )
          FROM public.batch_restores AS restored
          LEFT JOIN actor AS res_who ON res_who.id::text = restored.restored_by
          WHERE restored.batch_id = txn.batch_id
          ORDER BY restored.restored_at DESC
          LIMIT 1
        ),
        'invoice', (
          SELECT jsonb_build_object(
            'status', invoice.status,
            'invoice_number', invoice.invoice_number,
            'approval', invoice.approval
          )
          FROM public.batch_invoices AS invoice
          WHERE invoice.batch_id = coalesce(nullif(btrim(txn.batch_id), ''), txn.id)
        )
      ) AS entry,
      coalesce(txn.created_at, left(txn.date, 10)::timestamptz) AS sort_at,
      txn.id AS sort_id
    FROM public.transactions AS txn
    LEFT JOIN actor AS who ON who.id = txn.created_by
    WHERE txn.serial_number = v_item.serial_number
      AND txn.type IS DISTINCT FROM 'Reversal'

    UNION ALL

    SELECT
      jsonb_build_object(
        'id', event.id::text,
        'sort_at', event.at,
        'date_label', to_char(event.at AT TIME ZONE v_tz, 'DD/MM/YYYY'),
        'kind', event.event_type,
        'title', CASE event.event_type
          WHEN 'opened' THEN 'Intake'
          WHEN 'inspection_recorded' THEN 'Inspection'
          WHEN 'outcome_applied' THEN 'Outcome'
          WHEN 're-closed' THEN 'Re-closed'
          ELSE initcap(replace(event.event_type, '_', ' '))
        END,
        'detail', CASE event.event_type
          WHEN 'opened' THEN cases.reason_category || ': ' || cases.reason_text
          WHEN 'inspection_recorded' THEN concat_ws(
            ' · ',
            nullif(event.payload->>'result', ''),
            nullif(event.payload->>'grade', ''),
            nullif(event.payload->>'comments', '')
          )
          WHEN 'outcome_applied' THEN nullif(event.payload->>'outcome', '')
          ELSE nullif(btrim(coalesce(event.reason, event.payload->>'note', '')), '')
        END,
        'who', who.name,
        'reversed', false,
        'voided', false,
        'reversal', NULL,
        'restore', NULL,
        'invoice', NULL
      ),
      event.at,
      event.id::text
    FROM public.kit_case_events AS event
    JOIN public.kit_cases AS cases ON cases.id = event.case_id
    LEFT JOIN actor AS who ON who.id = event.actor
    WHERE cases.inventory_item_id = v_item.id

    UNION ALL

    SELECT
      jsonb_build_object(
        'id', change.id::text,
        'sort_at', change.changed_at,
        'date_label', to_char(change.changed_at AT TIME ZONE v_tz, 'DD/MM/YYYY'),
        'kind', 'stock_pool',
        'title', 'Stock pool',
        'detail', change.from_pool || ' to ' || change.to_pool || '. ' || change.reason,
        'who', who.name,
        'reversed', false,
        'voided', false,
        'reversal', NULL,
        'restore', NULL,
        'invoice', NULL
      ),
      change.changed_at,
      change.id::text
    FROM public.stock_pool_changes AS change
    LEFT JOIN actor AS who ON who.id = change.changed_by
    WHERE change.inventory_item_id = v_item.id

    UNION ALL

    SELECT
      jsonb_build_object(
        'id', extension.id::text,
        'sort_at', extension.created_at,
        'date_label', to_char(extension.created_at AT TIME ZONE v_tz, 'DD/MM/YYYY'),
        'kind', 'holding_extension',
        'title', 'Holding extension',
        'detail', concat_ws(
          ' ',
          'Return date',
          coalesce(extension.previous_date, 'none'),
          'to',
          extension.new_date || '.',
          extension.reason
        ),
        'who', who.name,
        'reversed', false,
        'voided', false,
        'reversal', NULL,
        'restore', NULL,
        'invoice', NULL
      ),
      extension.created_at,
      extension.id::text
    FROM public.holding_extensions AS extension
    LEFT JOIN actor AS who ON who.id = extension.extended_by
    WHERE extension.item_id = v_item.id

    UNION ALL

    SELECT
      jsonb_build_object(
        'id', extension.id::text || ':cancel',
        'sort_at', extension.cancelled_at,
        'date_label', to_char(extension.cancelled_at AT TIME ZONE v_tz, 'DD/MM/YYYY'),
        'kind', 'holding_cancellation',
        'title', 'Holding cancellation',
        'detail', extension.cancel_reason,
        'who', who.name,
        'reversed', false,
        'voided', false,
        'reversal', NULL,
        'restore', NULL,
        'invoice', NULL
      ),
      extension.cancelled_at,
      extension.id::text || ':cancel'
    FROM public.holding_extensions AS extension
    LEFT JOIN actor AS who ON who.id = extension.cancelled_by
    WHERE extension.item_id = v_item.id
      AND extension.cancelled_at IS NOT NULL

    UNION ALL

    SELECT
      jsonb_build_object(
        'id', 'audit:' || log.id::text,
        'sort_at', log.at,
        'date_label', to_char(log.at AT TIME ZONE v_tz, 'DD/MM/YYYY'),
        'kind', 'kit_edit',
        'title', CASE
          WHEN log.changed ? 'product_id' THEN
            'Product changed from '
            || coalesce(old_line.product_name, nullif(log.changed #>> '{product_id,0}', ''), 'empty')
            || ' to '
            || coalesce(new_line.product_name, nullif(log.changed #>> '{product_id,1}', ''), 'empty')
          ELSE 'Kit edit'
        END,
        'detail', concat_ws(
          ' · ',
          nullif(btrim(coalesce(log.reason, '')), ''),
          CASE
            WHEN log.changed ? 'location' THEN
              'Location ' || coalesce(nullif(log.changed #>> '{location,0}', ''), 'empty')
              || ' to ' || coalesce(nullif(log.changed #>> '{location,1}', ''), 'empty')
            ELSE NULL
          END,
          CASE WHEN log.changed ? 'notes' THEN 'Notes changed' ELSE NULL END,
          CASE WHEN log.changed ? 'purchase_date' THEN 'Purchase date changed' ELSE NULL END,
          CASE WHEN log.changed ? 'warranty_end_date' THEN 'Warranty end changed' ELSE NULL END
        ),
        'who', edit_who.name,
        'reversed', false,
        'voided', false,
        'reversal', NULL,
        'restore', NULL,
        'invoice', NULL
      ),
      log.at,
      'audit:' || log.id::text
    FROM public.audit_log AS log
    LEFT JOIN actor AS edit_who ON edit_who.id::text = log.actor
    LEFT JOIN public.product_lines AS old_line ON old_line.id = log.changed #>> '{product_id,0}'
    LEFT JOIN public.product_lines AS new_line ON new_line.id = log.changed #>> '{product_id,1}'
    WHERE log.table_name = 'inventory_items'
      AND log.row_id = v_item.id
      AND log.action = 'update'
      AND log.source IN ('edit_item', 'move_group')
  )
  SELECT coalesce(jsonb_agg(entry ORDER BY sort_at DESC, sort_id DESC), '[]'::jsonb)
  FROM entries
  );

  IF v_open IS NOT NULL THEN
    v_placements := v_placements || jsonb_build_array(v_open);
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'item_id', v_item.id,
    'serial', v_item.serial_number,
    'product', v_product,
    'status', v_item.status,
    'summary', v_summary,
    'tags', to_jsonb(v_tags),
    'placements', v_placements,
    'timeline', v_timeline,
    'links', v_links
  );
END;
$$;

COMMENT ON FUNCTION public.kit_history(text) IS
  'Ordered kit timeline, placements, summary line, and tags. The app renders this and does not rebuild history from rows.';

REVOKE ALL ON FUNCTION public.kit_history(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kit_history(text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
