-- Product lines catalog: one row per product name (globally unique normalized name, one vendor).
-- inventory_items references product_lines via product_id; name/vendor columns removed from inventory_items.

-- -----------------------------------------------------------------------------
-- 0) Multiple vendors per product name: log only (migration continues)
-- -----------------------------------------------------------------------------
-- One product_lines row per lower(trim(name)). Canonical vendor prefers any non-General
-- vendor present; inventory links by name only so all serials get the same product_id.
-- Users can still run scripts/audit-product-name-vendor-conflicts.sql and clean up later.
DO $$
DECLARE
  conflict_count int;
BEGIN
  SELECT count(*)::int INTO conflict_count
  FROM (
    SELECT lower(trim(name)) AS k
    FROM public.inventory_items
    GROUP BY lower(trim(name))
    HAVING count(DISTINCT coalesce(nullif(trim(vendor), ''), 'General')) > 1
  ) t;

  IF conflict_count > 0 THEN
    RAISE NOTICE
      '032_product_lines_catalog: % product name(s) had multiple vendors; picking one canonical vendor per name (prefer non-General). Optional cleanup: audit-product-name-vendor-conflicts.sql',
      conflict_count;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 1) product_lines
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.product_lines (
  id TEXT PRIMARY KEY,
  product_name TEXT NOT NULL,
  vendor TEXT NOT NULL DEFAULT 'General',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.product_lines IS 'Canonical product catalog: one row per product name; vendor is the single supplier line for that name.';
COMMENT ON COLUMN public.product_lines.product_name IS 'Display/canon product name (matches stock_request_lines.product_name for assignment).';
COMMENT ON COLUMN public.product_lines.vendor IS 'Normalized vendor; empty inventory vendor was treated as General in app. When pre-migrate rows mixed General with another vendor for the same name, backfill prefers the non-General vendor.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_lines_product_name_lower
  ON public.product_lines ((lower(trim(product_name))));

CREATE INDEX IF NOT EXISTS idx_product_lines_vendor ON public.product_lines (vendor);

-- -----------------------------------------------------------------------------
-- 2) Backfill from inventory (distinct logical product per lower(trim(name)))
-- -----------------------------------------------------------------------------
INSERT INTO public.product_lines (id, product_name, vendor)
SELECT
  'PL-' || md5(sub.k || '|' || sub.v_norm),
  sub.canonical_name,
  sub.v_norm
FROM (
  SELECT
    lower(trim(name)) AS k,
    coalesce(
      max(coalesce(nullif(trim(vendor), ''), 'General'))
        FILTER (WHERE coalesce(nullif(trim(vendor), ''), 'General') <> 'General'),
      max(coalesce(nullif(trim(vendor), ''), 'General'))
    ) AS v_norm,
    min(trim(name)) AS canonical_name
  FROM public.inventory_items
  GROUP BY lower(trim(name))
) sub
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3) inventory_items.product_id
-- -----------------------------------------------------------------------------
ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS product_id TEXT;

UPDATE public.inventory_items i
SET product_id = pl.id
FROM public.product_lines pl
WHERE lower(trim(i.name)) = lower(trim(pl.product_name));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.inventory_items WHERE product_id IS NULL) THEN
    RAISE EXCEPTION '032_product_lines_catalog: some inventory_items could not be linked to product_lines';
  END IF;
END $$;

ALTER TABLE public.inventory_items
  ALTER COLUMN product_id SET NOT NULL;

ALTER TABLE public.inventory_items
  ADD CONSTRAINT inventory_items_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES public.product_lines (id)
  ON UPDATE CASCADE ON DELETE RESTRICT;

DROP INDEX IF EXISTS public.idx_inventory_items_name;

ALTER TABLE public.inventory_items DROP COLUMN IF EXISTS name;
ALTER TABLE public.inventory_items DROP COLUMN IF EXISTS vendor;

CREATE INDEX IF NOT EXISTS idx_inventory_items_product_id ON public.inventory_items (product_id);

-- -----------------------------------------------------------------------------
-- 4) RLS (mirror inventory_items role pattern)
-- -----------------------------------------------------------------------------
ALTER TABLE public.product_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin full access product_lines" ON public.product_lines;
CREATE POLICY "Admin full access product_lines"
  ON public.product_lines FOR ALL
  TO authenticated
  USING ((SELECT public.get_my_role()) = 'admin')
  WITH CHECK ((SELECT public.get_my_role()) = 'admin');

DROP POLICY IF EXISTS "Non-admin read product_lines" ON public.product_lines;
CREATE POLICY "Non-admin read product_lines"
  ON public.product_lines FOR SELECT
  TO authenticated
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'));

-- -----------------------------------------------------------------------------
-- 5) ensure_product_line (SECURITY DEFINER: create or return existing)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ensure_product_line(p_product_name text, p_vendor text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key text := lower(trim(p_product_name));
  v_norm_vendor text := coalesce(nullif(trim(p_vendor), ''), 'General');
  v_id text;
  v_existing_vendor text;
BEGIN
  IF v_key = '' THEN
    RAISE EXCEPTION 'ensure_product_line: product name is required';
  END IF;

  SELECT pl.id, pl.vendor
  INTO v_id, v_existing_vendor
  FROM public.product_lines pl
  WHERE lower(trim(pl.product_name)) = v_key
  LIMIT 1;

  IF v_id IS NOT NULL THEN
    IF v_existing_vendor IS DISTINCT FROM v_norm_vendor THEN
      RAISE EXCEPTION 'ensure_product_line: product "%" already exists under vendor "%" (cannot use vendor "%")',
        trim(p_product_name), v_existing_vendor, v_norm_vendor;
    END IF;
    RETURN v_id;
  END IF;

  BEGIN
    v_id := 'PL-' || replace(gen_random_uuid()::text, '-', '');
    INSERT INTO public.product_lines (id, product_name, vendor)
    VALUES (v_id, trim(p_product_name), v_norm_vendor);
    RETURN v_id;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT pl.id, pl.vendor INTO v_id, v_existing_vendor
      FROM public.product_lines pl
      WHERE lower(trim(pl.product_name)) = v_key
      LIMIT 1;
      IF v_id IS NULL THEN
        RAISE;
      END IF;
      IF v_existing_vendor IS DISTINCT FROM v_norm_vendor THEN
        RAISE EXCEPTION 'ensure_product_line: product "%" already exists under vendor "%" (cannot use vendor "%")',
          trim(p_product_name), v_existing_vendor, v_norm_vendor;
      END IF;
      RETURN v_id;
  END;
END;
$$;

COMMENT ON FUNCTION public.ensure_product_line(text, text) IS 'Returns product_lines.id; inserts row if new. Enforces single vendor per normalized product name.';

GRANT EXECUTE ON FUNCTION public.ensure_product_line(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_product_line(text, text) TO service_role;

-- -----------------------------------------------------------------------------
-- 6) assign_serial_to_request_line: match line product_name to catalog via inventory FK
-- -----------------------------------------------------------------------------
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
END;
$$;

COMMENT ON TABLE public.stock_request_lines IS 'Line items: product_name matches product_lines.product_name for the inventory item''s product_id.';
