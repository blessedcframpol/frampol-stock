-- Stock requests: sales → technicians assign serials → accounts invoice; notifications on serviced.

-- =============================================================================
-- TABLES
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.stock_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id TEXT NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'in_progress', 'serviced', 'invoiced', 'cancelled')),
  quotation_url TEXT,
  notes TEXT,
  serviced_at TIMESTAMPTZ,
  invoice_number TEXT,
  invoice_document_url TEXT,
  invoiced_at TIMESTAMPTZ,
  invoiced_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.stock_requests IS 'Sales-driven stock requests with quotation; fulfilled by technicians; invoiced by accounts.';

CREATE TABLE IF NOT EXISTS public.stock_request_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES public.stock_requests(id) ON DELETE CASCADE,
  product_name TEXT NOT NULL,
  item_type TEXT,
  quantity_requested INTEGER NOT NULL CHECK (quantity_requested > 0),
  sort_order INTEGER NOT NULL DEFAULT 0
);

COMMENT ON TABLE public.stock_request_lines IS 'Line items: product_name matches inventory_items.name for availability and assignment.';

CREATE INDEX IF NOT EXISTS idx_stock_request_lines_request_id ON public.stock_request_lines(request_id);
CREATE INDEX IF NOT EXISTS idx_stock_requests_client_id ON public.stock_requests(client_id);
CREATE INDEX IF NOT EXISTS idx_stock_requests_created_by ON public.stock_requests(created_by);
CREATE INDEX IF NOT EXISTS idx_stock_requests_status ON public.stock_requests(status);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'inventory_items' AND column_name = 'reserved_for_request_line_id'
  ) THEN
    ALTER TABLE public.inventory_items
      ADD COLUMN reserved_for_request_line_id UUID REFERENCES public.stock_request_lines(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON COLUMN public.inventory_items.reserved_for_request_line_id IS 'When set, unit is allocated to a request line (excluded from free availability).';

CREATE INDEX IF NOT EXISTS idx_inventory_reserved_line ON public.inventory_items(reserved_for_request_line_id)
  WHERE reserved_for_request_line_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  read_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON public.notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON public.notifications(user_id) WHERE read_at IS NULL;

-- =============================================================================
-- TRIGGERS
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
  IF NEW.status = 'cancelled' AND (TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status) THEN
    UPDATE public.inventory_items SET reserved_for_request_line_id = NULL
    WHERE reserved_for_request_line_id IN (
      SELECT id FROM public.stock_request_lines WHERE request_id = NEW.id
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stock_requests_updated ON public.stock_requests;
CREATE TRIGGER stock_requests_updated
  BEFORE UPDATE ON public.stock_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.tr_stock_requests_updated_at_and_side_effects();

-- =============================================================================
-- RPC: assign / release serial (technicians + admin)
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

  IF btrim(inv_rec.name) IS DISTINCT FROM btrim(line_rec.product_name) THEN
    RAISE EXCEPTION 'Product name does not match this line (expected %, got %)', line_rec.product_name, inv_rec.name;
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

  SELECT r.* INTO req_rec
  FROM public.stock_requests r
  JOIN public.stock_request_lines l ON l.request_id = r.id
  WHERE l.id = inv_rec.reserved_for_request_line_id;

  IF req_rec.status NOT IN ('submitted', 'in_progress') THEN
    RAISE EXCEPTION 'Cannot release: request is not open for fulfillment';
  END IF;

  UPDATE public.inventory_items
  SET reserved_for_request_line_id = NULL
  WHERE id = p_inventory_item_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.assign_serial_to_request_line(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_serial_from_request_line(text) TO authenticated;

-- In-app notification for sales (bypasses RLS on notifications for INSERT)
CREATE OR REPLACE FUNCTION public.create_request_serviced_notification(p_request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
BEGIN
  IF (SELECT public.get_my_role()) NOT IN ('admin', 'technicians') THEN
    RAISE EXCEPTION 'create_request_serviced_notification: forbidden';
  END IF;

  SELECT id, created_by, status INTO r FROM public.stock_requests WHERE id = p_request_id;
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

GRANT EXECUTE ON FUNCTION public.create_request_serviced_notification(uuid) TO authenticated;

-- =============================================================================
-- RLS
-- =============================================================================

ALTER TABLE public.stock_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_request_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "stock_requests admin all" ON public.stock_requests;
CREATE POLICY "stock_requests admin all"
  ON public.stock_requests FOR ALL TO authenticated
  USING ((SELECT public.get_my_role()) = 'admin')
  WITH CHECK ((SELECT public.get_my_role()) = 'admin');

DROP POLICY IF EXISTS "stock_requests select staff" ON public.stock_requests;
CREATE POLICY "stock_requests select staff"
  ON public.stock_requests FOR SELECT TO authenticated
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'));

DROP POLICY IF EXISTS "stock_requests insert sales tech" ON public.stock_requests;
CREATE POLICY "stock_requests insert sales tech"
  ON public.stock_requests FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT public.get_my_role()) IN ('admin', 'sales', 'technicians')
    AND created_by = auth.uid()
  );

DROP POLICY IF EXISTS "stock_requests update owner draft" ON public.stock_requests;
CREATE POLICY "stock_requests update owner draft"
  ON public.stock_requests FOR UPDATE TO authenticated
  USING (
    (SELECT public.get_my_role()) = 'sales'
    AND created_by = auth.uid()
    AND status IN ('draft', 'submitted')
  )
  WITH CHECK (
    created_by = auth.uid()
    AND status IN ('draft', 'submitted', 'cancelled')
  );

DROP POLICY IF EXISTS "stock_requests update tech fulfillment" ON public.stock_requests;
CREATE POLICY "stock_requests update tech fulfillment"
  ON public.stock_requests FOR UPDATE TO authenticated
  USING ((SELECT public.get_my_role()) IN ('admin', 'technicians'))
  WITH CHECK ((SELECT public.get_my_role()) IN ('admin', 'technicians'));

DROP POLICY IF EXISTS "stock_requests update accounts invoice" ON public.stock_requests;
CREATE POLICY "stock_requests update accounts invoice"
  ON public.stock_requests FOR UPDATE TO authenticated
  USING (
    (SELECT public.get_my_role()) IN ('admin', 'accounts')
    AND status = 'serviced'
  )
  WITH CHECK (
    (SELECT public.get_my_role()) IN ('admin', 'accounts')
    AND status = 'invoiced'
  );

DROP POLICY IF EXISTS "stock_request_lines admin all" ON public.stock_request_lines;
CREATE POLICY "stock_request_lines admin all"
  ON public.stock_request_lines FOR ALL TO authenticated
  USING ((SELECT public.get_my_role()) = 'admin')
  WITH CHECK ((SELECT public.get_my_role()) = 'admin');

DROP POLICY IF EXISTS "stock_request_lines select staff" ON public.stock_request_lines;
CREATE POLICY "stock_request_lines select staff"
  ON public.stock_request_lines FOR SELECT TO authenticated
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians', 'admin'));

DROP POLICY IF EXISTS "stock_request_lines modify owner draft" ON public.stock_request_lines;
CREATE POLICY "stock_request_lines modify owner draft"
  ON public.stock_request_lines FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.stock_requests r
      WHERE r.id = request_id
        AND r.created_by = auth.uid()
        AND r.status = 'draft'
        AND (SELECT public.get_my_role()) IN ('sales', 'technicians')
    )
  );

DROP POLICY IF EXISTS "stock_request_lines update owner draft" ON public.stock_request_lines;
CREATE POLICY "stock_request_lines update owner draft"
  ON public.stock_request_lines FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.stock_requests r
      WHERE r.id = stock_request_lines.request_id
        AND r.created_by = auth.uid()
        AND r.status = 'draft'
    )
  );

DROP POLICY IF EXISTS "stock_request_lines delete owner draft" ON public.stock_request_lines;
CREATE POLICY "stock_request_lines delete owner draft"
  ON public.stock_request_lines FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.stock_requests r
      WHERE r.id = stock_request_lines.request_id
        AND r.created_by = auth.uid()
        AND r.status = 'draft'
    )
  );

-- notifications
DROP POLICY IF EXISTS "notifications select own" ON public.notifications;
CREATE POLICY "notifications select own"
  ON public.notifications FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "notifications update own" ON public.notifications;
CREATE POLICY "notifications update own"
  ON public.notifications FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Insert only via trigger (SECURITY DEFINER) — no direct insert policy for users

