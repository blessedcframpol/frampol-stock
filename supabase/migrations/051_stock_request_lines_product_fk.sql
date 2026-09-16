-- Product FK on stock_request_lines + requires_serial catalog flag (mechanism, not gating).
--
-- product_id is the single matching key, replacing five divergent name-matching rules
-- (UI exact-after-trim, RPC btrim-both, availability trim-and-lowercase, the trigger's
-- lower LIKE, and the client-side includes()). requires_serial replaces the '%starlink%'
-- predicate in the 049 trigger; product_name is retained for display and deprecated.
--
-- requires_serial has NO UI yet. A new serial-tracked product must be flagged manually with
--
--   UPDATE public.product_lines SET requires_serial = true WHERE id = '<product_line_id>';
--
-- until the product lines admin screen exists.
--
-- Backfill: 20 product_lines rows match lower(btrim(product_name)) LIKE '%starlink%'.
-- That count is expected and exactly reproduces the previous '%starlink%' predicate —
-- this migration changes the mechanism, not the gating.
--
-- Also closes leftover SECURITY DEFINER EXECUTE grants to PUBLIC/anon (046 pattern).
-- get_my_role() is called from RLS policies as the querying role; authenticated needs
-- EXECUTE. Trigger functions get no GRANT (they run as the table owner).

-- =============================================================================
-- 0. SECURITY DEFINER grants
-- =============================================================================

REVOKE ALL ON FUNCTION public.ensure_product_line(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_product_line(text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.ensure_product_line(text, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.assign_serial_to_request_line(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_serial_to_request_line(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.assign_serial_to_request_line(uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.release_serial_from_request_line(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_serial_from_request_line(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.release_serial_from_request_line(text) TO authenticated;

REVOKE ALL ON FUNCTION public.create_request_serviced_notification(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_request_serviced_notification(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_request_serviced_notification(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.get_my_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_role() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_my_role() TO authenticated;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM anon, authenticated;

REVOKE ALL ON FUNCTION public.tr_stock_requests_updated_at_and_side_effects() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tr_stock_requests_updated_at_and_side_effects() FROM anon, authenticated;

-- =============================================================================
-- 1. requires_serial on product_lines
-- =============================================================================

ALTER TABLE public.product_lines
  ADD COLUMN IF NOT EXISTS requires_serial boolean NOT NULL DEFAULT false;

-- Default false preserves current behaviour: only Starlink is gated today.
-- 20 rows — exact reproduction of the previous '%starlink%' predicate.
UPDATE public.product_lines
SET requires_serial = true
WHERE lower(btrim(product_name)) LIKE '%starlink%';

COMMENT ON COLUMN public.product_lines.requires_serial IS
  'When true, every requested unit on a stock-request line for this catalog row must have '
  'an assigned serial before the request can be marked serviced. Replaces the ''%starlink%'' '
  'string predicate that previously lived in the 049 trigger and lib/stock-request-rules.ts. '
  'No UI yet — flag new serial-tracked products with '
  'UPDATE public.product_lines SET requires_serial = true WHERE id = ''<product_line_id>'';';

-- =============================================================================
-- 2. product_id on stock_request_lines
-- =============================================================================

ALTER TABLE public.stock_request_lines
  ADD COLUMN IF NOT EXISTS product_id text;

UPDATE public.stock_request_lines l
SET product_id = p.id
FROM public.product_lines p
WHERE lower(btrim(p.product_name)) = lower(btrim(l.product_name))
  AND l.product_id IS NULL;

DO $$
DECLARE v_unmapped int;
BEGIN
  SELECT count(*) INTO v_unmapped
  FROM public.stock_request_lines WHERE product_id IS NULL;
  IF v_unmapped > 0 THEN
    RAISE EXCEPTION 'stock_request_lines: % row(s) could not be mapped to a product_lines id', v_unmapped;
  END IF;
END $$;

ALTER TABLE public.stock_request_lines
  ALTER COLUMN product_id SET NOT NULL;

ALTER TABLE public.stock_request_lines
  DROP CONSTRAINT IF EXISTS stock_request_lines_product_id_fkey;
ALTER TABLE public.stock_request_lines
  ADD CONSTRAINT stock_request_lines_product_id_fkey
    FOREIGN KEY (product_id) REFERENCES public.product_lines(id)
    ON UPDATE CASCADE ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_stock_request_lines_product_id
  ON public.stock_request_lines(product_id);

COMMENT ON COLUMN public.stock_request_lines.product_id IS
  'FK to product_lines. Single matching key for assign/availability/serial gating.';

COMMENT ON COLUMN public.stock_request_lines.product_name IS
  'Deprecated: retained for display only. Matching uses product_id. Drop once app code stops reading this column.';

COMMENT ON TABLE public.stock_request_lines IS
  'Line items: product_id is the catalog FK; product_name is deprecated display text.';

-- =============================================================================
-- 3. assign_serial_to_request_line — product_id match (049 body otherwise verbatim)
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

  IF inv_rec.product_id IS DISTINCT FROM line_rec.product_id THEN
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

GRANT EXECUTE ON FUNCTION public.assign_serial_to_request_line(uuid, text) TO authenticated;

-- =============================================================================
-- 4. Guard trigger — serial EXISTS uses product_lines.requires_serial
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

  -- Serial requirement before serviced: product_lines.requires_serial (051).
  IF NEW.status = 'serviced' THEN
    IF EXISTS (
      SELECT 1 FROM public.stock_request_lines l
      JOIN public.product_lines p ON p.id = l.product_id
      WHERE l.request_id = NEW.id
        AND p.requires_serial
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
