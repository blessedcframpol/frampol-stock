-- Immutable audit log for stock request lifecycle.
-- Capture via triggers (direct client writes) + serial RPC extensions (same transaction).

-- =============================================================================
-- 1. Table
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.stock_request_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.stock_requests(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  from_status text NULL,
  to_status text NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NULL UNIQUE
);

COMMENT ON TABLE public.stock_request_events IS
  'Append-only request lifecycle audit. Written by SECURITY DEFINER helpers/triggers only; no client INSERT.';

CREATE INDEX IF NOT EXISTS idx_stock_request_events_request_created
  ON public.stock_request_events (request_id, created_at);

-- =============================================================================
-- 2. Immutability + RLS
-- =============================================================================
ALTER TABLE public.stock_request_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.stock_request_events FROM anon, authenticated;
GRANT SELECT ON TABLE public.stock_request_events TO authenticated;

DROP POLICY IF EXISTS stock_request_events_select_oversight ON public.stock_request_events;
CREATE POLICY stock_request_events_select_oversight
  ON public.stock_request_events
  FOR SELECT
  TO authenticated
  USING (public.get_my_role() IN ('admin', 'accounts'));

-- No INSERT / UPDATE / DELETE policies for authenticated → denied under RLS.

-- =============================================================================
-- 3. Writer (SECURITY DEFINER) — not exposed to clients
-- =============================================================================
CREATE OR REPLACE FUNCTION public.log_stock_request_event(
  p_request_id uuid,
  p_event_type text,
  p_from_status text DEFAULT NULL,
  p_to_status text DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_actor_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
BEGIN
  v_actor := COALESCE(p_actor_id, auth.uid());

  INSERT INTO public.stock_request_events (
    request_id,
    actor_id,
    event_type,
    from_status,
    to_status,
    payload
  ) VALUES (
    p_request_id,
    v_actor,
    p_event_type,
    p_from_status,
    p_to_status,
    COALESCE(p_payload, '{}'::jsonb)
  );
END;
$$;

COMMENT ON FUNCTION public.log_stock_request_event(uuid, text, text, text, jsonb, uuid) IS
  'Internal writer for stock_request_events. Called from triggers and serial RPCs only.';

REVOKE ALL ON FUNCTION public.log_stock_request_event(uuid, text, text, text, jsonb, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_stock_request_event(uuid, text, text, text, jsonb, uuid) FROM anon, authenticated;
-- SECURITY DEFINER callers (triggers / serial RPCs) run as owner and do not need client EXECUTE.

-- =============================================================================
-- 4. Triggers on stock_requests
-- =============================================================================
CREATE OR REPLACE FUNCTION public.tr_stock_requests_log_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.log_stock_request_event(
    NEW.id,
    'created',
    NULL,
    NEW.status,
    jsonb_build_object('client_id', NEW.client_id),
    auth.uid()
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stock_requests_log_created ON public.stock_requests;
CREATE TRIGGER stock_requests_log_created
  AFTER INSERT ON public.stock_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.tr_stock_requests_log_created();

CREATE OR REPLACE FUNCTION public.tr_stock_requests_log_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event_type text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  v_event_type := CASE NEW.status
    WHEN 'submitted' THEN 'submitted'
    WHEN 'in_progress' THEN 'in_progress'
    WHEN 'serviced' THEN 'serviced'
    WHEN 'invoiced' THEN 'invoiced'
    WHEN 'cancelled' THEN 'cancelled'
    ELSE 'status_changed'
  END;

  PERFORM public.log_stock_request_event(
    NEW.id,
    v_event_type,
    OLD.status,
    NEW.status,
    '{}'::jsonb,
    auth.uid()
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stock_requests_log_status_change ON public.stock_requests;
CREATE TRIGGER stock_requests_log_status_change
  AFTER UPDATE ON public.stock_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.tr_stock_requests_log_status_change();

REVOKE ALL ON FUNCTION public.tr_stock_requests_log_created() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tr_stock_requests_log_created() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.tr_stock_requests_log_status_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tr_stock_requests_log_status_change() FROM anon, authenticated;

-- =============================================================================
-- 5. Extend serial RPCs (same transaction as mutation)
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

  SELECT * INTO line_rec FROM public.stock_request_lines WHERE id = p_line_id;
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

  SELECT * INTO inv_rec FROM public.inventory_items WHERE id = p_inventory_item_id;
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

  SELECT * INTO inv_rec FROM public.inventory_items WHERE id = p_inventory_item_id;
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

GRANT EXECUTE ON FUNCTION public.assign_serial_to_request_line(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_serial_from_request_line(text) TO authenticated;
