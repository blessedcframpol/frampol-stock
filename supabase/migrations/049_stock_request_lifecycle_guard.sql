-- Stock request lifecycle guard (inner transition gate; RLS stays the outer role gate).
--
-- Legal transitions:
--   draft       -> submitted     : owner or admin
--   draft       -> cancelled     : owner or admin
--   submitted   -> draft         : owner or admin
--   submitted   -> in_progress   : admin or technicians
--   submitted   -> serviced      : admin or technicians
--   submitted   -> cancelled     : owner or admin
--   in_progress -> serviced      : admin or technicians
--   in_progress -> cancelled     : admin or technicians
--   serviced    -> in_progress   : admin or technicians  (recovery from premature mark-serviced)
--   serviced    -> invoiced      : admin or accounts
--
-- invoiced and cancelled are terminal — no outbound edges.
-- Reservations are released on any transition INTO draft or cancelled (and logged).
--
-- Trigger name stock_requests_guard_status sorts before stock_requests_updated so this
-- BEFORE UPDATE guard rejects illegal transitions before updated_at / serviced_at side effects.
-- Reservation release on draft/cancelled lives only in the guard (020 cancel-clear removed below).

-- =============================================================================
-- 1. Transition guard
-- =============================================================================
CREATE OR REPLACE FUNCTION public.tr_stock_requests_guard_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role public.app_role;
  v_is_owner boolean;
  v_allowed boolean := false;
  v_released int := 0;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  v_role := (SELECT public.get_my_role());
  v_is_owner := (OLD.created_by = auth.uid());

  IF OLD.status = 'draft' AND NEW.status = 'submitted' AND (v_is_owner OR v_role = 'admin') THEN
    v_allowed := true;
  ELSIF OLD.status = 'draft' AND NEW.status = 'cancelled' AND (v_is_owner OR v_role = 'admin') THEN
    v_allowed := true;
  ELSIF OLD.status = 'submitted' AND NEW.status = 'draft' AND (v_is_owner OR v_role = 'admin') THEN
    v_allowed := true;
  ELSIF OLD.status = 'submitted' AND NEW.status = 'in_progress' AND v_role IN ('admin', 'technicians') THEN
    v_allowed := true;
  ELSIF OLD.status = 'submitted' AND NEW.status = 'serviced' AND v_role IN ('admin', 'technicians') THEN
    v_allowed := true;
  ELSIF OLD.status = 'submitted' AND NEW.status = 'cancelled' AND (v_is_owner OR v_role = 'admin') THEN
    v_allowed := true;
  ELSIF OLD.status = 'in_progress' AND NEW.status = 'serviced' AND v_role IN ('admin', 'technicians') THEN
    v_allowed := true;
  ELSIF OLD.status = 'in_progress' AND NEW.status = 'cancelled' AND v_role IN ('admin', 'technicians') THEN
    v_allowed := true;
  ELSIF OLD.status = 'serviced' AND NEW.status = 'in_progress' AND v_role IN ('admin', 'technicians') THEN
    v_allowed := true;
  ELSIF OLD.status = 'serviced' AND NEW.status = 'invoiced' AND v_role IN ('admin', 'accounts') THEN
    v_allowed := true;
  END IF;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Invalid stock request transition: % -> % (role %)',
      OLD.status, NEW.status, COALESCE(v_role::text, 'none');
  END IF;

  -- Serial requirement before serviced.
  -- Matches lineRequiresSerialsBeforeInvoice() in lib/stock-request-rules.ts ('%starlink%').
  -- Keep both in sync when the product rule changes.
  IF NEW.status = 'serviced' THEN
    IF EXISTS (
      SELECT 1 FROM public.stock_request_lines l
      WHERE l.request_id = NEW.id
        AND lower(l.product_name) LIKE '%starlink%'
        AND (
          SELECT count(*) FROM public.inventory_items i
          WHERE i.reserved_for_request_line_id = l.id
        ) < l.quantity_requested
    ) THEN
      RAISE EXCEPTION 'Cannot mark serviced: Starlink lines need all serials assigned';
    END IF;
  END IF;

  -- Release reservations when entering draft or cancelled (from a state that was not).
  IF NEW.status IN ('draft', 'cancelled') AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE public.inventory_items i
    SET reserved_for_request_line_id = NULL
    FROM public.stock_request_lines l
    WHERE l.request_id = NEW.id
      AND i.reserved_for_request_line_id = l.id;

    GET DIAGNOSTICS v_released = ROW_COUNT;

    IF v_released > 0 THEN
      PERFORM public.log_stock_request_event(
        NEW.id,
        'serials_released',
        OLD.status,
        NEW.status,
        jsonb_build_object('released_count', v_released),
        auth.uid()
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.tr_stock_requests_guard_status_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tr_stock_requests_guard_status_transition() FROM anon, authenticated;

DROP TRIGGER IF EXISTS stock_requests_guard_status ON public.stock_requests;
CREATE TRIGGER stock_requests_guard_status
  BEFORE UPDATE ON public.stock_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.tr_stock_requests_guard_status_transition();

COMMENT ON FUNCTION public.tr_stock_requests_guard_status_transition() IS
  'Inner status transition gate for stock_requests. Fires before stock_requests_updated. '
  'invoiced/cancelled terminal; serviced->in_progress recovers premature serviced; '
  'releases reservations on enter draft/cancelled.';

-- =============================================================================
-- 1b. updated_at / serviced_at only — reservation release moved to the guard
-- =============================================================================
CREATE OR REPLACE FUNCTION public.tr_stock_requests_updated_at_and_side_effects()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  IF NEW.status = 'serviced' AND (TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status) THEN
    NEW.serviced_at := COALESCE(NEW.serviced_at, now());
  END IF;
  -- Cancel reservation clear removed: public.tr_stock_requests_guard_status_transition
  -- now releases reserved_for_request_line_id on enter draft or cancelled (and logs it).
  RETURN NEW;
END;
$$;

-- =============================================================================
-- 2. Serial RPCs — FOR UPDATE locks + auto-promote submitted -> in_progress
-- =============================================================================
CREATE OR REPLACE FUNCTION public.assign_serial_to_request_line(p_line_id uuid, p_inventory_item_id text)
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
  IF (SELECT public.get_my_role()) NOT IN ('admin', 'technicians') THEN
    RAISE EXCEPTION 'assign_serial_to_request_line: forbidden';
  END IF;

  -- Lock order: line before inventory (same order as release) to avoid deadlock.
  SELECT * INTO line_rec FROM public.stock_request_lines WHERE id = p_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request line not found';
  END IF;

  SELECT * INTO req_rec FROM public.stock_requests WHERE id = line_rec.request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request not found';
  END IF;

  IF req_rec.status NOT IN ('submitted', 'in_progress') THEN
    RAISE EXCEPTION 'Request is not open for fulfillment';
  END IF;

  SELECT * INTO inv_rec FROM public.inventory_items WHERE id = p_inventory_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory item not found';
  END IF;

  IF inv_rec.status IS DISTINCT FROM 'In Stock' THEN
    RAISE EXCEPTION 'Item must be In Stock';
  END IF;

  IF inv_rec.reserved_for_request_line_id IS NOT NULL AND inv_rec.reserved_for_request_line_id IS DISTINCT FROM p_line_id THEN
    RAISE EXCEPTION 'Item is reserved for another request';
  END IF;

  SELECT pl.product_name INTO pl_product
  FROM public.product_lines pl
  WHERE pl.id = inv_rec.product_id;

  IF btrim(pl_product) IS DISTINCT FROM btrim(line_rec.product_name) THEN
    RAISE EXCEPTION 'Product name does not match this line (expected %, got %)', line_rec.product_name, pl_product;
  END IF;

  SELECT COUNT(*)::int INTO assigned_count
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

  -- Auto-promote: first assign on a submitted request moves it to in_progress.
  -- Fires stock_requests_guard_status (legal for admin/technicians) then the 046
  -- status-change logger. No recursion into this RPC; we do not hold a lock on
  -- stock_requests (only on the line + inventory rows).
  IF req_rec.status = 'submitted' THEN
    UPDATE public.stock_requests
    SET status = 'in_progress'
    WHERE id = req_rec.id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_serial_from_request_line(p_inventory_item_id text)
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
  IF (SELECT public.get_my_role()) NOT IN ('admin', 'technicians') THEN
    RAISE EXCEPTION 'release_serial_from_request_line: forbidden';
  END IF;

  -- Peek line id, then lock line before inventory (same order as assign).
  SELECT reserved_for_request_line_id INTO v_line_id
  FROM public.inventory_items
  WHERE id = p_inventory_item_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory item not found';
  END IF;

  IF v_line_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM 1 FROM public.stock_request_lines WHERE id = v_line_id FOR UPDATE;

  SELECT * INTO inv_rec FROM public.inventory_items WHERE id = p_inventory_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory item not found';
  END IF;

  -- Re-check under lock (reservation may have changed).
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

GRANT EXECUTE ON FUNCTION public.assign_serial_to_request_line(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_serial_from_request_line(text) TO authenticated;

-- =============================================================================
-- 3. InitPlan wrapper on oversight SELECT policy (review item 12)
-- =============================================================================
DROP POLICY IF EXISTS stock_request_events_select_oversight ON public.stock_request_events;
CREATE POLICY stock_request_events_select_oversight
  ON public.stock_request_events
  FOR SELECT
  TO authenticated
  USING ((SELECT public.get_my_role()) IN ('admin', 'accounts'));
