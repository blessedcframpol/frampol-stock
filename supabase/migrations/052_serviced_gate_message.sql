-- Serviced-gate exception copy: requires_serial is not Starlink-specific.
-- Recreates tr_stock_requests_guard_status_transition from 051 with only the RAISE
-- message changed. Trigger name stock_requests_guard_status still sorts before
-- stock_requests_updated.

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
      RAISE EXCEPTION 'Cannot mark serviced: serial-tracked lines need all serials assigned';
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
