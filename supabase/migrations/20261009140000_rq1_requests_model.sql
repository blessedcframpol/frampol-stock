-- =============================================================================
-- RQ1: stock requests v2 (review states, request-held invoice, issue_units,
-- request-linked transactions). No BEGIN/COMMIT: rehearse/apply wraps its own txn.
-- =============================================================================
--
-- INVOICE SOURCE OF TRUTH
--   * stock_requests holds the canonical invoice for a request:
--       invoice_status ('invoiced' | 'pending' | 'not_invoiced'), invoice_number,
--       not_invoiced_reason, not_invoiced_kind ('internal' | 'complimentary'),
--       invoice_approval ('awaiting' | 'approved' | NULL), entered_by/at, approved_by/at.
--     RPCs take the INV1 choice vocabulary: 'number' -> invoiced, 'pending', 'not_invoiced'.
--   * issue_units writes ONE apply_stock_movement batch. Each Sale/Rentals transaction carries
--     the request invoice in metadata (invoice_choice / invoice_reason / not_invoiced_kind), so
--     stamp_batch_invoice creates the batch_invoices row in the same state. issue_units then
--     calls sync_request_batch_invoices so entered_by and approval mirror the request too.
--   * set_request_invoice and approve_not_invoiced update the request AND every batch_invoices
--     row whose batch has active_transactions with that request_id, in the same transaction
--     (sync_request_batch_invoices, with batch_invoice_events history and the legacy
--     transactions.invoice_number copy kept in step).
--   * INV1 set_batch_invoice / approve_batch_invoice / reject_batch_invoice keep working for
--     batches that are not linked to a request. They refuse request-linked batches so the
--     request stays the only writer for those batches.
--   * batch_invoices.not_invoiced_kind is new. stamp_batch_invoice and set_batch_invoice now
--     require a kind for 00000. Older not_invoiced rows keep kind NULL.
--
-- ISSUED COUNT
--   Not stored anywhere. Issued = count(active_transactions WHERE request_line_id = line.id),
--   so reversing an issue batch puts the units back as outstanding.
--
-- REVIEWER NOTES / ASSUMPTIONS
--   * The migration stops if any stock_requests row is not 'cancelled' (the brief says there are
--     3 cancelled rows) or if any inventory item is still reserved.
--   * "Today" for return_date is the org business date (app_settings.timezone, default
--     Africa/Harare), not the server's UTC CURRENT_DATE.
--   * Atlas task link is required on submit/resubmit. Only historical cancelled rows may lack it.
--   * Invoice choice is required on every request type, POC Out included (as briefed).
--   * Rentals lines must be Starlink (matches validateMovementForItem in movement-utils).
--   * submit_request roles: admin, sales, technicians (same as the retired INSERT policy).
--   * reject_request and close_outstanding are admin only.
--   * Direct client UPDATEs on stock_requests may only change notes / quotation_url (guard
--     trigger). Everything else goes through the RPCs. No direct INSERT/DELETE.
--   * apply_stock_movement refuses request_id / request_line_id unless issue_units set them.
--   * complete_inspection is replaced only to stop reading the dropped
--     inventory_items.reserved_for_request_line_id column.
--   * App code that selects reserved_for_request_line_id or the dropped stock_requests columns
--     (status, invoice_document_url, invoiced_at, invoiced_by, serviced_at) must ship with this.
-- =============================================================================


-- =============================================================================
-- 0. Preconditions
-- =============================================================================
DO $$
DECLARE
  v_counts jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM public.stock_requests WHERE status IS DISTINCT FROM 'cancelled') THEN
    SELECT jsonb_object_agg(coalesce(status, 'null'), n) INTO v_counts
    FROM (SELECT status, count(*) AS n FROM public.stock_requests GROUP BY status) AS grouped;
    RAISE EXCEPTION 'RQ1: expected only cancelled stock requests before migrating. Found %', v_counts;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.inventory_items WHERE reserved_for_request_line_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'RQ1: inventory items are still reserved for request lines. Release them first';
  END IF;
END;
$$;


-- =============================================================================
-- 1. Retire the draft/in_progress/serviced/invoiced lifecycle
-- =============================================================================
DROP TRIGGER IF EXISTS stock_requests_guard_status ON public.stock_requests;
DROP FUNCTION IF EXISTS public.tr_stock_requests_guard_status_transition();

DROP TRIGGER IF EXISTS stock_requests_log_status_change ON public.stock_requests;
DROP FUNCTION IF EXISTS public.tr_stock_requests_log_status_change();

DROP TRIGGER IF EXISTS stock_requests_log_created ON public.stock_requests;
DROP FUNCTION IF EXISTS public.tr_stock_requests_log_created();

DROP FUNCTION IF EXISTS public.assign_serial_to_request_line(uuid, text);
DROP FUNCTION IF EXISTS public.release_serial_from_request_line(text);
DROP FUNCTION IF EXISTS public.create_request_serviced_notification(uuid);

CREATE OR REPLACE FUNCTION public.tr_stock_requests_updated_at_and_side_effects()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.tr_stock_requests_updated_at_and_side_effects() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tr_stock_requests_updated_at_and_side_effects() FROM anon, authenticated;

-- Every policy on the two tables is dropped (some reference stock_requests.status).
DO $$
DECLARE
  v_policy record;
BEGIN
  FOR v_policy IN
    SELECT policyname, tablename
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('stock_requests', 'stock_request_lines')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_policy.policyname, v_policy.tablename);
  END LOOP;
END;
$$;


-- =============================================================================
-- 2. stock_requests columns
-- =============================================================================
ALTER TABLE public.stock_requests
  DROP COLUMN IF EXISTS invoice_number,
  DROP COLUMN IF EXISTS invoice_document_url,
  DROP COLUMN IF EXISTS invoiced_at,
  DROP COLUMN IF EXISTS invoiced_by,
  DROP COLUMN IF EXISTS serviced_at;

ALTER TABLE public.stock_requests
  ADD COLUMN review_state text,
  ADD COLUMN type text,
  ADD COLUMN return_date date,
  ADD COLUMN atlas_task_url text,
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN invoice_status text,
  ADD COLUMN invoice_number text,
  ADD COLUMN not_invoiced_reason text,
  ADD COLUMN not_invoiced_kind text,
  ADD COLUMN invoice_approval text,
  ADD COLUMN invoice_entered_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN invoice_entered_at timestamptz,
  ADD COLUMN invoice_approved_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN invoice_approved_at timestamptz,
  ADD COLUMN reject_reason_code text,
  ADD COLUMN reject_note text,
  ADD COLUMN rejected_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN rejected_at timestamptz,
  ADD COLUMN closed_reason text,
  ADD COLUMN closed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN closed_at timestamptz,
  ADD COLUMN cancel_reason text,
  ADD COLUMN cancelled_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN cancelled_at timestamptz;

UPDATE public.stock_requests
SET
  review_state = 'cancelled',
  type = 'Sale',
  invoice_status = 'pending',
  submitted_at = created_at,
  cancelled_at = updated_at
WHERE status = 'cancelled';

ALTER TABLE public.stock_requests DROP COLUMN status;

ALTER TABLE public.stock_requests
  ALTER COLUMN review_state SET NOT NULL,
  ALTER COLUMN review_state SET DEFAULT 'submitted',
  ALTER COLUMN type SET NOT NULL,
  ALTER COLUMN invoice_status SET NOT NULL,
  ALTER COLUMN submitted_at SET NOT NULL,
  ALTER COLUMN submitted_at SET DEFAULT now();

ALTER TABLE public.stock_requests
  ADD CONSTRAINT stock_requests_review_state_chk CHECK (
    review_state IN ('submitted', 'awaiting_approval', 'rejected', 'cancelled', 'closed')
  ),
  ADD CONSTRAINT stock_requests_type_chk CHECK (type IN ('Sale', 'POC Out', 'Rentals')),
  ADD CONSTRAINT stock_requests_return_date_chk CHECK (
    (type = 'Sale' AND return_date IS NULL)
    OR (type IN ('POC Out', 'Rentals') AND return_date IS NOT NULL)
  ),
  ADD CONSTRAINT stock_requests_atlas_task_url_chk CHECK (
    (atlas_task_url IS NULL AND review_state = 'cancelled')
    OR atlas_task_url ~ '^https://ai\.frampolafrica\.com:10801/projects/[0-9a-f-]{36}\?task=[0-9a-f-]{36}$'
  ),
  ADD CONSTRAINT stock_requests_invoice_status_chk CHECK (
    invoice_status IN ('invoiced', 'pending', 'not_invoiced')
  ),
  ADD CONSTRAINT stock_requests_invoice_number_chk CHECK (
    (invoice_status = 'invoiced' AND invoice_number IS NOT NULL
      AND public.real_invoice_number_problem(invoice_number) IS NULL)
    OR (invoice_status <> 'invoiced' AND invoice_number IS NULL)
  ),
  ADD CONSTRAINT stock_requests_not_invoiced_reason_chk CHECK (
    (invoice_status = 'not_invoiced' AND char_length(btrim(coalesce(not_invoiced_reason, ''))) >= 15)
    OR (invoice_status <> 'not_invoiced' AND not_invoiced_reason IS NULL)
  ),
  ADD CONSTRAINT stock_requests_not_invoiced_kind_chk CHECK (
    (invoice_status = 'not_invoiced' AND not_invoiced_kind IN ('internal', 'complimentary'))
    OR (invoice_status <> 'not_invoiced' AND not_invoiced_kind IS NULL)
  ),
  ADD CONSTRAINT stock_requests_invoice_approval_chk CHECK (
    (invoice_status = 'not_invoiced' AND invoice_approval IN ('awaiting', 'approved'))
    OR (invoice_status <> 'not_invoiced' AND invoice_approval IS NULL)
  ),
  ADD CONSTRAINT stock_requests_awaiting_approval_chk CHECK (
    review_state <> 'awaiting_approval'
    OR (invoice_status = 'not_invoiced' AND invoice_approval = 'awaiting')
  ),
  ADD CONSTRAINT stock_requests_reject_code_chk CHECK (
    reject_reason_code IS NULL
    OR reject_reason_code IN ('insufficient_customer_info', 'no_atlas_task', 'no_invoice', 'other')
  ),
  ADD CONSTRAINT stock_requests_rejected_has_code_chk CHECK (
    (review_state = 'rejected') = (reject_reason_code IS NOT NULL)
  ),
  ADD CONSTRAINT stock_requests_reject_note_chk CHECK (
    reject_reason_code IS DISTINCT FROM 'other'
    OR char_length(btrim(coalesce(reject_note, ''))) > 0
  ),
  ADD CONSTRAINT stock_requests_closed_reason_chk CHECK (
    review_state <> 'closed' OR char_length(btrim(coalesce(closed_reason, ''))) > 0
  );

CREATE INDEX IF NOT EXISTS idx_stock_requests_review_state ON public.stock_requests (review_state);
CREATE INDEX IF NOT EXISTS idx_stock_requests_type ON public.stock_requests (type);

COMMENT ON TABLE public.stock_requests IS
  'Stock request. Holds the canonical invoice for every batch issued against it. '
  'Display status comes from request_display_status(); issued counts come from active_transactions.';
COMMENT ON COLUMN public.stock_requests.review_state IS
  'submitted | awaiting_approval (00000 waiting for an admin) | rejected | cancelled | closed (outstanding units closed).';
COMMENT ON COLUMN public.stock_requests.type IS 'Sale | POC Out | Rentals. Same name as the transaction type it issues.';
COMMENT ON COLUMN public.stock_requests.return_date IS
  'Required for POC Out and Rentals, after the business date at submit. Null for Sale.';
COMMENT ON COLUMN public.stock_requests.atlas_task_url IS
  'Atlas task link (https://ai.frampolafrica.com:10801/projects/<uuid>?task=<uuid>). Required; null only on historical cancelled rows.';
COMMENT ON COLUMN public.stock_requests.invoice_status IS
  'Canonical invoice for the request. Mirrored onto batch_invoices for every issued Sale/Rentals batch.';
COMMENT ON COLUMN public.stock_requests.not_invoiced_kind IS 'internal | complimentary when invoice_status is not_invoiced.';


-- =============================================================================
-- 3. inventory_items / transactions
-- =============================================================================
ALTER TABLE public.inventory_items DROP COLUMN IF EXISTS reserved_for_request_line_id;

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS request_id uuid REFERENCES public.stock_requests (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS request_line_id uuid REFERENCES public.stock_request_lines (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_request_id
  ON public.transactions (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_request_line_id
  ON public.transactions (request_line_id) WHERE request_line_id IS NOT NULL;

COMMENT ON COLUMN public.transactions.request_id IS 'Stock request this row was issued for (issue_units only).';
COMMENT ON COLUMN public.transactions.request_line_id IS
  'Request line this unit was issued against. Issued count = active rows with this line id.';

-- transactions.* in the view was expanded when it was created; re-expand to pick up the new columns.
CREATE OR REPLACE VIEW public.active_transactions
WITH (security_invoker = true) AS
SELECT transactions.*
FROM public.transactions AS transactions
WHERE transactions.type IS DISTINCT FROM 'Reversal'
  AND NOT public.batch_is_currently_reversed(transactions.batch_id);


-- =============================================================================
-- 4. product_lines.requires_cloud_key
-- =============================================================================
ALTER TABLE public.product_lines
  ADD COLUMN IF NOT EXISTS requires_cloud_key boolean NOT NULL DEFAULT false;

UPDATE public.product_lines
SET requires_cloud_key = (
  btrim(coalesce(vendor, '')) ILIKE 'fortinet'
  AND coalesce(product_name, '') NOT ILIKE '%fortiap%'
);

COMMENT ON COLUMN public.product_lines.requires_cloud_key IS
  'When true, issue_units needs a cloud key for a unit that has none. Seeded true for Fortinet except FortiAP.';


-- =============================================================================
-- 5. batch_invoices: not_invoiced_kind, stamp, INV1 functions, list view
-- =============================================================================
ALTER TABLE public.batch_invoices
  ADD COLUMN IF NOT EXISTS not_invoiced_kind text;

ALTER TABLE public.batch_invoices
  DROP CONSTRAINT IF EXISTS batch_invoices_kind_chk;
ALTER TABLE public.batch_invoices
  ADD CONSTRAINT batch_invoices_kind_chk CHECK (
    not_invoiced_kind IS NULL
    OR (status = 'not_invoiced' AND not_invoiced_kind IN ('internal', 'complimentary'))
  );

COMMENT ON COLUMN public.batch_invoices.not_invoiced_kind IS
  'internal | complimentary for 00000. Required on new 00000 entries; older rows may be null.';

CREATE OR REPLACE FUNCTION public.batch_request_id(p_batch_id text)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT t.request_id
  FROM public.transactions AS t
  WHERE t.request_id IS NOT NULL
    AND coalesce(nullif(btrim(t.batch_id), ''), t.id) = p_batch_id
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.batch_request_id(text) IS
  'Stock request that issued this batch, or null. Request-linked batch invoices are changed on the request.';

REVOKE ALL ON FUNCTION public.batch_request_id(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.batch_request_id(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.stamp_batch_invoice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_choice text;
  v_reason text;
  v_kind text;
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
  v_kind := nullif(btrim(coalesce(NEW.metadata->>'not_invoiced_kind', '')), '');
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
    v_kind := NULL;
  ELSIF v_choice = 'pending' THEN
    IF v_number <> '' THEN
      RAISE EXCEPTION 'Invoice pending does not take a number';
    END IF;
    NEW.invoice_number := NULL;
    v_kind := NULL;
  ELSIF v_choice = 'not_invoiced' THEN
    IF char_length(v_reason) < 15 THEN
      RAISE EXCEPTION '00000 needs a reason of at least 15 characters';
    END IF;
    -- Request submit requires an explicit kind. Movement/bulk paths may omit it;
    -- default complimentary so INV1 stamps and history keep working.
    IF v_kind IS NULL THEN
      v_kind := 'complimentary';
    ELSIF v_kind NOT IN ('internal', 'complimentary') THEN
      RAISE EXCEPTION '00000 needs a kind: internal or complimentary';
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
      OR v_existing.not_invoiced_kind IS DISTINCT FROM v_kind
    ) THEN
      RAISE EXCEPTION 'This batch already has a different invoice';
    END IF;
    RETURN NEW;
  END IF;

  INSERT INTO public.batch_invoices (
    batch_id, status, invoice_number, not_invoiced_reason, not_invoiced_kind,
    entered_by, entered_at, approval, legacy
  ) VALUES (
    v_batch,
    CASE v_choice WHEN 'number' THEN 'invoiced' WHEN 'pending' THEN 'pending' ELSE 'not_invoiced' END,
    CASE WHEN v_choice = 'number' THEN v_number ELSE NULL END,
    CASE WHEN v_choice = 'not_invoiced' THEN v_reason ELSE NULL END,
    CASE WHEN v_choice = 'not_invoiced' THEN v_kind ELSE NULL END,
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

REVOKE ALL ON FUNCTION public.stamp_batch_invoice() FROM PUBLIC, anon;

DROP FUNCTION IF EXISTS public.set_batch_invoice(text, text, text, text);

CREATE FUNCTION public.set_batch_invoice(
  p_batch_id text,
  p_choice text,
  p_invoice_number text,
  p_reason text,
  p_kind text DEFAULT NULL
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
  v_kind text := nullif(btrim(coalesce(p_kind, '')), '');
  v_problem text;
  v_status text;
  v_approval text;
  v_stored_number text;
  v_stored_reason text;
  v_stored_kind text;
BEGIN
  IF public.get_my_role() IS DISTINCT FROM 'admin' AND public.get_my_role() IS DISTINCT FROM 'accounts' THEN
    RAISE EXCEPTION 'Only admin or accounts can change an invoice';
  END IF;
  IF v_choice NOT IN ('number', 'pending', 'not_invoiced') THEN
    RAISE EXCEPTION 'Invoice choice must be a number, Invoice pending, or 00000 — not invoiced';
  END IF;
  IF public.batch_request_id(p_batch_id) IS NOT NULL THEN
    RAISE EXCEPTION 'This batch was issued from a stock request. Change the invoice on the request';
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
    v_stored_kind := NULL;
  ELSIF v_choice = 'pending' THEN
    IF v_row.status IS DISTINCT FROM 'legacy_unreviewed' THEN
      RAISE EXCEPTION 'Only an unreviewed 00000 can be marked pending';
    END IF;
    v_status := 'pending';
    v_approval := NULL;
    v_stored_number := NULL;
    v_stored_reason := NULL;
    v_stored_kind := NULL;
  ELSE
    IF v_row.status NOT IN ('pending', 'legacy_unreviewed') THEN
      RAISE EXCEPTION 'Only a pending or unreviewed invoice can be marked not invoiced';
    END IF;
    IF char_length(v_reason) < 15 THEN
      RAISE EXCEPTION '00000 needs a reason of at least 15 characters';
    END IF;
    IF v_kind IS NULL THEN
      v_kind := 'complimentary';
    ELSIF v_kind NOT IN ('internal', 'complimentary') THEN
      RAISE EXCEPTION '00000 needs a kind: internal or complimentary';
    END IF;
    v_status := 'not_invoiced';
    v_approval := 'awaiting';
    v_stored_number := NULL;
    v_stored_reason := v_reason;
    v_stored_kind := v_kind;
  END IF;

  PERFORM public.write_batch_invoice_event(p_batch_id, v_row, v_status, v_stored_number, v_approval, v_reason);

  UPDATE public.batch_invoices
  SET
    status = v_status,
    invoice_number = v_stored_number,
    not_invoiced_reason = v_stored_reason,
    not_invoiced_kind = v_stored_kind,
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
  IF public.batch_request_id(p_batch_id) IS NOT NULL THEN
    RAISE EXCEPTION 'This batch was issued from a stock request. Approve the 00000 on the request';
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
  IF public.batch_request_id(p_batch_id) IS NOT NULL THEN
    RAISE EXCEPTION 'This batch was issued from a stock request. Change the invoice on the request';
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
    not_invoiced_kind = NULL,
    invoice_number = NULL,
    approved_by = NULL,
    approved_at = NULL,
    rejection_reason = v_reason
  WHERE batch_id = p_batch_id;

  PERFORM public.sync_legacy_invoice(p_batch_id, 'pending', NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.set_batch_invoice(text, text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.approve_batch_invoice(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reject_batch_invoice(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_batch_invoice(text, text, text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.approve_batch_invoice(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reject_batch_invoice(text, text) TO authenticated, service_role;

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
  END AS days_waiting,
  bi.not_invoiced_kind,
  lines.request_id
FROM public.batch_invoices AS bi
JOIN LATERAL (
  SELECT
    (array_agg(t.type ORDER BY t.date DESC, t.id DESC))[1] AS movement_type,
    (array_agg(nullif(btrim(t.client), '') ORDER BY t.date DESC, t.id DESC))[1] AS client_name,
    count(*)::int AS quantity,
    string_agg(t.serial_number, ', ' ORDER BY t.serial_number) AS serials,
    string_agg(DISTINCT t.item_name, ', ' ORDER BY t.item_name) AS product_name,
    max(left(t.date, 10)) AS sale_date,
    (array_agg(t.request_id) FILTER (WHERE t.request_id IS NOT NULL))[1] AS request_id
  FROM public.active_transactions AS t
  WHERE coalesce(nullif(btrim(t.batch_id), ''), t.id) = bi.batch_id
    AND t.type IN ('Sale', 'Rentals')
) AS lines ON lines.quantity > 0;

COMMENT ON VIEW public.batch_invoice_list IS
  'Invoice batches that still have an active Sale or Rentals row. request_id is set when a stock request issued the batch.';


-- =============================================================================
-- 6. apply_stock_movement (request_id / request_line_id; no reserved_for_request_line_id)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.apply_stock_movement(p_inventory_upserts jsonb, p_inventory_inserts jsonb, p_transactions jsonb, p_outbound_batch jsonb DEFAULT NULL::jsonb, p_kit_inspection jsonb DEFAULT NULL::jsonb, p_remediation_patch jsonb DEFAULT NULL::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_type text;
  v_type_count integer;
  rec record;
  v_item_id text;
  v_status text;
  v_location text;
  v_client text;
  v_assigned text;
  v_poc text;
  v_return text;
  v_pool text;
  v_written text;
  v_expected text;
  v_exists boolean;
  v_inserted integer;
  v_insert_count integer;
BEGIN

  PERFORM public.validate_apply_stock_movement_payload(
    p_inventory_upserts,
    p_inventory_inserts,
    p_transactions
  );
  IF p_transactions IS NOT NULL
     AND jsonb_typeof(p_transactions) = 'array'
     AND jsonb_array_length(p_transactions) > 0 THEN
    IF EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_transactions) AS t(date text)
      WHERE CASE
        WHEN t.date ~ '^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$'
          THEN substring(t.date FROM 1 FOR 4)::int NOT BETWEEN 2020 AND 2100
        ELSE true
      END
    ) THEN
      RAISE EXCEPTION 'Transaction date must be a business-date midnight (YYYY-MM-DDT00:00:00.000Z) between 2020 and 2100'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT count(DISTINCT t.type)::integer
    INTO v_type_count
    FROM jsonb_to_recordset(p_transactions) AS t(type text);

    IF v_type_count > 1 THEN
      RAISE EXCEPTION 'A stock movement has one type'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT t.type
    INTO v_type
    FROM jsonb_to_recordset(p_transactions) AS t(type text)
    LIMIT 1;

    IF v_type = 'POC Return' AND EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_transactions) AS t(return_pool text)
      WHERE t.return_pool IS NULL OR t.return_pool NOT IN ('sale', 'demo')
    ) THEN
      RAISE EXCEPTION 'POC Return must choose Back in sellable stock or Demo unit, not for sale'
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_type IN ('Decommissioned', 'Rental Return') AND EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_transactions) AS t(metadata jsonb)
      WHERE COALESCE(t.metadata->>'reason_category', '') NOT IN ('Client cancelled', 'Service termination')
         OR btrim(COALESCE(t.metadata->>'reason_text', '')) = ''
    ) THEN
      RAISE EXCEPTION 'Decommissioned and Rental Return need a reason category and a typed reason'
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_type = 'Decommissioned' AND EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_transactions) AS t(serial_number text, client_id text)
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.inventory_items AS item
        WHERE item.serial_number = t.serial_number
          AND item.deleted_at IS NULL
      )
      AND (
        NULLIF(btrim(COALESCE(t.client_id, '')), '') IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM public.clients AS client
          WHERE client.id = NULLIF(btrim(COALESCE(t.client_id, '')), '')
        )
      )
    ) THEN
      RAISE EXCEPTION 'An unknown serial needs a client'
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_type IN ('Inspection Pass', 'Inspection Fail')
       AND COALESCE(current_setting('app.inspection_case', true), '') = '' THEN
      RAISE EXCEPTION 'Record the inspection on the open case'
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_type = 'Dispose'
       AND COALESCE(current_setting('app.inspection_case', true), '') = ''
       AND EXISTS (
         SELECT 1
         FROM jsonb_to_recordset(p_transactions) AS t(serial_number text)
         JOIN public.inventory_items AS item
           ON item.serial_number = t.serial_number
          AND item.deleted_at IS NULL
         JOIN public.kit_cases AS kc
           ON kc.inventory_item_id = item.id
          AND kc.case_type = 'decommission'
          AND kc.stage = 'open'
       ) THEN
      RAISE EXCEPTION 'Dispose this kit from its inspection case'
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_type = 'Inspection Pass' AND EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_transactions) AS t(inspection_pool text)
      WHERE t.inspection_pool IS NOT NULL
        AND t.inspection_pool NOT IN ('sale', 'rental')
    ) THEN
      RAISE EXCEPTION 'Inspection Pass group must be sale or rental'
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_type = 'Inspection Pass' AND EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_transactions) AS t(serial_number text, inspection_pool text)
      WHERE t.inspection_pool = 'rental'
        AND NOT EXISTS (
          SELECT 1
          FROM public.inventory_items AS item
          JOIN public.product_lines AS line ON line.id = item.product_id
          WHERE item.serial_number = t.serial_number
            AND item.deleted_at IS NULL
            AND line.vendor = 'Starlink'
        )
    ) THEN
      RAISE EXCEPTION 'Rent out is only for Starlink kits'
        USING ERRCODE = 'check_violation';
    END IF;

    -- Request links are written only by issue_units, which sets app.request_issue for this txn.
    IF EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_transactions) AS t(request_id uuid, request_line_id uuid)
      WHERE t.request_id IS NOT NULL OR t.request_line_id IS NOT NULL
    ) AND EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_transactions) AS t(request_id uuid, request_line_id uuid)
      WHERE t.request_id IS NULL
         OR t.request_line_id IS NULL
         OR t.request_id::text IS DISTINCT FROM NULLIF(current_setting('app.request_issue', true), '')
         OR NOT EXISTS (
           SELECT 1
           FROM public.stock_request_lines AS line
           WHERE line.id = t.request_line_id
             AND line.request_id = t.request_id
         )
    ) THEN
      RAISE EXCEPTION 'Request units are issued from the request'
        USING ERRCODE = 'check_violation';
    END IF;

    PERFORM set_config('app.movement_type', v_type, true);

    CREATE TEMP TABLE _movement_prev (
      serial text PRIMARY KEY,
      previous_status text,
      previous_location text,
      previous_client text,
      previous_assigned_to text,
      previous_poc_out_date text,
      previous_return_date text,
      previous_stock_pool text,
      is_create boolean NOT NULL
    ) ON COMMIT DROP;

    FOR rec IN
      SELECT t.type, t.serial_number
      FROM jsonb_to_recordset(p_transactions) AS t(type text, serial_number text)
    LOOP
      v_item_id := NULL;
      v_status := NULL;
      v_pool := NULL;
      SELECT item.id, item.status, item.location, item.client, item.assigned_to,
             item.poc_out_date, item.return_date, item.stock_pool
      INTO v_item_id, v_status, v_location, v_client, v_assigned, v_poc, v_return, v_pool
      FROM public.inventory_items AS item
      WHERE item.serial_number = rec.serial_number
        AND item.deleted_at IS NULL
      ORDER BY item.id
      LIMIT 1
      FOR UPDATE;

      v_exists := FOUND;

      IF NOT v_exists THEN
        IF rec.type IS DISTINCT FROM 'Inbound' AND rec.type IS DISTINCT FROM 'Decommissioned' THEN
          RAISE EXCEPTION 'Invalid movement: % requires an existing item (%)', rec.type, rec.serial_number
            USING ERRCODE = 'check_violation';
        END IF;
        INSERT INTO _movement_prev (
          serial, previous_status, previous_location, previous_client, previous_assigned_to,
          previous_poc_out_date, previous_return_date, previous_stock_pool, is_create
        )
        VALUES (rec.serial_number, NULL, NULL, NULL, NULL, NULL, NULL, NULL, true)
        ON CONFLICT (serial) DO NOTHING;
      ELSE
        IF rec.type = 'Sale' AND v_status = 'In Stock' AND v_pool IS DISTINCT FROM 'sale' THEN
          RAISE EXCEPTION 'Sale requires a sellable kit. Move % from % to sale first', rec.serial_number, v_pool
            USING ERRCODE = 'check_violation';
        END IF;
        IF rec.type = 'Rentals' AND v_pool NOT IN ('sale', 'rental') THEN
          RAISE EXCEPTION 'Rentals is not allowed from the % group (%)', v_pool, rec.serial_number
            USING ERRCODE = 'check_violation';
        END IF;
        IF rec.type = 'POC Out' AND v_pool NOT IN ('sale', 'demo') THEN
          RAISE EXCEPTION 'POC Out is not allowed from the % group (%)', v_pool, rec.serial_number
            USING ERRCODE = 'check_violation';
        END IF;
        v_expected := public.movement_result_status(v_status, rec.type);
        SELECT u.status
        INTO v_written
        FROM jsonb_to_recordset(COALESCE(p_inventory_upserts, '[]'::jsonb)) AS u(id text, serial_number text, status text)
        WHERE u.id = v_item_id OR u.serial_number = rec.serial_number
        LIMIT 1;

        IF v_written IS NULL THEN
          RAISE EXCEPTION 'Movement % is missing the inventory update for %', rec.type, rec.serial_number
            USING ERRCODE = 'check_violation';
        END IF;
        IF v_written IS DISTINCT FROM v_expected THEN
          RAISE EXCEPTION 'Invalid movement: % from % cannot set %', rec.type, v_status, v_written
            USING ERRCODE = 'check_violation';
        END IF;
        INSERT INTO _movement_prev (
          serial, previous_status, previous_location, previous_client, previous_assigned_to,
          previous_poc_out_date, previous_return_date, previous_stock_pool, is_create
        )
        VALUES (rec.serial_number, v_status, v_location, v_client, v_assigned, v_poc, v_return, v_pool, false)
        ON CONFLICT (serial) DO NOTHING;
      END IF;
    END LOOP;
  END IF;

  IF p_inventory_inserts IS NOT NULL
     AND jsonb_typeof(p_inventory_inserts) = 'array'
     AND jsonb_array_length(p_inventory_inserts) > 0 THEN
    IF v_type IS DISTINCT FROM 'Inbound' AND v_type IS DISTINCT FROM 'Decommissioned' THEN
      RAISE EXCEPTION 'New inventory rows are only created by Inbound or Decommissioned'
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_type = 'Inbound' AND EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_inventory_inserts) AS i(status text)
      WHERE i.status IS DISTINCT FROM 'In Stock'
    ) THEN
      RAISE EXCEPTION 'Inbound creates In Stock rows'
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_type = 'Decommissioned' AND EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_inventory_inserts) AS i(status text, poc_out_date text, return_date text)
      WHERE i.status IS DISTINCT FROM 'Pending Inspection'
         OR NULLIF(btrim(COALESCE(i.poc_out_date, '')), '') IS NOT NULL
         OR NULLIF(btrim(COALESCE(i.return_date, '')), '') IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'An unknown serial is Pending Inspection and records the return date only'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF p_outbound_batch IS NOT NULL AND jsonb_typeof(p_outbound_batch) = 'object' THEN
    INSERT INTO public.outbound_batches (
      id, type, client, client_id, start_date, end_date, status, invoice_number, created_at
    )
    SELECT
      b.id, b.type, b.client, b.client_id, b.start_date, b.end_date, b.status, b.invoice_number, b.created_at
    FROM jsonb_to_record(p_outbound_batch) AS b(
      id text, type text, client text, client_id text, start_date text, end_date text,
      status text, invoice_number text, created_at text
    );
  END IF;

  IF p_inventory_upserts IS NOT NULL
     AND jsonb_typeof(p_inventory_upserts) = 'array'
     AND jsonb_array_length(p_inventory_upserts) > 0 THEN
    INSERT INTO public.inventory_items (
      id, product_id, serial_number, status, date_added, location, client, notes, assigned_to,
      purchase_date, warranty_end_date, poc_out_date, return_date, assignment_history,
      cloud_key, deleted_at
    )
    SELECT
      i.id, i.product_id, i.serial_number, i.status, i.date_added, i.location, i.client, i.notes, i.assigned_to,
      i.purchase_date, i.warranty_end_date, i.poc_out_date, i.return_date, i.assignment_history,
      i.cloud_key, i.deleted_at
    FROM jsonb_to_recordset(p_inventory_upserts) AS i(
      id text, product_id text, serial_number text, status text, date_added text, location text,
      client text, notes text, assigned_to text, purchase_date text, warranty_end_date text,
      poc_out_date text, return_date text, assignment_history jsonb,
      cloud_key text, deleted_at timestamptz
    )
    ON CONFLICT (id) DO UPDATE
    SET
      product_id = EXCLUDED.product_id,
      serial_number = EXCLUDED.serial_number,
      status = EXCLUDED.status,
      date_added = EXCLUDED.date_added,
      location = EXCLUDED.location,
      client = EXCLUDED.client,
      notes = EXCLUDED.notes,
      assigned_to = EXCLUDED.assigned_to,
      purchase_date = EXCLUDED.purchase_date,
      warranty_end_date = EXCLUDED.warranty_end_date,
      poc_out_date = EXCLUDED.poc_out_date,
      return_date = EXCLUDED.return_date,
      assignment_history = EXCLUDED.assignment_history,
      cloud_key = EXCLUDED.cloud_key,
      deleted_at = EXCLUDED.deleted_at;
  END IF;

  IF p_inventory_inserts IS NOT NULL
     AND jsonb_typeof(p_inventory_inserts) = 'array'
     AND jsonb_array_length(p_inventory_inserts) > 0 THEN
    v_insert_count := jsonb_array_length(p_inventory_inserts);
    INSERT INTO public.inventory_items (
      id, product_id, serial_number, status, date_added, location, client, notes, assigned_to,
      purchase_date, warranty_end_date, poc_out_date, return_date, assignment_history,
      cloud_key, deleted_at
    )
    SELECT
      i.id, i.product_id, i.serial_number, i.status, i.date_added, i.location, i.client, i.notes, i.assigned_to,
      i.purchase_date, i.warranty_end_date, i.poc_out_date, i.return_date, i.assignment_history,
      i.cloud_key, i.deleted_at
    FROM jsonb_to_recordset(p_inventory_inserts) AS i(
      id text, product_id text, serial_number text, status text, date_added text, location text,
      client text, notes text, assigned_to text, purchase_date text, warranty_end_date text,
      poc_out_date text, return_date text, assignment_history jsonb,
      cloud_key text, deleted_at timestamptz
    )
    ON CONFLICT (serial_number) WHERE deleted_at IS NULL AND serial_number IS NOT NULL
    DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted IS DISTINCT FROM v_insert_count THEN
      RAISE EXCEPTION 'Inbound insert skipped (% of % rows). The serial is already in stock', v_inserted, v_insert_count
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;

  IF p_transactions IS NOT NULL
     AND jsonb_typeof(p_transactions) = 'array'
     AND jsonb_array_length(p_transactions) > 0 THEN
    IF EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_transactions) AS t(serial_number text)
      WHERE NOT EXISTS (
        SELECT 1 FROM _movement_prev AS prev WHERE prev.serial = t.serial_number
      )
    ) THEN
      RAISE EXCEPTION 'Movement is missing a locked previous status'
        USING ERRCODE = 'check_violation';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_transactions) AS t(serial_number text)
      WHERE NOT EXISTS (
        SELECT 1 FROM public.inventory_items AS item WHERE item.serial_number = t.serial_number
      )
    ) THEN
      RAISE EXCEPTION 'Movement is missing the inventory row it just wrote'
        USING ERRCODE = 'check_violation';
    END IF;

    UPDATE public.inventory_items AS item
    SET stock_pool = CASE v_type
      WHEN 'Rentals' THEN 'rental'
      WHEN 'Rental Return' THEN 'rental'
      WHEN 'POC Return' THEN chosen.return_pool
      WHEN 'Inspection Pass' THEN chosen.inspection_pool
      ELSE item.stock_pool
    END
    FROM jsonb_to_recordset(p_transactions) AS chosen(serial_number text, return_pool text, inspection_pool text)
    WHERE item.serial_number = chosen.serial_number
      AND item.deleted_at IS NULL
      AND (
        v_type IN ('Rentals', 'Rental Return', 'POC Return')
        OR (v_type = 'Inspection Pass' AND chosen.inspection_pool IN ('sale', 'rental'))
      );

    UPDATE public.inventory_items AS item
    SET
      client = prev.previous_client,
      assigned_to = prev.previous_assigned_to
    FROM _movement_prev AS prev
    WHERE item.serial_number = prev.serial
      AND item.deleted_at IS NULL
      AND NOT prev.is_create
      AND v_type IN ('Decommissioned', 'Rental Return');

    INSERT INTO public.transactions (
      id, type, serial_number, item_name, client, date, client_id, invoice_number, notes,
      from_location, to_location, assigned_to, disposal_reason, authorised_by, batch_id,
      delivery_note_url, metadata, created_by, request_id, request_line_id,
      previous_status, previous_status_source,
      previous_location, previous_client, previous_assigned_to, previous_poc_out_date, previous_return_date,
      previous_stock_pool,
      after_status, after_location, after_client, after_assigned_to, after_poc_out_date, after_return_date,
      after_stock_pool
    )
    SELECT
      t.id, t.type, t.serial_number, t.item_name, t.client, t.date, t.client_id, t.invoice_number, t.notes,
      t.from_location, t.to_location, t.assigned_to, t.disposal_reason, t.authorised_by, t.batch_id,
      t.delivery_note_url, t.metadata, t.created_by, t.request_id, t.request_line_id,
      CASE WHEN prev.is_create THEN NULL ELSE prev.previous_status END,
      'recorded',
      CASE WHEN prev.is_create THEN NULL ELSE prev.previous_location END,
      CASE WHEN prev.is_create THEN NULL ELSE prev.previous_client END,
      CASE WHEN prev.is_create THEN NULL ELSE prev.previous_assigned_to END,
      CASE WHEN prev.is_create THEN NULL ELSE prev.previous_poc_out_date END,
      CASE WHEN prev.is_create THEN NULL ELSE prev.previous_return_date END,
      CASE WHEN prev.is_create THEN NULL ELSE prev.previous_stock_pool END,
      after_row.status, after_row.location, after_row.client, after_row.assigned_to,
      after_row.poc_out_date, after_row.return_date, after_row.stock_pool
    FROM jsonb_to_recordset(p_transactions) AS t(
      id text, type text, serial_number text, item_name text, client text, date text, client_id text,
      invoice_number text, notes text, from_location text, to_location text, assigned_to text,
      disposal_reason text, authorised_by text, batch_id text, delivery_note_url text, metadata jsonb,
      created_by uuid, request_id uuid, request_line_id uuid
    )
    JOIN _movement_prev AS prev ON prev.serial = t.serial_number
    JOIN LATERAL (
      SELECT item.status, item.location, item.client, item.assigned_to, item.poc_out_date, item.return_date, item.stock_pool
      FROM public.inventory_items AS item
      WHERE item.serial_number = t.serial_number
      ORDER BY item.deleted_at NULLS FIRST, item.id
      LIMIT 1
    ) AS after_row ON true;

    IF v_type IN ('Decommissioned', 'Rental Return') THEN
      PERFORM public.record_decommission_intake(p_transactions);
    END IF;
  END IF;

  IF p_kit_inspection IS NOT NULL AND jsonb_typeof(p_kit_inspection) = 'object' THEN
    INSERT INTO public.kit_inspections (
      inventory_item_id, serial_number, inspector_name, outcome, condition_notes,
      attachment_urls, transaction_id, created_by
    )
    SELECT
      k.inventory_item_id, k.serial_number, k.inspector_name, k.outcome, k.condition_notes,
      COALESCE(k.attachment_urls, '{}'::text[]), k.transaction_id, k.created_by
    FROM jsonb_to_record(p_kit_inspection) AS k(
      inventory_item_id text, serial_number text, inspector_name text, outcome text,
      condition_notes text, attachment_urls text[], transaction_id text, created_by uuid
    );
  END IF;

  IF p_remediation_patch IS NOT NULL AND jsonb_typeof(p_remediation_patch) = 'object' THEN
    UPDATE public.remediation_cases rc
    SET
      loaner_inventory_item_id = r.loaner_inventory_item_id,
      loaner_serial = r.loaner_serial,
      updated_at = COALESCE(r.updated_at, now())
    FROM jsonb_to_record(p_remediation_patch) AS r(
      id uuid, loaner_inventory_item_id text, loaner_serial text, updated_at timestamptz
    )
    WHERE rc.id = r.id;
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.apply_stock_movement(jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) IS
  'Atomic stock movement. Runs P3.6 payload validation before writing. request_id/request_line_id only via issue_units.';

REVOKE ALL ON FUNCTION public.apply_stock_movement(jsonb, jsonb, jsonb, jsonb, jsonb, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_stock_movement(jsonb, jsonb, jsonb, jsonb, jsonb, jsonb)
  TO authenticated, service_role;

-- complete_inspection read v_item.reserved_for_request_line_id; same body without it.
CREATE OR REPLACE FUNCTION public.complete_inspection(
  p_case_id uuid,
  p_result text,
  p_comments text,
  p_grade text,
  p_outcome text,
  p_location text DEFAULT NULL,
  p_reason_category text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_case public.kit_cases%ROWTYPE;
  v_item public.inventory_items%ROWTYPE;
  v_vendor text;
  v_product text;
  v_status text;
  v_move text;
  v_pool text;
  v_client text;
  v_assigned text;
  v_location text;
  v_poc text;
  v_return text;
  v_txn text;
  v_batch text;
  v_date text;
  v_upserts jsonb;
  v_txns jsonb;
BEGIN
  IF (SELECT public.get_my_role()) IS DISTINCT FROM 'admin' OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'complete_inspection: admin only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_result IS NULL OR p_result NOT IN ('Pass', 'Fail') THEN
    RAISE EXCEPTION 'complete_inspection: result must be Pass or Fail'
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(COALESCE(p_comments, '')) = '' THEN
    RAISE EXCEPTION 'complete_inspection: comments are required'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_grade IS NULL OR p_grade NOT IN ('A', 'B', 'C') THEN
    RAISE EXCEPTION 'complete_inspection: grade must be A, B, or C'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT *
  INTO v_case
  FROM public.kit_cases
  WHERE id = p_case_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'complete_inspection: case not found'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_case.case_type IS DISTINCT FROM 'decommission' OR v_case.stage IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'complete_inspection: the case is not open'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_reason_category IS NOT NULL THEN
    IF p_reason_category NOT IN ('Client cancelled', 'Service termination', 'Not recorded') THEN
      RAISE EXCEPTION 'complete_inspection: reason category is not recognised'
        USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public.kit_cases
    SET reason_category = p_reason_category
    WHERE id = p_case_id;
  END IF;

  SELECT *
  INTO v_item
  FROM public.inventory_items
  WHERE id = v_case.inventory_item_id
    AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND OR v_item.status IS DISTINCT FROM 'Pending Inspection' THEN
    RAISE EXCEPTION 'complete_inspection: the kit is not pending inspection'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT line.vendor, line.product_name
  INTO v_vendor, v_product
  FROM public.product_lines AS line
  WHERE line.id = v_item.product_id;

  IF p_result = 'Fail' AND p_outcome = 'Resell' THEN
    RAISE EXCEPTION 'complete_inspection: Resell is rejected after a Fail'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_result = 'Pass' AND COALESCE(v_vendor, '') = 'Starlink' THEN
    IF p_outcome NOT IN ('Resell', 'Rent out', 'Dispose') THEN
      RAISE EXCEPTION 'complete_inspection: a passed Starlink kit can be Resell, Rent out, or Dispose'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF p_result = 'Pass' THEN
    IF p_outcome = 'Rent out' THEN
      RAISE EXCEPTION 'complete_inspection: Rent out is only for Starlink kits'
        USING ERRCODE = 'check_violation';
    END IF;
    IF p_outcome NOT IN ('Resell', 'Dispose') THEN
      RAISE EXCEPTION 'complete_inspection: a passed kit can be Resell or Dispose'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF p_outcome NOT IN ('Return to vendor', 'Dispose') THEN
      RAISE EXCEPTION 'complete_inspection: a failed kit can be Return to vendor or Dispose'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  v_pool := NULL;
  v_client := v_item.client;
  v_assigned := v_item.assigned_to;
  v_location := v_item.location;
  v_poc := v_item.poc_out_date;
  v_return := v_item.return_date;

  IF p_outcome = 'Resell' THEN
    v_move := 'Inspection Pass';
    v_status := 'In Stock';
    v_pool := 'sale';
    v_client := NULL;
    v_assigned := NULL;
    v_poc := NULL;
    v_return := NULL;
  ELSIF p_outcome = 'Rent out' THEN
    v_move := 'Inspection Pass';
    v_status := 'In Stock';
    v_pool := 'rental';
    v_client := NULL;
    v_assigned := NULL;
    v_poc := NULL;
    v_return := NULL;
  ELSIF p_outcome = 'Dispose' THEN
    v_move := 'Dispose';
    v_status := 'Disposed';
  ELSE
    v_move := 'Inspection Fail';
    v_status := 'RMA Hold';
  END IF;

  IF p_outcome IN ('Resell', 'Rent out') THEN
    IF p_location IS NULL OR p_location NOT IN ('Warehouse A', 'Warehouse B', 'Service Center') THEN
      RAISE EXCEPTION 'complete_inspection: pick a warehouse'
        USING ERRCODE = 'check_violation';
    END IF;
    v_location := p_location;
  END IF;

  v_date := to_char((now() AT TIME ZONE 'Africa/Harare')::date, 'YYYY-MM-DD') || 'T00:00:00.000Z';
  v_txn := 'TXN-INSP-' || ((extract(epoch FROM clock_timestamp()) * 1000)::bigint)::text;
  v_batch := 'BATCH-INSP-' || ((extract(epoch FROM clock_timestamp()) * 1000)::bigint)::text;

  v_upserts := jsonb_build_array(jsonb_build_object(
    'id', v_item.id,
    'product_id', v_item.product_id,
    'serial_number', v_item.serial_number,
    'status', v_status,
    'date_added', v_item.date_added,
    'location', v_location,
    'client', v_client,
    'notes', v_item.notes,
    'assigned_to', v_assigned,
    'purchase_date', v_item.purchase_date,
    'warranty_end_date', v_item.warranty_end_date,
    'poc_out_date', v_poc,
    'return_date', v_return,
    'assignment_history', COALESCE(v_item.assignment_history, '[]'::jsonb),
    'cloud_key', v_item.cloud_key,
    'deleted_at', v_item.deleted_at
  ));

  v_txns := jsonb_build_array(jsonb_build_object(
    'id', v_txn,
    'type', v_move,
    'serial_number', v_item.serial_number,
    'item_name', COALESCE(v_product, v_item.serial_number),
    'client', COALESCE(v_client, v_item.client, 'Internal'),
    'date', v_date,
    'client_id', v_case.client_id,
    'notes', btrim(p_comments),
    'to_location', v_location,
    'batch_id', v_batch,
    'created_by', auth.uid(),
    'inspection_pool', v_pool,
    'metadata', jsonb_build_object(
      'case_id', p_case_id,
      'result', p_result,
      'grade', p_grade,
      'outcome', p_outcome,
      'comments', btrim(p_comments)
    )
  ));

  PERFORM set_config('app.inspection_case', p_case_id::text, true);
  PERFORM public.apply_stock_movement(v_upserts, '[]'::jsonb, v_txns, NULL, NULL, NULL);

  INSERT INTO public.kit_case_events (case_id, event_type, actor, payload)
  VALUES (
    p_case_id,
    'inspection_recorded',
    auth.uid(),
    jsonb_build_object('result', p_result, 'comments', btrim(p_comments), 'grade', p_grade)
  );
  INSERT INTO public.kit_case_events (case_id, event_type, actor, payload)
  VALUES (
    p_case_id,
    'outcome_applied',
    auth.uid(),
    jsonb_build_object(
      'outcome', p_outcome,
      'transaction_id', v_txn,
      'batch_id', v_batch,
      'status', v_status,
      'stock_pool', COALESCE(v_pool, v_item.stock_pool)
    )
  );

  UPDATE public.kit_cases
  SET stage = 'closed', outcome = p_outcome, closed_at = now(), closed_by = auth.uid()
  WHERE id = p_case_id;

  RETURN p_case_id;
END;
$$;

COMMENT ON FUNCTION public.complete_inspection(uuid, text, text, text, text, text, text) IS
  'Admin inspection. Writes the inspection event, the stock movement, and the case closure in one transaction.';

REVOKE ALL ON FUNCTION public.complete_inspection(uuid, text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_inspection(uuid, text, text, text, text, text, text) TO authenticated, service_role;


-- =============================================================================
-- 7. Request helpers
-- =============================================================================
CREATE OR REPLACE FUNCTION public.stock_request_today()
RETURNS date
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT (now() AT TIME ZONE coalesce((SELECT timezone FROM public.app_settings LIMIT 1), 'Africa/Harare'))::date;
$$;

COMMENT ON FUNCTION public.stock_request_today() IS 'Org business date (app_settings.timezone).';

CREATE OR REPLACE FUNCTION public.stock_request_parse_date(p_value text)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_value text := nullif(btrim(coalesce(p_value, '')), '');
BEGIN
  IF v_value IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_value !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'Return date must be a calendar day (YYYY-MM-DD)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_value::date;
EXCEPTION
  WHEN datetime_field_overflow OR invalid_datetime_format THEN
    RAISE EXCEPTION 'Return date must be a calendar day (YYYY-MM-DD)'
      USING ERRCODE = 'check_violation';
END;
$$;

CREATE OR REPLACE FUNCTION public.stock_request_fields_problem(
  p_client_id text,
  p_type text,
  p_return_date date,
  p_atlas_task_url text,
  p_choice text,
  p_invoice_number text,
  p_reason text,
  p_kind text
)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_client text := nullif(btrim(coalesce(p_client_id, '')), '');
  v_atlas text := nullif(btrim(coalesce(p_atlas_task_url, '')), '');
  v_problem text;
BEGIN
  IF v_client IS NULL OR NOT EXISTS (SELECT 1 FROM public.clients WHERE id = v_client) THEN
    RETURN 'Pick a client from the directory';
  END IF;

  IF p_type IS NULL OR p_type NOT IN ('Sale', 'POC Out', 'Rentals') THEN
    RETURN 'Request type must be Sale, POC Out, or Rentals';
  END IF;

  IF p_type IN ('POC Out', 'Rentals') THEN
    IF p_return_date IS NULL THEN
      RETURN p_type || ' needs a return date';
    END IF;
    IF p_return_date <= public.stock_request_today() THEN
      RETURN 'Return date must be after today';
    END IF;
  ELSIF p_return_date IS NOT NULL THEN
    RETURN 'A Sale does not take a return date';
  END IF;

  IF v_atlas IS NULL THEN
    RETURN 'Atlas task link is required';
  END IF;
  IF v_atlas !~ '^https://ai\.frampolafrica\.com:10801/projects/[0-9a-f-]{36}\?task=[0-9a-f-]{36}$' THEN
    RETURN 'Atlas task link must look like https://ai.frampolafrica.com:10801/projects/<id>?task=<id>';
  END IF;

  IF p_choice = 'number' THEN
    v_problem := public.real_invoice_number_problem(p_invoice_number);
    IF v_problem IS NOT NULL THEN
      RETURN v_problem;
    END IF;
  ELSIF p_choice = 'pending' THEN
    IF btrim(coalesce(p_invoice_number, '')) <> '' THEN
      RETURN 'Invoice pending does not take a number';
    END IF;
  ELSIF p_choice = 'not_invoiced' THEN
    IF char_length(btrim(coalesce(p_reason, ''))) < 15 THEN
      RETURN '00000 needs a reason of at least 15 characters';
    END IF;
    IF p_kind IS NULL OR p_kind NOT IN ('internal', 'complimentary') THEN
      RETURN '00000 needs a kind: internal or complimentary';
    END IF;
  ELSE
    RETURN 'Invoice must be a number, Invoice pending, or 00000 — not invoiced';
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.stock_request_lines_problem(p_type text, p_lines jsonb)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_line jsonb;
  v_product_id text;
  v_quantity text;
  v_vendor text;
  v_active boolean;
  v_name text;
  v_seen text[] := '{}';
BEGIN
  IF p_lines IS NULL OR jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RETURN 'Add at least one product line';
  END IF;

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    IF jsonb_typeof(v_line) IS DISTINCT FROM 'object' THEN
      RETURN 'Each line needs a product and a quantity';
    END IF;
    v_product_id := nullif(btrim(coalesce(v_line->>'product_id', '')), '');
    v_quantity := btrim(coalesce(v_line->>'quantity', ''));
    IF v_product_id IS NULL THEN
      RETURN 'Each line needs a product';
    END IF;
    IF v_quantity !~ '^[0-9]{1,5}$' OR v_quantity::int < 1 THEN
      RETURN 'Each line needs a whole quantity of at least 1';
    END IF;
    IF v_product_id = ANY (v_seen) THEN
      RETURN 'A product appears on more than one line';
    END IF;
    v_seen := v_seen || v_product_id;

    SELECT line.vendor, line.is_active, line.product_name
    INTO v_vendor, v_active, v_name
    FROM public.product_lines AS line
    WHERE line.id = v_product_id;

    IF NOT FOUND THEN
      RETURN 'A line names a product that is not in the catalog';
    END IF;
    IF NOT coalesce(v_active, false) THEN
      RETURN format('%s is not an active product', v_name);
    END IF;
    IF p_type = 'Rentals' AND coalesce(v_vendor, '') IS DISTINCT FROM 'Starlink' THEN
      RETURN 'Rentals is only for Starlink kits';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.stock_request_insert_lines(p_request_id uuid, p_lines jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.stock_request_lines (request_id, product_id, product_name, quantity_requested, sort_order)
  SELECT
    p_request_id,
    line.id,
    line.product_name,
    (entry.value->>'quantity')::int,
    (entry.ordinality - 1)::int
  FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS entry(value, ordinality)
  JOIN public.product_lines AS line ON line.id = btrim(entry.value->>'product_id');
$$;

CREATE OR REPLACE FUNCTION public.line_issued_count(p_line public.stock_request_lines)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT count(*)::int FROM public.active_transactions AS t WHERE t.request_line_id = p_line.id;
$$;

COMMENT ON FUNCTION public.line_issued_count(public.stock_request_lines) IS
  'Units issued on this line: active transactions with this request_line_id. Never stored.';

CREATE OR REPLACE FUNCTION public.stock_request_issued_total(p_request_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT count(*)::int FROM public.active_transactions AS t WHERE t.request_id = p_request_id;
$$;

CREATE OR REPLACE FUNCTION public.stock_request_outstanding_total(p_request_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT coalesce(sum(greatest(
    line.quantity_requested
      - (SELECT count(*) FROM public.active_transactions AS t WHERE t.request_line_id = line.id),
    0
  )), 0)::int
  FROM public.stock_request_lines AS line
  WHERE line.request_id = p_request_id;
$$;

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
BEGIN
  IF p_user_id IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO public.notifications (user_id, type, title, body, metadata)
  VALUES (p_user_id, p_type, p_title, p_body, jsonb_build_object('request_id', p_request_id::text));
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_stock_request_admins(
  p_type text,
  p_title text,
  p_body text,
  p_request_id uuid
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.notifications (user_id, type, title, body, metadata)
  SELECT profile.id, p_type, p_title, p_body, jsonb_build_object('request_id', p_request_id::text)
  FROM public.profiles AS profile
  WHERE profile.role = 'admin'
    AND profile.active IS TRUE
    AND profile.id IS DISTINCT FROM auth.uid();
$$;

-- Mirrors the request invoice onto every batch the request issued (Sale/Rentals only).
CREATE OR REPLACE FUNCTION public.sync_request_batch_invoices(p_request_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.stock_requests%ROWTYPE;
  v_batch text;
  v_row public.batch_invoices%ROWTYPE;
BEGIN
  SELECT * INTO v_req FROM public.stock_requests WHERE id = p_request_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  FOR v_batch IN
    SELECT DISTINCT coalesce(nullif(btrim(t.batch_id), ''), t.id)
    FROM public.active_transactions AS t
    WHERE t.request_id = p_request_id
      AND t.type IN ('Sale', 'Rentals')
  LOOP
    SELECT * INTO v_row FROM public.batch_invoices WHERE batch_id = v_batch FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO public.batch_invoices (
        batch_id, status, invoice_number, not_invoiced_reason, not_invoiced_kind,
        entered_by, entered_at, approval, approved_by, approved_at, legacy
      ) VALUES (
        v_batch, v_req.invoice_status, v_req.invoice_number, v_req.not_invoiced_reason, v_req.not_invoiced_kind,
        v_req.invoice_entered_by, coalesce(v_req.invoice_entered_at, now()),
        v_req.invoice_approval, v_req.invoice_approved_by, v_req.invoice_approved_at, false
      );
      INSERT INTO public.batch_invoice_events (
        batch_id, old_status, new_status, old_invoice_number, new_invoice_number,
        old_approval, new_approval, actor_id, reason
      ) VALUES (
        v_batch, NULL, v_req.invoice_status, NULL, v_req.invoice_number,
        NULL, v_req.invoice_approval, auth.uid(), nullif(btrim(coalesce(p_reason, '')), '')
      );
    ELSE
      IF (v_row.status, v_row.invoice_number, v_row.not_invoiced_reason, v_row.not_invoiced_kind, v_row.approval)
         IS DISTINCT FROM
         (v_req.invoice_status, v_req.invoice_number, v_req.not_invoiced_reason, v_req.not_invoiced_kind, v_req.invoice_approval) THEN
        PERFORM public.write_batch_invoice_event(
          v_batch, v_row, v_req.invoice_status, v_req.invoice_number, v_req.invoice_approval, p_reason
        );
      END IF;

      UPDATE public.batch_invoices
      SET
        status = v_req.invoice_status,
        invoice_number = v_req.invoice_number,
        not_invoiced_reason = v_req.not_invoiced_reason,
        not_invoiced_kind = v_req.not_invoiced_kind,
        approval = v_req.invoice_approval,
        approved_by = v_req.invoice_approved_by,
        approved_at = v_req.invoice_approved_at,
        rejection_reason = NULL,
        entered_by = coalesce(v_req.invoice_entered_by, entered_by),
        entered_at = coalesce(v_req.invoice_entered_at, entered_at),
        legacy = false
      WHERE batch_id = v_batch;
    END IF;

    PERFORM public.sync_legacy_invoice(v_batch, v_req.invoice_status, v_req.invoice_number);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.stock_request_today() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.stock_request_parse_date(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.stock_request_fields_problem(text, text, date, text, text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.stock_request_lines_problem(text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.line_issued_count(public.stock_request_lines) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.stock_request_issued_total(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.stock_request_outstanding_total(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_request_today() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.stock_request_parse_date(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.stock_request_fields_problem(text, text, date, text, text, text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.stock_request_lines_problem(text, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.line_issued_count(public.stock_request_lines) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.stock_request_issued_total(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.stock_request_outstanding_total(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.stock_request_insert_lines(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_stock_request(uuid, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_stock_request_admins(text, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_request_batch_invoices(uuid, text) FROM PUBLIC, anon, authenticated;


-- =============================================================================
-- 8. Display status
-- =============================================================================
CREATE OR REPLACE FUNCTION public.request_display_status(p_request public.stock_requests)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_request.review_state = 'cancelled' THEN 'cancelled'
    WHEN p_request.review_state = 'closed' THEN 'closed'
    WHEN p_request.review_state = 'rejected' THEN 'rejected'
    WHEN p_request.review_state = 'awaiting_approval' THEN 'awaiting_approval'
    WHEN counts.issued = 0 THEN 'being_reviewed'
    WHEN counts.issued < counts.requested THEN 'partially_issued'
    WHEN p_request.invoice_status = 'invoiced'
      OR (p_request.invoice_status = 'not_invoiced' AND p_request.invoice_approval = 'approved')
      THEN 'completed'
    ELSE 'awaiting_invoice'
  END
  FROM (
    SELECT
      coalesce(sum(line.quantity_requested), 0) AS requested,
      coalesce(sum(least(
        line.quantity_requested,
        (SELECT count(*) FROM public.active_transactions AS t WHERE t.request_line_id = line.id)
      )), 0) AS issued
    FROM public.stock_request_lines AS line
    WHERE line.request_id = p_request.id
  ) AS counts;
$$;

CREATE OR REPLACE FUNCTION public.request_display_status(p_request_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT public.request_display_status(request) FROM public.stock_requests AS request WHERE request.id = p_request_id;
$$;

COMMENT ON FUNCTION public.request_display_status(public.stock_requests) IS
  'cancelled | closed | rejected | awaiting_approval | being_reviewed | partially_issued | awaiting_invoice | completed.';

REVOKE ALL ON FUNCTION public.request_display_status(public.stock_requests) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.request_display_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_display_status(public.stock_requests) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.request_display_status(uuid) TO authenticated, service_role;


-- =============================================================================
-- 9. Request RPCs
-- =============================================================================

-- p_payload: { client_id, type, return_date, atlas_task_url, quotation_url, notes,
--              invoice_choice ('number'|'pending'|'not_invoiced'), invoice_number,
--              not_invoiced_reason, not_invoiced_kind, lines: [{ product_id, quantity }] }
CREATE OR REPLACE FUNCTION public.submit_request(p_payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role public.app_role := public.get_my_role();
  v_client text;
  v_type text;
  v_return date;
  v_atlas text;
  v_choice text;
  v_number text;
  v_reason text;
  v_kind text;
  v_lines jsonb;
  v_problem text;
  v_state text;
  v_id uuid;
BEGIN
  IF v_uid IS NULL OR NOT coalesce(v_role IN ('admin', 'sales', 'technicians'), false) THEN
    RAISE EXCEPTION 'You cannot submit stock requests'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Request details are missing'
      USING ERRCODE = 'check_violation';
  END IF;

  v_client := nullif(btrim(coalesce(p_payload->>'client_id', '')), '');
  v_type := nullif(btrim(coalesce(p_payload->>'type', '')), '');
  v_return := public.stock_request_parse_date(p_payload->>'return_date');
  v_atlas := nullif(btrim(coalesce(p_payload->>'atlas_task_url', '')), '');
  v_choice := nullif(btrim(coalesce(p_payload->>'invoice_choice', '')), '');
  v_number := btrim(coalesce(p_payload->>'invoice_number', ''));
  v_reason := btrim(coalesce(p_payload->>'not_invoiced_reason', ''));
  v_kind := nullif(btrim(coalesce(p_payload->>'not_invoiced_kind', '')), '');
  v_lines := p_payload->'lines';

  v_problem := public.stock_request_fields_problem(v_client, v_type, v_return, v_atlas, v_choice, v_number, v_reason, v_kind);
  IF v_problem IS NULL THEN
    v_problem := public.stock_request_lines_problem(v_type, v_lines);
  END IF;
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION '%', v_problem USING ERRCODE = 'check_violation';
  END IF;

  v_state := CASE WHEN v_choice = 'not_invoiced' THEN 'awaiting_approval' ELSE 'submitted' END;

  INSERT INTO public.stock_requests (
    client_id, created_by, review_state, type, return_date, atlas_task_url, quotation_url, notes,
    invoice_status, invoice_number, not_invoiced_reason, not_invoiced_kind, invoice_approval,
    invoice_entered_by, invoice_entered_at, submitted_at
  ) VALUES (
    v_client,
    v_uid,
    v_state,
    v_type,
    v_return,
    v_atlas,
    nullif(btrim(coalesce(p_payload->>'quotation_url', '')), ''),
    nullif(btrim(coalesce(p_payload->>'notes', '')), ''),
    CASE v_choice WHEN 'number' THEN 'invoiced' WHEN 'pending' THEN 'pending' ELSE 'not_invoiced' END,
    CASE WHEN v_choice = 'number' THEN v_number ELSE NULL END,
    CASE WHEN v_choice = 'not_invoiced' THEN v_reason ELSE NULL END,
    CASE WHEN v_choice = 'not_invoiced' THEN v_kind ELSE NULL END,
    CASE WHEN v_choice = 'not_invoiced' THEN 'awaiting' ELSE NULL END,
    v_uid,
    now(),
    now()
  )
  RETURNING id INTO v_id;

  PERFORM public.stock_request_insert_lines(v_id, v_lines);

  PERFORM public.log_stock_request_event(
    v_id,
    'submitted',
    NULL,
    v_state,
    jsonb_build_object(
      'type', v_type,
      'client_id', v_client,
      'invoice_choice', v_choice,
      'not_invoiced_kind', v_kind,
      'line_count', jsonb_array_length(v_lines)
    ),
    v_uid
  );

  IF v_state = 'awaiting_approval' THEN
    PERFORM public.notify_stock_request_admins(
      'request_awaiting_approval',
      '00000 request awaiting approval',
      format('A %s request was submitted as 00000 — not invoiced (%s).', v_type, v_kind),
      v_id
    );
  END IF;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_not_invoiced(p_request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_req public.stock_requests%ROWTYPE;
  v_state text;
BEGIN
  IF v_uid IS NULL OR public.get_my_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only an admin can approve 00000'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_req FROM public.stock_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request was not found';
  END IF;
  IF v_req.review_state IN ('rejected', 'cancelled') THEN
    RAISE EXCEPTION 'This request is %', v_req.review_state;
  END IF;
  IF v_req.invoice_status IS DISTINCT FROM 'not_invoiced' OR v_req.invoice_approval IS DISTINCT FROM 'awaiting' THEN
    RAISE EXCEPTION 'This request is not awaiting 00000 approval';
  END IF;
  IF v_req.created_by = v_uid OR v_req.invoice_entered_by = v_uid THEN
    RAISE EXCEPTION 'You cannot approve a 00000 you requested or entered';
  END IF;

  v_state := CASE WHEN v_req.review_state = 'awaiting_approval' THEN 'submitted' ELSE v_req.review_state END;

  UPDATE public.stock_requests
  SET
    invoice_approval = 'approved',
    invoice_approved_by = v_uid,
    invoice_approved_at = now(),
    review_state = v_state
  WHERE id = p_request_id;

  PERFORM public.sync_request_batch_invoices(p_request_id, NULL);

  PERFORM public.log_stock_request_event(
    p_request_id,
    'not_invoiced_approved',
    v_req.review_state,
    v_state,
    jsonb_build_object('not_invoiced_kind', v_req.not_invoiced_kind),
    v_uid
  );

  PERFORM public.notify_stock_request(
    v_req.created_by,
    'request_not_invoiced_approved',
    '00000 approved',
    'Your 00000 — not invoiced request was approved.',
    p_request_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_request(p_request_id uuid, p_code text, p_note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_req public.stock_requests%ROWTYPE;
  v_code text := btrim(coalesce(p_code, ''));
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF v_uid IS NULL OR public.get_my_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only an admin can reject a request'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_code NOT IN ('insufficient_customer_info', 'no_atlas_task', 'no_invoice', 'other') THEN
    RAISE EXCEPTION 'Pick a rejection reason'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_code = 'other' AND v_note IS NULL THEN
    RAISE EXCEPTION 'Explain the rejection when the reason is Other'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_req FROM public.stock_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request was not found';
  END IF;
  IF v_req.review_state NOT IN ('submitted', 'awaiting_approval') THEN
    RAISE EXCEPTION 'Only a submitted or awaiting-approval request can be rejected';
  END IF;
  IF public.stock_request_issued_total(p_request_id) > 0 THEN
    RAISE EXCEPTION 'Units are already issued on this request. Close the outstanding units instead';
  END IF;

  UPDATE public.stock_requests
  SET
    review_state = 'rejected',
    reject_reason_code = v_code,
    reject_note = v_note,
    rejected_by = v_uid,
    rejected_at = now()
  WHERE id = p_request_id;

  PERFORM public.log_stock_request_event(
    p_request_id,
    'rejected',
    v_req.review_state,
    'rejected',
    jsonb_build_object('reason_code', v_code, 'note', v_note),
    v_uid
  );

  PERFORM public.notify_stock_request(
    v_req.created_by,
    'request_rejected',
    'Request rejected',
    coalesce(v_note, replace(v_code, '_', ' ')),
    p_request_id
  );
END;
$$;

-- p_changes may carry any submit_request key. Keys left out keep their current value.
-- lines, when present, replaces every line.
CREATE OR REPLACE FUNCTION public.resubmit_request(p_request_id uuid, p_changes jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role public.app_role := public.get_my_role();
  v_req public.stock_requests%ROWTYPE;
  v_changes jsonb := coalesce(p_changes, '{}'::jsonb);
  v_client text;
  v_type text;
  v_return date;
  v_atlas text;
  v_quote text;
  v_notes text;
  v_choice text;
  v_number text;
  v_reason text;
  v_kind text;
  v_lines jsonb;
  v_problem text;
  v_state text;
BEGIN
  IF v_uid IS NULL OR NOT coalesce(v_role IN ('admin', 'sales', 'technicians'), false) THEN
    RAISE EXCEPTION 'You cannot resubmit stock requests'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF jsonb_typeof(v_changes) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Changes must be an object'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_req FROM public.stock_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request was not found';
  END IF;
  IF v_req.created_by IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Only the requester can resubmit this request'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_req.review_state IS DISTINCT FROM 'rejected' THEN
    RAISE EXCEPTION 'Only a rejected request can be resubmitted';
  END IF;
  IF public.stock_request_issued_total(p_request_id) > 0 THEN
    RAISE EXCEPTION 'Units are already issued on this request';
  END IF;

  v_client := CASE WHEN v_changes ? 'client_id'
    THEN nullif(btrim(coalesce(v_changes->>'client_id', '')), '') ELSE v_req.client_id END;
  v_type := CASE WHEN v_changes ? 'type'
    THEN nullif(btrim(coalesce(v_changes->>'type', '')), '') ELSE v_req.type END;
  v_return := CASE WHEN v_changes ? 'return_date'
    THEN public.stock_request_parse_date(v_changes->>'return_date') ELSE v_req.return_date END;
  v_atlas := CASE WHEN v_changes ? 'atlas_task_url'
    THEN nullif(btrim(coalesce(v_changes->>'atlas_task_url', '')), '') ELSE v_req.atlas_task_url END;
  v_quote := CASE WHEN v_changes ? 'quotation_url'
    THEN nullif(btrim(coalesce(v_changes->>'quotation_url', '')), '') ELSE v_req.quotation_url END;
  v_notes := CASE WHEN v_changes ? 'notes'
    THEN nullif(btrim(coalesce(v_changes->>'notes', '')), '') ELSE v_req.notes END;
  v_choice := CASE WHEN v_changes ? 'invoice_choice'
    THEN nullif(btrim(coalesce(v_changes->>'invoice_choice', '')), '')
    ELSE CASE v_req.invoice_status WHEN 'invoiced' THEN 'number' WHEN 'pending' THEN 'pending' ELSE 'not_invoiced' END
  END;
  v_number := CASE WHEN v_changes ? 'invoice_number'
    THEN btrim(coalesce(v_changes->>'invoice_number', '')) ELSE coalesce(v_req.invoice_number, '') END;
  v_reason := CASE WHEN v_changes ? 'not_invoiced_reason'
    THEN btrim(coalesce(v_changes->>'not_invoiced_reason', '')) ELSE coalesce(v_req.not_invoiced_reason, '') END;
  v_kind := CASE WHEN v_changes ? 'not_invoiced_kind'
    THEN nullif(btrim(coalesce(v_changes->>'not_invoiced_kind', '')), '') ELSE v_req.not_invoiced_kind END;

  IF v_changes ? 'lines' THEN
    v_lines := v_changes->'lines';
  ELSE
    SELECT coalesce(
      jsonb_agg(jsonb_build_object('product_id', line.product_id, 'quantity', line.quantity_requested) ORDER BY line.sort_order, line.id),
      '[]'::jsonb
    )
    INTO v_lines
    FROM public.stock_request_lines AS line
    WHERE line.request_id = p_request_id;
  END IF;

  v_problem := public.stock_request_fields_problem(v_client, v_type, v_return, v_atlas, v_choice, v_number, v_reason, v_kind);
  IF v_problem IS NULL THEN
    v_problem := public.stock_request_lines_problem(v_type, v_lines);
  END IF;
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION '%', v_problem USING ERRCODE = 'check_violation';
  END IF;

  v_state := CASE WHEN v_choice = 'not_invoiced' THEN 'awaiting_approval' ELSE 'submitted' END;

  UPDATE public.stock_requests
  SET
    client_id = v_client,
    type = v_type,
    return_date = v_return,
    atlas_task_url = v_atlas,
    quotation_url = v_quote,
    notes = v_notes,
    invoice_status = CASE v_choice WHEN 'number' THEN 'invoiced' WHEN 'pending' THEN 'pending' ELSE 'not_invoiced' END,
    invoice_number = CASE WHEN v_choice = 'number' THEN v_number ELSE NULL END,
    not_invoiced_reason = CASE WHEN v_choice = 'not_invoiced' THEN v_reason ELSE NULL END,
    not_invoiced_kind = CASE WHEN v_choice = 'not_invoiced' THEN v_kind ELSE NULL END,
    invoice_approval = CASE WHEN v_choice = 'not_invoiced' THEN 'awaiting' ELSE NULL END,
    invoice_approved_by = NULL,
    invoice_approved_at = NULL,
    invoice_entered_by = v_uid,
    invoice_entered_at = now(),
    review_state = v_state,
    reject_reason_code = NULL,
    reject_note = NULL,
    rejected_by = NULL,
    rejected_at = NULL,
    submitted_at = now()
  WHERE id = p_request_id;

  IF v_changes ? 'lines' THEN
    DELETE FROM public.stock_request_lines WHERE request_id = p_request_id;
    PERFORM public.stock_request_insert_lines(p_request_id, v_lines);
  END IF;

  PERFORM public.log_stock_request_event(
    p_request_id,
    'resubmitted',
    'rejected',
    v_state,
    jsonb_build_object(
      'changes', v_changes - 'lines',
      'lines_replaced', v_changes ? 'lines',
      'previous_reject_code', v_req.reject_reason_code
    ),
    v_uid
  );

  IF v_state = 'awaiting_approval' THEN
    PERFORM public.notify_stock_request_admins(
      'request_awaiting_approval',
      '00000 request awaiting approval',
      format('A %s request was resubmitted as 00000 — not invoiced (%s).', v_type, v_kind),
      p_request_id
    );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_request(p_request_id uuid, p_reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role public.app_role := public.get_my_role();
  v_req public.stock_requests%ROWTYPE;
  v_issued integer;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_allowed boolean := false;
BEGIN
  IF v_uid IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'You cannot cancel stock requests'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_req FROM public.stock_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request was not found';
  END IF;
  IF v_req.review_state IN ('cancelled', 'closed') THEN
    RAISE EXCEPTION 'This request is already %', v_req.review_state;
  END IF;

  v_issued := public.stock_request_issued_total(p_request_id);

  IF v_req.created_by = v_uid
     AND v_role <> 'viewer'
     AND v_issued = 0
     AND v_req.review_state IN ('submitted', 'awaiting_approval', 'rejected') THEN
    v_allowed := true;
  ELSIF v_role = 'admin' AND public.request_display_status(v_req) IS DISTINCT FROM 'completed' THEN
    v_allowed := true;
  END IF;

  IF NOT v_allowed THEN
    IF v_req.created_by = v_uid AND v_issued > 0 THEN
      RAISE EXCEPTION 'Units are already issued. Ask an admin to cancel or close this request';
    ELSIF v_role = 'admin' THEN
      RAISE EXCEPTION 'A completed request cannot be cancelled';
    END IF;
    RAISE EXCEPTION 'Only the requester or an admin can cancel this request'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.stock_requests
  SET
    review_state = 'cancelled',
    cancel_reason = v_reason,
    cancelled_by = v_uid,
    cancelled_at = now()
  WHERE id = p_request_id;

  PERFORM public.log_stock_request_event(
    p_request_id,
    'cancelled',
    v_req.review_state,
    'cancelled',
    jsonb_build_object('reason', v_reason, 'issued_count', v_issued),
    v_uid
  );

  IF v_req.created_by IS DISTINCT FROM v_uid THEN
    PERFORM public.notify_stock_request(
      v_req.created_by,
      'request_cancelled',
      'Request cancelled',
      coalesce(v_reason, 'An admin cancelled your stock request.'),
      p_request_id
    );
  END IF;
END;
$$;

-- p_scans: [{ serial, line_id?, cloud_key? }] (a bare serial string is also accepted).
-- Returns { ok, batch_id?, failures: [{ serial, reason }], serials: [...] }.
-- Any failure: nothing is written and every failing serial is reported.
CREATE OR REPLACE FUNCTION public.issue_units(p_request_id uuid, p_scans jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role public.app_role := public.get_my_role();
  v_req public.stock_requests%ROWTYPE;
  v_scan jsonb;
  v_serial text;
  v_line_hint text;
  v_scan_key text;
  v_item public.inventory_items%ROWTYPE;
  v_vendor text;
  v_product text;
  v_needs_key boolean;
  v_pool text;
  v_line_id uuid;
  v_line_product text;
  v_problem text;
  v_remaining jsonb;
  v_seen text[] := '{}';
  v_failures jsonb := '[]'::jsonb;
  v_serials jsonb := '[]'::jsonb;
  v_issued_labels text[] := '{}';
  v_upserts jsonb := '[]'::jsonb;
  v_txns jsonb := '[]'::jsonb;
  v_client_label text;
  v_today date;
  v_today_text text;
  v_date text;
  v_stamp text;
  v_batch text;
  v_n integer := 0;
  v_choice text;
  v_meta jsonb;
  v_outbound jsonb;
  v_item_status text;
  v_item_location text;
BEGIN
  IF v_uid IS NULL OR NOT coalesce(v_role IN ('admin', 'accounts'), false) THEN
    RAISE EXCEPTION 'Only admin or accounts can issue units'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_req FROM public.stock_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request was not found';
  END IF;
  IF v_req.review_state IS DISTINCT FROM 'submitted' THEN
    RAISE EXCEPTION '%', CASE v_req.review_state
      WHEN 'awaiting_approval' THEN 'This request is awaiting 00000 approval'
      WHEN 'rejected' THEN 'This request was rejected'
      WHEN 'cancelled' THEN 'This request is cancelled'
      WHEN 'closed' THEN 'This request is closed'
      ELSE 'This request cannot be issued'
    END USING ERRCODE = 'check_violation';
  END IF;
  IF p_scans IS NULL OR jsonb_typeof(p_scans) IS DISTINCT FROM 'array' OR jsonb_array_length(p_scans) = 0 THEN
    RAISE EXCEPTION 'Scan at least one serial'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT coalesce(jsonb_object_agg(
    line.id::text,
    line.quantity_requested
      - (SELECT count(*) FROM public.active_transactions AS t WHERE t.request_line_id = line.id)
  ), '{}'::jsonb)
  INTO v_remaining
  FROM public.stock_request_lines AS line
  WHERE line.request_id = p_request_id;

  SELECT coalesce(
    nullif(btrim(concat_ws(' - ', nullif(btrim(client.name), ''), nullif(btrim(client.company), ''))), ''),
    client.id
  )
  INTO v_client_label
  FROM public.clients AS client
  WHERE client.id = v_req.client_id;

  v_today := public.stock_request_today();
  v_today_text := to_char(v_today, 'YYYY-MM-DD');
  v_date := v_today_text || 'T00:00:00.000Z';
  v_stamp := ((extract(epoch FROM clock_timestamp()) * 1000)::bigint)::text;
  v_batch := 'BATCH-' || v_stamp || '-' || substr(md5(random()::text || p_request_id::text), 1, 7);
  v_choice := CASE v_req.invoice_status WHEN 'invoiced' THEN 'number' WHEN 'pending' THEN 'pending' ELSE 'not_invoiced' END;

  v_meta := jsonb_strip_nulls(jsonb_build_object(
    'request_id', v_req.id,
    'atlas_task_url', v_req.atlas_task_url
  ));
  IF v_req.type IN ('Sale', 'Rentals') THEN
    v_meta := v_meta || jsonb_build_object('invoice_choice', v_choice);
    IF v_choice = 'not_invoiced' THEN
      v_meta := v_meta || jsonb_build_object(
        'invoice_reason', v_req.not_invoiced_reason,
        'not_invoiced_kind', v_req.not_invoiced_kind
      );
    END IF;
  END IF;

  v_item_status := CASE v_req.type WHEN 'Sale' THEN 'Sold' WHEN 'POC Out' THEN 'POC' ELSE 'Rented' END;
  v_item_location := CASE v_req.type WHEN 'Sale' THEN 'Delivered' ELSE 'Client Site' END;

  FOR v_scan IN SELECT value FROM jsonb_array_elements(p_scans) LOOP
    v_problem := NULL;
    v_line_id := NULL;

    IF jsonb_typeof(v_scan) = 'string' THEN
      v_serial := btrim(v_scan #>> '{}');
      v_line_hint := NULL;
      v_scan_key := NULL;
    ELSIF jsonb_typeof(v_scan) = 'object' THEN
      v_serial := btrim(coalesce(v_scan->>'serial', v_scan->>'serial_number', ''));
      v_line_hint := nullif(btrim(coalesce(v_scan->>'line_id', '')), '');
      v_scan_key := nullif(btrim(coalesce(v_scan->>'cloud_key', '')), '');
    ELSE
      v_serial := '';
    END IF;

    IF v_serial = '' THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object('serial', '', 'reason', 'Serial is blank'));
      CONTINUE;
    END IF;
    IF v_serial = ANY (v_seen) THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object('serial', v_serial, 'reason', 'Scanned more than once'));
      CONTINUE;
    END IF;
    v_seen := v_seen || v_serial;

    SELECT * INTO v_item
    FROM public.inventory_items
    WHERE serial_number = v_serial AND deleted_at IS NULL
    ORDER BY id
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
      v_problem := 'Serial is not in inventory';
    ELSIF v_item.status IS DISTINCT FROM 'In Stock' THEN
      v_problem := format('Not in stock (status is %s)', v_item.status);
    END IF;

    IF v_problem IS NULL THEN
      SELECT line.vendor, line.product_name, line.requires_cloud_key
      INTO v_vendor, v_product, v_needs_key
      FROM public.product_lines AS line
      WHERE line.id = v_item.product_id;

      IF v_role = 'accounts' AND lower(btrim(coalesce(v_vendor, ''))) IS DISTINCT FROM 'fortinet' THEN
        v_problem := 'Accounts can only issue Fortinet units';
      END IF;
    END IF;

    IF v_problem IS NULL THEN
      IF v_line_hint IS NOT NULL THEN
        SELECT line.id, line.product_id INTO v_line_id, v_line_product
        FROM public.stock_request_lines AS line
        WHERE line.request_id = p_request_id AND line.id::text = v_line_hint;
        IF v_line_id IS NULL THEN
          v_problem := 'That line is not on this request';
        ELSIF v_line_product IS DISTINCT FROM v_item.product_id THEN
          v_problem := format('Serial is %s, not the product on this line', coalesce(v_product, 'another product'));
        ELSIF coalesce((v_remaining->>v_line_id::text)::int, 0) <= 0 THEN
          v_problem := 'This line is fully issued';
        END IF;
      ELSE
        SELECT line.id INTO v_line_id
        FROM public.stock_request_lines AS line
        WHERE line.request_id = p_request_id
          AND line.product_id = v_item.product_id
          AND coalesce((v_remaining->>line.id::text)::int, 0) > 0
        ORDER BY line.sort_order, line.id
        LIMIT 1;
        IF v_line_id IS NULL THEN
          IF EXISTS (
            SELECT 1 FROM public.stock_request_lines AS line
            WHERE line.request_id = p_request_id AND line.product_id = v_item.product_id
          ) THEN
            v_problem := format('All requested %s units are already issued', coalesce(v_product, 'product'));
          ELSE
            v_problem := format('%s is not on this request', coalesce(v_product, 'This product'));
          END IF;
        END IF;
      END IF;
    END IF;

    IF v_problem IS NULL THEN
      v_pool := coalesce(v_item.stock_pool, 'sale');
      IF v_req.type = 'Sale' AND v_pool IS DISTINCT FROM 'sale' THEN
        v_problem := format('Sale requires a sellable kit. Move it from %s to sale first', v_pool);
      ELSIF v_req.type = 'POC Out' AND v_pool NOT IN ('sale', 'demo') THEN
        v_problem := format('POC Out is not allowed from the %s group', v_pool);
      ELSIF v_req.type = 'Rentals' AND coalesce(v_vendor, '') IS DISTINCT FROM 'Starlink' THEN
        v_problem := 'Rentals is only for Starlink kits';
      ELSIF v_req.type = 'Rentals' AND v_pool NOT IN ('sale', 'rental') THEN
        v_problem := format('Rentals is not allowed from the %s group', v_pool);
      END IF;
    END IF;

    IF v_problem IS NULL
       AND coalesce(v_needs_key, false)
       AND nullif(btrim(coalesce(v_item.cloud_key, '')), '') IS NULL
       AND v_scan_key IS NULL THEN
      v_problem := 'Cloud key is required for this unit';
    END IF;

    IF v_problem IS NOT NULL THEN
      v_failures := v_failures || jsonb_build_array(jsonb_build_object('serial', v_serial, 'reason', v_problem));
      CONTINUE;
    END IF;

    v_remaining := jsonb_set(
      v_remaining,
      ARRAY[v_line_id::text],
      to_jsonb((v_remaining->>v_line_id::text)::int - 1)
    );
    v_n := v_n + 1;
    v_serials := v_serials || to_jsonb(v_serial);
    v_issued_labels := v_issued_labels || (
      v_serial || CASE WHEN v_scan_key IS NOT NULL THEN ' (cloud key ' || v_scan_key || ')' ELSE '' END
    );

    v_upserts := v_upserts || jsonb_build_array(
      to_jsonb(v_item) || jsonb_build_object(
        'status', v_item_status,
        'location', v_item_location,
        'client', v_client_label,
        'assigned_to', v_client_label,
        'poc_out_date', CASE WHEN v_req.type = 'Sale' THEN v_item.poc_out_date ELSE v_today_text END,
        'return_date', CASE WHEN v_req.type = 'Sale' THEN v_item.return_date ELSE to_char(v_req.return_date, 'YYYY-MM-DD') END,
        'cloud_key', coalesce(v_scan_key, v_item.cloud_key),
        'assignment_history', coalesce(v_item.assignment_history, '[]'::jsonb)
      )
    );

    v_txns := v_txns || jsonb_build_array(jsonb_build_object(
      'id', 'TXN-' || v_stamp || '-' || v_n || '-' || substr(md5(random()::text || v_serial), 1, 7),
      'type', v_req.type,
      'serial_number', v_serial,
      'item_name', coalesce(v_product, v_serial),
      'client', v_client_label,
      'date', v_date,
      'client_id', v_req.client_id,
      'invoice_number', CASE
        WHEN v_req.type IN ('Sale', 'Rentals') AND v_req.invoice_status = 'invoiced' THEN v_req.invoice_number
        ELSE NULL
      END,
      'assigned_to', v_client_label,
      'batch_id', v_batch,
      'created_by', v_uid,
      'request_id', v_req.id,
      'request_line_id', v_line_id,
      'metadata', v_meta || jsonb_build_object('request_line_id', v_line_id)
    ));
  END LOOP;

  IF jsonb_array_length(v_failures) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'failures', v_failures, 'serials', '[]'::jsonb);
  END IF;

  IF v_req.type IN ('POC Out', 'Rentals') THEN
    v_outbound := jsonb_build_object(
      'id', v_batch,
      'type', v_req.type,
      'client', v_client_label,
      'client_id', v_req.client_id,
      'start_date', v_today_text,
      'end_date', CASE WHEN v_req.type = 'Rentals' THEN to_char(v_req.return_date, 'YYYY-MM-DD') ELSE NULL END,
      'status', 'open',
      'invoice_number', CASE WHEN v_req.invoice_status = 'invoiced' THEN v_req.invoice_number ELSE NULL END,
      'created_at', now()
    );
  END IF;

  PERFORM set_config('app.request_issue', p_request_id::text, true);
  PERFORM public.apply_stock_movement(v_upserts, '[]'::jsonb, v_txns, v_outbound, NULL, NULL);
  PERFORM set_config('app.request_issue', '', true);

  IF v_req.type IN ('Sale', 'Rentals') THEN
    PERFORM public.sync_request_batch_invoices(p_request_id, NULL);
  END IF;

  PERFORM public.log_stock_request_event(
    p_request_id,
    'units_issued',
    v_req.review_state,
    v_req.review_state,
    jsonb_build_object(
      'batch_id', v_batch,
      'serials', v_serials,
      'count', v_n,
      'outstanding_after', public.stock_request_outstanding_total(p_request_id)
    ),
    v_uid
  );

  PERFORM public.notify_stock_request(
    v_req.created_by,
    'request_units_issued',
    'Units issued',
    format(
      '%s unit(s) were issued on your %s request: %s',
      v_n,
      v_req.type,
      array_to_string(v_issued_labels, ', ')
    ),
    p_request_id
  );

  RETURN jsonb_build_object('ok', true, 'batch_id', v_batch, 'failures', '[]'::jsonb, 'serials', v_serials);
END;
$$;

CREATE OR REPLACE FUNCTION public.close_outstanding(p_request_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_req public.stock_requests%ROWTYPE;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_issued integer;
  v_outstanding integer;
BEGIN
  IF v_uid IS NULL OR public.get_my_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only an admin can close outstanding units'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF char_length(v_reason) < 15 THEN
    RAISE EXCEPTION 'A reason of at least 15 characters is required'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_req FROM public.stock_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request was not found';
  END IF;
  IF v_req.review_state IS DISTINCT FROM 'submitted' THEN
    RAISE EXCEPTION 'Only an open request can have its outstanding units closed';
  END IF;

  v_issued := public.stock_request_issued_total(p_request_id);
  v_outstanding := public.stock_request_outstanding_total(p_request_id);
  IF v_issued = 0 THEN
    RAISE EXCEPTION 'Nothing is issued yet. Cancel the request instead';
  END IF;
  IF v_outstanding = 0 THEN
    RAISE EXCEPTION 'Nothing is outstanding on this request';
  END IF;

  UPDATE public.stock_requests
  SET
    review_state = 'closed',
    closed_reason = v_reason,
    closed_by = v_uid,
    closed_at = now()
  WHERE id = p_request_id;

  PERFORM public.log_stock_request_event(
    p_request_id,
    'closed_outstanding',
    'submitted',
    'closed',
    jsonb_build_object('reason', v_reason, 'issued_count', v_issued, 'outstanding_count', v_outstanding),
    v_uid
  );

  PERFORM public.notify_stock_request(
    v_req.created_by,
    'request_closed',
    'Request closed',
    format('%s outstanding unit(s) were closed: %s', v_outstanding, v_reason),
    p_request_id
  );
END;
$$;

-- Requester may make the first entry while the invoice is pending. After that only admin or
-- accounts may change it, with INV1 rules (reason to change a number; no going back to pending;
-- an approved 00000 is final). Updates the request and every batch it issued.
CREATE OR REPLACE FUNCTION public.set_request_invoice(
  p_request_id uuid,
  p_choice text,
  p_invoice_number text DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_kind text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role public.app_role := public.get_my_role();
  v_req public.stock_requests%ROWTYPE;
  v_choice text := btrim(coalesce(p_choice, ''));
  v_number text := btrim(coalesce(p_invoice_number, ''));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_kind text := nullif(btrim(coalesce(p_kind, '')), '');
  v_oversight boolean;
  v_owner boolean;
  v_problem text;
  v_status text;
  v_stored_number text;
  v_stored_reason text;
  v_stored_kind text;
  v_approval text;
  v_state text;
BEGIN
  IF v_uid IS NULL OR v_role IS NULL OR v_role = 'viewer' THEN
    RAISE EXCEPTION 'You cannot change this invoice'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_choice NOT IN ('number', 'pending', 'not_invoiced') THEN
    RAISE EXCEPTION 'Invoice choice must be a number, Invoice pending, or 00000 — not invoiced'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_req FROM public.stock_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request was not found';
  END IF;
  IF v_req.review_state IN ('cancelled', 'rejected') THEN
    RAISE EXCEPTION 'The invoice cannot change on a % request', v_req.review_state;
  END IF;

  v_oversight := v_role IN ('admin', 'accounts');
  v_owner := v_req.created_by = v_uid;

  IF NOT (v_oversight OR (v_owner AND v_req.invoice_status = 'pending')) THEN
    RAISE EXCEPTION 'Only admin or accounts can change an invoice once it is entered'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_choice = 'number' THEN
    v_problem := public.real_invoice_number_problem(v_number);
    IF v_problem IS NOT NULL THEN
      RAISE EXCEPTION '%', v_problem USING ERRCODE = 'check_violation';
    END IF;
    IF v_req.invoice_status = 'invoiced' AND v_req.invoice_number = v_number THEN
      RETURN;
    END IF;
    IF v_req.invoice_status = 'invoiced' AND char_length(v_reason) < 15 THEN
      RAISE EXCEPTION 'A reason of at least 15 characters is required to change an invoice number';
    END IF;
    IF v_req.invoice_status = 'not_invoiced' AND v_req.invoice_approval = 'approved' THEN
      RAISE EXCEPTION 'This 00000 is already approved';
    END IF;
    IF v_req.invoice_status = 'not_invoiced' AND char_length(v_reason) < 15 THEN
      RAISE EXCEPTION 'A reason of at least 15 characters is required to replace a 00000';
    END IF;
    v_status := 'invoiced';
    v_stored_number := v_number;
    v_stored_reason := NULL;
    v_stored_kind := NULL;
    v_approval := NULL;
  ELSIF v_choice = 'pending' THEN
    IF v_req.invoice_status = 'pending' THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'An entered invoice cannot go back to pending';
  ELSE
    IF v_req.invoice_status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'Only a pending invoice can be marked 00000 — not invoiced';
    END IF;
    IF char_length(v_reason) < 15 THEN
      RAISE EXCEPTION '00000 needs a reason of at least 15 characters';
    END IF;
    IF v_kind IS NULL OR v_kind NOT IN ('internal', 'complimentary') THEN
      RAISE EXCEPTION '00000 needs a kind: internal or complimentary';
    END IF;
    v_status := 'not_invoiced';
    v_stored_number := NULL;
    v_stored_reason := v_reason;
    v_stored_kind := v_kind;
    v_approval := 'awaiting';
  END IF;

  v_state := v_req.review_state;
  IF v_status = 'not_invoiced'
     AND v_req.review_state = 'submitted'
     AND public.stock_request_issued_total(p_request_id) = 0 THEN
    v_state := 'awaiting_approval';
  ELSIF v_status <> 'not_invoiced' AND v_req.review_state = 'awaiting_approval' THEN
    v_state := 'submitted';
  END IF;

  UPDATE public.stock_requests
  SET
    invoice_status = v_status,
    invoice_number = v_stored_number,
    not_invoiced_reason = v_stored_reason,
    not_invoiced_kind = v_stored_kind,
    invoice_approval = v_approval,
    invoice_approved_by = NULL,
    invoice_approved_at = NULL,
    invoice_entered_by = v_uid,
    invoice_entered_at = now(),
    review_state = v_state
  WHERE id = p_request_id;

  PERFORM public.sync_request_batch_invoices(p_request_id, nullif(v_reason, ''));

  PERFORM public.log_stock_request_event(
    p_request_id,
    'invoice_set',
    v_req.review_state,
    v_state,
    jsonb_build_object(
      'old_status', v_req.invoice_status,
      'new_status', v_status,
      'old_invoice_number', v_req.invoice_number,
      'new_invoice_number', v_stored_number,
      'not_invoiced_kind', v_stored_kind,
      'reason', nullif(v_reason, '')
    ),
    v_uid
  );

  IF v_status = 'not_invoiced' THEN
    PERFORM public.notify_stock_request_admins(
      'request_awaiting_approval',
      '00000 awaiting approval',
      format('A %s request was marked 00000 — not invoiced (%s).', v_req.type, v_stored_kind),
      p_request_id
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_request(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.approve_not_invoiced(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reject_request(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.resubmit_request(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_request(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.issue_units(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.close_outstanding(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_request_invoice(uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_request(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.approve_not_invoiced(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reject_request(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resubmit_request(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_request(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.issue_units(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.close_outstanding(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_request_invoice(uuid, text, text, text, text) TO authenticated, service_role;


-- =============================================================================
-- 10. Direct-write guard + RLS
-- =============================================================================

-- Runs as the caller (not SECURITY DEFINER): RPCs run as the owner and pass; PostgREST
-- clients run as authenticated and may only edit notes / quotation_url.
CREATE OR REPLACE FUNCTION public.tr_stock_requests_guard_direct_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['notes', 'quotation_url', 'updated_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['notes', 'quotation_url', 'updated_at']) THEN
    RAISE EXCEPTION 'Use the request actions to change this request'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.tr_stock_requests_guard_direct_update() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS stock_requests_guard_direct_update ON public.stock_requests;
CREATE TRIGGER stock_requests_guard_direct_update
  BEFORE UPDATE ON public.stock_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.tr_stock_requests_guard_direct_update();

ALTER TABLE public.stock_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_request_lines ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, DELETE ON TABLE public.stock_requests FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.stock_request_lines FROM anon, authenticated;

-- Technicians and sales keep read access to all requests for now.
CREATE POLICY stock_requests_select
  ON public.stock_requests FOR SELECT TO authenticated
  USING (
    created_by = (SELECT auth.uid())
    OR (SELECT public.get_my_role()) IN ('admin', 'accounts', 'viewer', 'technicians', 'sales')
  );

CREATE POLICY stock_requests_update_own
  ON public.stock_requests FOR UPDATE TO authenticated
  USING (
    created_by = (SELECT auth.uid())
    AND (SELECT public.get_my_role()) IN ('admin', 'sales', 'technicians', 'accounts')
    AND review_state IN ('submitted', 'awaiting_approval', 'rejected')
  )
  WITH CHECK (
    created_by = (SELECT auth.uid())
    AND (SELECT public.get_my_role()) IN ('admin', 'sales', 'technicians', 'accounts')
    AND review_state IN ('submitted', 'awaiting_approval', 'rejected')
  );

CREATE POLICY stock_requests_update_admin
  ON public.stock_requests FOR UPDATE TO authenticated
  USING ((SELECT public.get_my_role()) = 'admin')
  WITH CHECK ((SELECT public.get_my_role()) = 'admin');

CREATE POLICY stock_request_lines_select
  ON public.stock_request_lines FOR SELECT TO authenticated
  USING (
    (SELECT public.get_my_role()) IN ('admin', 'accounts', 'viewer', 'technicians', 'sales')
    OR EXISTS (
      SELECT 1
      FROM public.stock_requests AS request
      WHERE request.id = stock_request_lines.request_id
        AND request.created_by = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS stock_request_events_select_own ON public.stock_request_events;
CREATE POLICY stock_request_events_select_own
  ON public.stock_request_events FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.stock_requests AS request
      WHERE request.id = stock_request_events.request_id
        AND request.created_by = (SELECT auth.uid())
    )
  );

COMMENT ON FUNCTION public.issue_units(uuid, jsonb) IS
  'Admin (all lines) or accounts (Fortinet lines) issue scanned serials against a submitted request in one movement batch. '
  'Any failing serial returns failures and writes nothing.';
COMMENT ON FUNCTION public.set_request_invoice(uuid, text, text, text, text) IS
  'Sets the canonical request invoice and mirrors it onto every Sale/Rentals batch the request issued.';
