-- One invoice record per movement batch. transactions.invoice_number stays as a legacy column.
-- Sale and Rentals (including POC and rental conversions) must be invoiced, pending, or 00000.

BEGIN;

CREATE OR REPLACE FUNCTION public.real_invoice_number_problem(p_number text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_number text := btrim(coalesce(p_number, ''));
BEGIN
  IF v_number = '' THEN
    RETURN 'Invoice number is required';
  END IF;
  IF v_number = '-' OR upper(v_number) IN ('N/A', 'NA') THEN
    RETURN 'That invoice value is a placeholder';
  END IF;
  IF v_number ~ '^0+$' THEN
    IF v_number = '00000' THEN
      RETURN '00000 is not an invoice number';
    END IF;
    RETURN 'That invoice value is a placeholder';
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.real_invoice_number_problem(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.real_invoice_number_problem(text) TO authenticated, service_role;

CREATE TABLE public.batch_invoices (
  batch_id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('invoiced', 'pending', 'not_invoiced', 'legacy_unreviewed')),
  invoice_number text,
  not_invoiced_reason text,
  entered_by uuid,
  entered_at timestamptz,
  approval text,
  approved_by uuid,
  approved_at timestamptz,
  rejection_reason text,
  legacy boolean NOT NULL DEFAULT false,
  CONSTRAINT batch_invoices_number_chk CHECK (
    (status = 'invoiced' AND invoice_number IS NOT NULL AND public.real_invoice_number_problem(invoice_number) IS NULL)
    OR (status <> 'invoiced' AND invoice_number IS NULL)
  ),
  CONSTRAINT batch_invoices_reason_chk CHECK (
    status <> 'not_invoiced'
    OR (not_invoiced_reason IS NOT NULL AND char_length(btrim(not_invoiced_reason)) >= 15)
  ),
  CONSTRAINT batch_invoices_approval_chk CHECK (
    (status = 'not_invoiced' AND approval IN ('awaiting', 'approved'))
    OR (status <> 'not_invoiced' AND approval IS NULL)
  )
);

CREATE TABLE public.batch_invoice_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id text NOT NULL REFERENCES public.batch_invoices (batch_id) ON DELETE CASCADE,
  old_status text,
  new_status text,
  old_invoice_number text,
  new_invoice_number text,
  old_approval text,
  new_approval text,
  actor_id uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX batch_invoice_events_batch_created
  ON public.batch_invoice_events (batch_id, created_at);

COMMENT ON TABLE public.batch_invoices IS
  'One invoice state per movement batch. transactions.invoice_number is the legacy copy.';
COMMENT ON TABLE public.batch_invoice_events IS
  'Append-only history of invoice changes. Deletes happen only when the invoice row is removed.';
COMMENT ON COLUMN public.transactions.invoice_number IS
  'Legacy copy. Readers use batch_invoices. Kept so existing order grouping still sees the stored value.';

-- 217 active Sale rows of 00000 sit in 188 batches. 253 active Sale rows that are null, blank, or N/A
-- sit in 109 batches. No batch mixes invoice values, so one record classifies every row in it.
INSERT INTO public.batch_invoices (
  batch_id, status, invoice_number, entered_by, entered_at, legacy
)
SELECT
  grouped.batch_id,
  grouped.status,
  CASE WHEN grouped.status = 'invoiced' THEN grouped.invoice_number ELSE NULL END,
  grouped.entered_by,
  grouped.entered_at,
  grouped.status IN ('legacy_unreviewed', 'pending')
FROM (
  SELECT
    coalesce(nullif(btrim(t.batch_id), ''), t.id) AS batch_id,
    CASE
      WHEN bool_or(t.type = 'Sale' AND t.invoice_number = '00000') THEN 'legacy_unreviewed'
      WHEN bool_or(
        t.type = 'Sale'
        AND (
          t.invoice_number IS NULL
          OR btrim(t.invoice_number) = ''
          OR upper(btrim(t.invoice_number)) = 'N/A'
        )
      ) THEN 'pending'
      WHEN NOT bool_or(t.type = 'Sale') AND bool_or(t.invoice_number = '00000') THEN 'legacy_unreviewed'
      WHEN NOT bool_or(t.type = 'Sale') AND bool_or(
        t.invoice_number IS NULL
        OR btrim(t.invoice_number) = ''
        OR upper(btrim(t.invoice_number)) = 'N/A'
      ) THEN 'pending'
      ELSE 'invoiced'
    END AS status,
    (
      array_agg(btrim(t.invoice_number) ORDER BY t.created_at DESC NULLS LAST, t.id DESC)
      FILTER (
        WHERE t.invoice_number IS NOT NULL
          AND btrim(t.invoice_number) <> ''
          AND upper(btrim(t.invoice_number)) <> 'N/A'
          AND t.invoice_number <> '00000'
          AND public.real_invoice_number_problem(t.invoice_number) IS NULL
      )
    )[1] AS invoice_number,
    (
      array_agg(t.created_by ORDER BY t.created_at ASC NULLS LAST, t.id ASC)
      FILTER (WHERE t.created_by IS NOT NULL)
    )[1] AS entered_by,
    coalesce(min(t.created_at), now()) AS entered_at
  FROM public.active_transactions AS t
  WHERE t.type IN ('Sale', 'Rentals')
  GROUP BY 1
) AS grouped
WHERE grouped.status <> 'invoiced' OR grouped.invoice_number IS NOT NULL;

CREATE OR REPLACE FUNCTION public.write_batch_invoice_event(
  p_batch_id text,
  p_old public.batch_invoices,
  p_new_status text,
  p_new_number text,
  p_new_approval text,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.batch_invoice_events (
    batch_id, old_status, new_status, old_invoice_number, new_invoice_number,
    old_approval, new_approval, actor_id, reason
  ) VALUES (
    p_batch_id,
    p_old.status,
    p_new_status,
    p_old.invoice_number,
    p_new_number,
    p_old.approval,
    p_new_approval,
    auth.uid(),
    NULLIF(btrim(coalesce(p_reason, '')), '')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.write_batch_invoice_event(text, public.batch_invoices, text, text, text, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.sync_legacy_invoice(p_batch_id text, p_status text, p_number text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.transactions
  SET invoice_number = CASE
    WHEN p_status = 'invoiced' THEN p_number
    WHEN p_status = 'not_invoiced' THEN '00000'
    ELSE NULL
  END
  WHERE coalesce(nullif(btrim(batch_id), ''), id) = p_batch_id
    AND type IN ('Sale', 'Rentals');
END;
$$;

REVOKE ALL ON FUNCTION public.sync_legacy_invoice(text, text, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.stamp_batch_invoice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_choice text;
  v_reason text;
  v_number text;
  v_batch text;
  v_problem text;
  v_existing public.batch_invoices%ROWTYPE;
  v_actor uuid;
BEGIN
  IF NEW.type IS DISTINCT FROM 'Sale' AND NEW.type IS DISTINCT FROM 'Rentals' THEN
    RETURN NEW;
  END IF;

  v_batch := coalesce(nullif(btrim(NEW.batch_id), ''), NEW.id);
  v_choice := nullif(btrim(coalesce(NEW.metadata->>'invoice_choice', '')), '');
  v_reason := btrim(coalesce(NEW.metadata->>'invoice_reason', ''));
  v_number := btrim(coalesce(NEW.invoice_number, ''));
  v_actor := coalesce(NEW.created_by, auth.uid());

  IF v_choice IS NULL THEN
    IF v_number <> '' AND public.real_invoice_number_problem(v_number) IS NULL THEN
      v_choice := 'number';
    ELSIF v_number <> '' THEN
      RAISE EXCEPTION '%', public.real_invoice_number_problem(v_number);
    ELSIF NEW.created_by IS NULL THEN
      -- Movement scripts insert a sale without a recorder. The app always sets created_by.
      RETURN NEW;
    ELSE
      RAISE EXCEPTION 'Sale and Rentals need an invoice number, Invoice pending, or 00000 — not invoiced';
    END IF;
  END IF;

  IF v_choice = 'number' THEN
    v_problem := public.real_invoice_number_problem(v_number);
    IF v_problem IS NOT NULL THEN
      RAISE EXCEPTION '%', v_problem;
    END IF;
    NEW.invoice_number := v_number;
  ELSIF v_choice = 'pending' THEN
    IF v_number <> '' THEN
      RAISE EXCEPTION 'Invoice pending does not take a number';
    END IF;
    NEW.invoice_number := NULL;
  ELSIF v_choice = 'not_invoiced' THEN
    IF char_length(v_reason) < 15 THEN
      RAISE EXCEPTION '00000 needs a reason of at least 15 characters';
    END IF;
    NEW.invoice_number := '00000';
  ELSE
    RAISE EXCEPTION 'Invoice choice must be a number, Invoice pending, or 00000 — not invoiced';
  END IF;

  SELECT * INTO v_existing FROM public.batch_invoices WHERE batch_id = v_batch FOR UPDATE;
  IF FOUND THEN
    IF v_choice = 'number' AND (v_existing.status IS DISTINCT FROM 'invoiced' OR v_existing.invoice_number IS DISTINCT FROM v_number) THEN
      RAISE EXCEPTION 'This batch already has a different invoice';
    END IF;
    IF v_choice = 'pending' AND v_existing.status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'This batch already has a different invoice';
    END IF;
    IF v_choice = 'not_invoiced' AND (
      v_existing.status IS DISTINCT FROM 'not_invoiced'
      OR btrim(coalesce(v_existing.not_invoiced_reason, '')) IS DISTINCT FROM v_reason
    ) THEN
      RAISE EXCEPTION 'This batch already has a different invoice';
    END IF;
    RETURN NEW;
  END IF;

  INSERT INTO public.batch_invoices (
    batch_id, status, invoice_number, not_invoiced_reason, entered_by, entered_at, approval, legacy
  ) VALUES (
    v_batch,
    CASE v_choice WHEN 'number' THEN 'invoiced' WHEN 'pending' THEN 'pending' ELSE 'not_invoiced' END,
    CASE WHEN v_choice = 'number' THEN v_number ELSE NULL END,
    CASE WHEN v_choice = 'not_invoiced' THEN v_reason ELSE NULL END,
    v_actor,
    now(),
    CASE WHEN v_choice = 'not_invoiced' THEN 'awaiting' ELSE NULL END,
    false
  );

  INSERT INTO public.batch_invoice_events (
    batch_id, old_status, new_status, old_invoice_number, new_invoice_number,
    old_approval, new_approval, actor_id, reason
  ) VALUES (
    v_batch,
    NULL,
    CASE v_choice WHEN 'number' THEN 'invoiced' WHEN 'pending' THEN 'pending' ELSE 'not_invoiced' END,
    NULL,
    CASE WHEN v_choice = 'number' THEN v_number ELSE NULL END,
    NULL,
    CASE WHEN v_choice = 'not_invoiced' THEN 'awaiting' ELSE NULL END,
    v_actor,
    CASE WHEN v_choice = 'not_invoiced' THEN v_reason ELSE NULL END
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_transactions_batch_invoice ON public.transactions;
CREATE TRIGGER tr_transactions_batch_invoice
  BEFORE INSERT ON public.transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_batch_invoice();

REVOKE ALL ON FUNCTION public.stamp_batch_invoice() FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.set_batch_invoice(
  p_batch_id text,
  p_choice text,
  p_invoice_number text,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.batch_invoices%ROWTYPE;
  v_choice text := btrim(coalesce(p_choice, ''));
  v_number text := btrim(coalesce(p_invoice_number, ''));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_problem text;
  v_status text;
  v_approval text;
  v_stored_number text;
  v_stored_reason text;
BEGIN
  IF public.get_my_role() IS DISTINCT FROM 'admin' AND public.get_my_role() IS DISTINCT FROM 'accounts' THEN
    RAISE EXCEPTION 'Only admin or accounts can change an invoice';
  END IF;
  IF v_choice NOT IN ('number', 'pending', 'not_invoiced') THEN
    RAISE EXCEPTION 'Invoice choice must be a number, Invoice pending, or 00000 — not invoiced';
  END IF;

  SELECT * INTO v_row FROM public.batch_invoices WHERE batch_id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice record was not found';
  END IF;
  IF v_row.status = 'not_invoiced' AND v_row.approval = 'awaiting' THEN
    RAISE EXCEPTION 'This invoice is awaiting approval';
  END IF;
  IF v_row.status = 'not_invoiced' AND v_row.approval = 'approved' THEN
    RAISE EXCEPTION 'This invoice is already approved';
  END IF;

  IF v_choice = 'number' THEN
    v_problem := public.real_invoice_number_problem(v_number);
    IF v_problem IS NOT NULL THEN
      RAISE EXCEPTION '%', v_problem;
    END IF;
    IF v_row.status = 'invoiced' AND v_row.invoice_number = v_number THEN
      RETURN;
    END IF;
    IF v_row.status = 'invoiced' AND char_length(v_reason) < 15 THEN
      RAISE EXCEPTION 'A reason of at least 15 characters is required to change an invoice number';
    END IF;
    v_status := 'invoiced';
    v_approval := NULL;
    v_stored_number := v_number;
    v_stored_reason := NULL;
  ELSIF v_choice = 'pending' THEN
    IF v_row.status IS DISTINCT FROM 'legacy_unreviewed' THEN
      RAISE EXCEPTION 'Only an unreviewed 00000 can be marked pending';
    END IF;
    v_status := 'pending';
    v_approval := NULL;
    v_stored_number := NULL;
    v_stored_reason := NULL;
  ELSE
    IF v_row.status NOT IN ('pending', 'legacy_unreviewed') THEN
      RAISE EXCEPTION 'Only a pending or unreviewed invoice can be marked not invoiced';
    END IF;
    IF char_length(v_reason) < 15 THEN
      RAISE EXCEPTION '00000 needs a reason of at least 15 characters';
    END IF;
    v_status := 'not_invoiced';
    v_approval := 'awaiting';
    v_stored_number := NULL;
    v_stored_reason := v_reason;
  END IF;

  PERFORM public.write_batch_invoice_event(p_batch_id, v_row, v_status, v_stored_number, v_approval, v_reason);

  UPDATE public.batch_invoices
  SET
    status = v_status,
    invoice_number = v_stored_number,
    not_invoiced_reason = v_stored_reason,
    approval = v_approval,
    approved_by = NULL,
    approved_at = NULL,
    rejection_reason = NULL,
    entered_by = CASE
      WHEN v_status = 'not_invoiced' OR v_row.status = 'legacy_unreviewed' THEN auth.uid()
      ELSE entered_by
    END,
    entered_at = CASE
      WHEN v_status = 'not_invoiced' OR v_row.status = 'legacy_unreviewed' THEN now()
      ELSE entered_at
    END
  WHERE batch_id = p_batch_id;

  PERFORM public.sync_legacy_invoice(p_batch_id, v_status, v_stored_number);
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_batch_invoice(p_batch_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.batch_invoices%ROWTYPE;
BEGIN
  IF public.get_my_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only an admin can approve this invoice';
  END IF;
  SELECT * INTO v_row FROM public.batch_invoices WHERE batch_id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice record was not found';
  END IF;
  IF v_row.status IS DISTINCT FROM 'not_invoiced' OR v_row.approval IS DISTINCT FROM 'awaiting' THEN
    RAISE EXCEPTION 'This invoice is not awaiting approval';
  END IF;
  IF v_row.entered_by IS NULL OR v_row.entered_by = auth.uid() THEN
    RAISE EXCEPTION 'You cannot approve an invoice you entered';
  END IF;

  PERFORM public.write_batch_invoice_event(p_batch_id, v_row, 'not_invoiced', NULL, 'approved', NULL);

  UPDATE public.batch_invoices
  SET approval = 'approved', approved_by = auth.uid(), approved_at = now()
  WHERE batch_id = p_batch_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_batch_invoice(p_batch_id text, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.batch_invoices%ROWTYPE;
  v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  IF public.get_my_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only an admin can reject this invoice';
  END IF;
  IF char_length(v_reason) < 15 THEN
    RAISE EXCEPTION 'A reason is required to reject this invoice';
  END IF;
  SELECT * INTO v_row FROM public.batch_invoices WHERE batch_id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice record was not found';
  END IF;
  IF v_row.status IS DISTINCT FROM 'not_invoiced' OR v_row.approval IS DISTINCT FROM 'awaiting' THEN
    RAISE EXCEPTION 'This invoice is not awaiting approval';
  END IF;

  PERFORM public.write_batch_invoice_event(p_batch_id, v_row, 'pending', NULL, NULL, v_reason);

  UPDATE public.batch_invoices
  SET
    status = 'pending',
    approval = NULL,
    not_invoiced_reason = NULL,
    invoice_number = NULL,
    approved_by = NULL,
    approved_at = NULL,
    rejection_reason = v_reason
  WHERE batch_id = p_batch_id;

  PERFORM public.sync_legacy_invoice(p_batch_id, 'pending', NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.set_batch_invoice(text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.approve_batch_invoice(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reject_batch_invoice(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_batch_invoice(text, text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.approve_batch_invoice(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reject_batch_invoice(text, text) TO authenticated, service_role;

ALTER TABLE public.batch_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.batch_invoice_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS batch_invoices_select ON public.batch_invoices;
CREATE POLICY batch_invoices_select
  ON public.batch_invoices FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS batch_invoice_events_select ON public.batch_invoice_events;
CREATE POLICY batch_invoice_events_select
  ON public.batch_invoice_events FOR SELECT TO authenticated
  USING (true);

REVOKE ALL ON TABLE public.batch_invoices FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.batch_invoice_events FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.batch_invoices TO authenticated, service_role;
GRANT SELECT ON TABLE public.batch_invoice_events TO authenticated, service_role;

CREATE OR REPLACE VIEW public.batch_invoice_list
WITH (security_invoker = true) AS
SELECT
  bi.batch_id,
  bi.status,
  bi.invoice_number,
  bi.not_invoiced_reason,
  bi.entered_by,
  bi.entered_at,
  bi.approval,
  bi.approved_by,
  bi.approved_at,
  bi.rejection_reason,
  bi.legacy,
  lines.movement_type,
  lines.client_name,
  lines.quantity,
  lines.serials,
  lines.product_name,
  lines.sale_date,
  CASE
    WHEN bi.entered_at IS NULL THEN NULL
    ELSE (
      (now() AT TIME ZONE coalesce((SELECT timezone FROM public.app_settings LIMIT 1), 'Africa/Harare'))::date
      - (bi.entered_at AT TIME ZONE coalesce((SELECT timezone FROM public.app_settings LIMIT 1), 'Africa/Harare'))::date
    )::int
  END AS days_waiting
FROM public.batch_invoices AS bi
JOIN LATERAL (
  SELECT
    (array_agg(t.type ORDER BY t.date DESC, t.id DESC))[1] AS movement_type,
    (array_agg(nullif(btrim(t.client), '') ORDER BY t.date DESC, t.id DESC))[1] AS client_name,
    count(*)::int AS quantity,
    string_agg(t.serial_number, ', ' ORDER BY t.serial_number) AS serials,
    string_agg(DISTINCT t.item_name, ', ' ORDER BY t.item_name) AS product_name,
    max(left(t.date, 10)) AS sale_date
  FROM public.active_transactions AS t
  WHERE coalesce(nullif(btrim(t.batch_id), ''), t.id) = bi.batch_id
    AND t.type IN ('Sale', 'Rentals')
) AS lines ON lines.quantity > 0;

COMMENT ON VIEW public.batch_invoice_list IS
  'Invoice batches that still have an active Sale or Rentals row.';

REVOKE ALL ON public.batch_invoice_list FROM PUBLIC, anon;
GRANT SELECT ON public.batch_invoice_list TO authenticated, service_role;

-- Dispatched search and the invoice column read the batch invoice for Sale and Rentals.
CREATE OR REPLACE FUNCTION public.dispatched_page(
  p_limit integer,
  p_offset integer,
  p_movement text DEFAULT NULL,
  p_from text DEFAULT NULL,
  p_to text DEFAULT NULL,
  p_search text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH params AS (
    SELECT
      NULLIF(lower(btrim(coalesce(p_search, ''))), '') AS needle,
      CASE WHEN p_from ~ '^\d{4}-\d{2}-\d{2}$' THEN p_from ELSE NULL END AS from_day,
      CASE WHEN p_to ~ '^\d{4}-\d{2}-\d{2}$' THEN p_to ELSE NULL END AS to_day,
      NULLIF(btrim(coalesce(p_movement, '')), '') AS movement
  ),
  live AS (
    SELECT
      item.id,
      item.serial_number,
      item.status,
      item.client,
      item.assigned_to,
      item.date_added,
      item.poc_out_date,
      line.product_name
    FROM public.inventory_items AS item
    LEFT JOIN public.product_lines AS line ON line.id = item.product_id
    WHERE item.deleted_at IS NULL
      AND item.status IN ('Sold', 'POC', 'Rented', 'Disposed', 'Maintenance')
  ),
  latest AS (
    SELECT DISTINCT ON (live.serial_number)
      live.id,
      live.serial_number,
      live.status,
      coalesce(nullif(btrim(live.product_name), ''), '—') AS product_name,
      txn.id AS txn_id,
      txn.batch_id,
      txn.type AS txn_type,
      txn.date AS txn_date,
      txn.created_at,
      txn.client_id,
      txn.client AS txn_client,
      txn.invoice_number,
      live.client,
      live.assigned_to,
      live.date_added,
      live.poc_out_date
    FROM live
    LEFT JOIN public.transactions AS txn
      ON txn.serial_number = live.serial_number
     AND txn.type IN ('Sale', 'POC Out', 'Rentals', 'Dispose')
    ORDER BY live.serial_number, left(txn.date, 10) DESC NULLS LAST, txn.created_at DESC NULLS LAST, txn.id DESC
  ),
  shaped AS (
    SELECT
      latest.id,
      latest.serial_number,
      latest.product_name,
      CASE
        WHEN latest.txn_type IN ('Sale', 'Rentals') THEN coalesce(
          CASE inv.status
            WHEN 'invoiced' THEN inv.invoice_number
            WHEN 'pending' THEN 'Invoice pending'
            WHEN 'legacy_unreviewed' THEN '00000 — unreviewed'
            WHEN 'not_invoiced' THEN CASE inv.approval
              WHEN 'awaiting' THEN 'Awaiting approval'
              ELSE 'Not invoiced'
            END
            ELSE NULL
          END,
          '—'
        )
        ELSE latest.invoice_number
      END AS invoice_number,
      latest.created_at,
      coalesce(
        latest.txn_type,
        CASE latest.status
          WHEN 'Sold' THEN 'Sale'
          WHEN 'POC' THEN 'POC Out'
          WHEN 'Rented' THEN 'Rentals'
          WHEN 'Disposed' THEN 'Dispose'
          ELSE NULL
        END
      ) AS movement,
      coalesce(left(latest.txn_date, 10), left(latest.poc_out_date, 10), left(latest.date_added, 10)) AS date_out,
      coalesce(
        nullif(btrim(concat_ws(' - ', nullif(btrim(client.name), ''), nullif(btrim(client.company), ''))), ''),
        nullif(btrim(latest.assigned_to), ''),
        nullif(btrim(latest.client), ''),
        nullif(btrim(latest.txn_client), ''),
        '—'
      ) AS client_display
    FROM latest
    LEFT JOIN public.clients AS client ON client.id = latest.client_id
    LEFT JOIN public.batch_invoices AS inv
      ON inv.batch_id = coalesce(nullif(btrim(latest.batch_id), ''), latest.txn_id)
  ),
  scoped AS (
    SELECT shaped.*
    FROM shaped
    CROSS JOIN params
    WHERE (params.from_day IS NULL OR shaped.date_out >= params.from_day)
      AND (params.to_day IS NULL OR shaped.date_out <= params.to_day)
      AND (
        params.needle IS NULL
        OR strpos(lower(shaped.serial_number), params.needle) > 0
        OR strpos(lower(shaped.product_name), params.needle) > 0
        OR strpos(lower(shaped.client_display), params.needle) > 0
        OR strpos(lower(coalesce(shaped.invoice_number, '')), params.needle) > 0
        OR strpos(lower(coalesce(shaped.movement, '')), params.needle) > 0
      )
  ),
  filtered AS (
    SELECT scoped.*
    FROM scoped
    CROSS JOIN params
    WHERE params.movement IS NULL OR scoped.movement = params.movement
  ),
  page AS (
    SELECT *
    FROM filtered
    ORDER BY date_out DESC NULLS LAST, created_at DESC NULLS LAST, id ASC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 24), 0), 100)
    OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*)::int FROM filtered),
    'counts', COALESCE(
      (SELECT jsonb_object_agg(coalesce(movement, ''), n) FROM (
        SELECT movement, count(*)::int AS n FROM scoped GROUP BY movement
      ) AS counted),
      '{}'::jsonb
    ),
    'rows', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', page.id,
            'serialNumber', page.serial_number,
            'productName', page.product_name,
            'movement', page.movement,
            'clientDisplay', page.client_display,
            'invoiceNumber', page.invoice_number,
            'dateOut', page.date_out,
            'recordedAt', page.created_at
          )
          ORDER BY page.date_out DESC NULLS LAST, page.created_at DESC NULLS LAST, page.id ASC
        )
        FROM page
      ),
      '[]'::jsonb
    )
  );
$$;

COMMIT;
