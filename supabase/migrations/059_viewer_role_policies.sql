-- Add viewer to read-only data policies.
--
-- SECURITY DEFINER audit:
-- - assign_serial_to_request_line: admin/technicians explicit allowlist.
-- - release_serial_from_request_line: admin/technicians explicit allowlist.
-- - create_request_serviced_notification: admin/technicians explicit allowlist.
-- Their previous NOT IN checks did not reject a NULL role; these definitions do.
-- ensure_product_line is already an explicit admin/technicians/sales allowlist in 057.
--
-- Apply only after 058_add_viewer_role.sql has committed.

BEGIN;

ALTER POLICY "Non-admin read batch_reversals"
  ON public.batch_reversals
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians', 'viewer'));

ALTER POLICY "Non-admin read clients"
  ON public.clients
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians', 'viewer'));

ALTER POLICY "Non-admin read inventory_items"
  ON public.inventory_items
  USING (
    (SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians', 'viewer')
    AND deleted_at IS NULL
  );

ALTER POLICY "Non-admin read kit_inspections"
  ON public.kit_inspections
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians', 'viewer'));

ALTER POLICY "Non-admin read outbound_batches"
  ON public.outbound_batches
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians', 'viewer'));

ALTER POLICY "Non-admin read product_lines"
  ON public.product_lines
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians', 'viewer'));

ALTER POLICY "Non-admin read remediation_cases"
  ON public.remediation_cases
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians', 'viewer'));

ALTER POLICY "Staff read remediation_providers"
  ON public.remediation_providers
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians', 'viewer'));

ALTER POLICY "stock_request_lines select staff"
  ON public.stock_request_lines
  USING (
    (SELECT public.get_my_role()) IN (
      'admin',
      'sales',
      'accounts',
      'technicians',
      'viewer'
    )
  );

ALTER POLICY "stock_requests select staff"
  ON public.stock_requests
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians', 'viewer'));

ALTER POLICY "Non-admin read stock_takes"
  ON public.stock_takes
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians', 'viewer'));

ALTER POLICY "Non-admin read transactions"
  ON public.transactions
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians', 'viewer'));

ALTER POLICY "uploads select staff"
  ON storage.objects
  USING (
    bucket_id = 'uploads'
    AND (storage.foldername(name))[1] IN (
      'quotations',
      'delivery-notes',
      'invoices'
    )
    AND (SELECT public.get_my_role()) IN (
      'admin',
      'sales',
      'accounts',
      'technicians',
      'viewer'
    )
  );

-- Existing owner-only write policies without role predicates would otherwise
-- admit a viewer if a fixture or imported row named that viewer as owner.
-- app_event_logs_insert_own stays user_id = auth.uid() only: diagnostics are
-- not a stock write, and viewers must be able to log errors they hit.

ALTER POLICY "stock_request_lines delete owner draft"
  ON public.stock_request_lines
  USING (
    (SELECT public.get_my_role()) IN ('sales', 'technicians')
    AND EXISTS (
      SELECT 1
      FROM public.stock_requests r
      WHERE r.id = stock_request_lines.request_id
        AND r.created_by = auth.uid()
        AND r.status = 'draft'
    )
  );

ALTER POLICY "stock_request_lines update owner draft"
  ON public.stock_request_lines
  USING (
    (SELECT public.get_my_role()) IN ('sales', 'technicians')
    AND EXISTS (
      SELECT 1
      FROM public.stock_requests r
      WHERE r.id = stock_request_lines.request_id
        AND r.created_by = auth.uid()
        AND r.status = 'draft'
    )
  )
  WITH CHECK (
    (SELECT public.get_my_role()) IN ('sales', 'technicians')
    AND EXISTS (
      SELECT 1
      FROM public.stock_requests r
      WHERE r.id = stock_request_lines.request_id
        AND r.created_by = auth.uid()
        AND r.status = 'draft'
    )
  );

-- Convert NULL-leaking NOT IN checks to explicit positive allowlists.
CREATE OR REPLACE FUNCTION public.assign_serial_to_request_line(
  p_line_id uuid,
  p_inventory_item_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  line_rec public.stock_request_lines%ROWTYPE;
  req_rec public.stock_requests%ROWTYPE;
  inv_rec public.inventory_items%ROWTYPE;
  pl_product text;
  assigned_count int;
BEGIN
  IF NOT COALESCE(
    (SELECT public.get_my_role()) = ANY (
      ARRAY['admin', 'technicians']::public.app_role[]
    ),
    false
  ) THEN
    RAISE EXCEPTION 'assign_serial_to_request_line: forbidden';
  END IF;

  SELECT * INTO line_rec
  FROM public.stock_request_lines
  WHERE id = p_line_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request line not found';
  END IF;

  SELECT * INTO req_rec
  FROM public.stock_requests
  WHERE id = line_rec.request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request not found';
  END IF;

  IF req_rec.status NOT IN ('submitted', 'in_progress') THEN
    RAISE EXCEPTION 'Request is not open for fulfillment';
  END IF;

  SELECT * INTO inv_rec
  FROM public.inventory_items
  WHERE id = p_inventory_item_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory item not found';
  END IF;

  IF inv_rec.status IS DISTINCT FROM 'In Stock' THEN
    RAISE EXCEPTION 'Item must be In Stock';
  END IF;

  IF inv_rec.reserved_for_request_line_id IS NOT NULL
    AND inv_rec.reserved_for_request_line_id IS DISTINCT FROM p_line_id
  THEN
    RAISE EXCEPTION 'Item is reserved for another request';
  END IF;

  SELECT pl.product_name INTO pl_product
  FROM public.product_lines pl
  WHERE pl.id = inv_rec.product_id;

  IF inv_rec.product_id IS DISTINCT FROM line_rec.product_id THEN
    RAISE EXCEPTION
      'Product name does not match this line (expected %, got %)',
      line_rec.product_name,
      pl_product;
  END IF;

  SELECT count(*)::int INTO assigned_count
  FROM public.inventory_items
  WHERE reserved_for_request_line_id = p_line_id;

  IF assigned_count >= line_rec.quantity_requested THEN
    RAISE EXCEPTION 'This line already has all units assigned';
  END IF;

  UPDATE public.inventory_items
  SET reserved_for_request_line_id = p_line_id
  WHERE id = p_inventory_item_id;

  PERFORM public.log_stock_request_event(
    req_rec.id,
    'serial_assigned',
    NULL,
    NULL,
    jsonb_build_object(
      'line_id', p_line_id,
      'inventory_item_id', p_inventory_item_id,
      'serial_number', inv_rec.serial_number
    ),
    auth.uid()
  );

  IF req_rec.status = 'submitted' THEN
    UPDATE public.stock_requests
    SET status = 'in_progress'
    WHERE id = req_rec.id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_serial_from_request_line(
  p_inventory_item_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inv_rec public.inventory_items%ROWTYPE;
  req_rec public.stock_requests%ROWTYPE;
  v_line_id uuid;
BEGIN
  IF NOT COALESCE(
    (SELECT public.get_my_role()) = ANY (
      ARRAY['admin', 'technicians']::public.app_role[]
    ),
    false
  ) THEN
    RAISE EXCEPTION 'release_serial_from_request_line: forbidden';
  END IF;

  SELECT reserved_for_request_line_id INTO v_line_id
  FROM public.inventory_items
  WHERE id = p_inventory_item_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory item not found';
  END IF;

  IF v_line_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM 1
  FROM public.stock_request_lines
  WHERE id = v_line_id
  FOR UPDATE;

  SELECT * INTO inv_rec
  FROM public.inventory_items
  WHERE id = p_inventory_item_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory item not found';
  END IF;

  IF inv_rec.reserved_for_request_line_id IS NULL THEN
    RETURN;
  END IF;
  v_line_id := inv_rec.reserved_for_request_line_id;

  SELECT r.* INTO req_rec
  FROM public.stock_requests r
  JOIN public.stock_request_lines l ON l.request_id = r.id
  WHERE l.id = v_line_id;

  IF req_rec.status NOT IN ('submitted', 'in_progress') THEN
    RAISE EXCEPTION 'Cannot release: request is not open for fulfillment';
  END IF;

  UPDATE public.inventory_items
  SET reserved_for_request_line_id = NULL
  WHERE id = p_inventory_item_id;

  PERFORM public.log_stock_request_event(
    req_rec.id,
    'serial_released',
    NULL,
    NULL,
    jsonb_build_object(
      'line_id', v_line_id,
      'inventory_item_id', p_inventory_item_id,
      'serial_number', inv_rec.serial_number
    ),
    auth.uid()
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.create_request_serviced_notification(
  p_request_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  IF NOT COALESCE(
    (SELECT public.get_my_role()) = ANY (
      ARRAY['admin', 'technicians']::public.app_role[]
    ),
    false
  ) THEN
    RAISE EXCEPTION 'create_request_serviced_notification: forbidden';
  END IF;

  SELECT id, created_by, status INTO r
  FROM public.stock_requests
  WHERE id = p_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request not found';
  END IF;

  IF r.status IS DISTINCT FROM 'serviced' THEN
    RAISE EXCEPTION 'Request must be in serviced status';
  END IF;

  INSERT INTO public.notifications (user_id, type, title, body, metadata)
  VALUES (
    r.created_by,
    'request_serviced',
    'Request serviced',
    'Your stock request has been serviced. You can follow up with accounts for invoicing.',
    jsonb_build_object('request_id', r.id::text)
  );
END;
$$;

-- Defensive assertion: viewer must never enter a write-capable policy.
DO $$
DECLARE
  v_bad_policies text;
BEGIN
  SELECT string_agg(
    format('%I.%I: %I (%s)', schemaname, tablename, policyname, cmd),
    ', '
    ORDER BY schemaname, tablename, policyname
  )
  INTO v_bad_policies
  FROM pg_policies
  WHERE cmd <> 'SELECT'
    AND (
      position('viewer' IN COALESCE(qual, '')) > 0
      OR position('viewer' IN COALESCE(with_check, '')) > 0
    );

  IF v_bad_policies IS NOT NULL THEN
    RAISE EXCEPTION
      '059_viewer_role_policies: non-SELECT policies mention viewer: %',
      v_bad_policies;
  END IF;
END;
$$;

COMMIT;
