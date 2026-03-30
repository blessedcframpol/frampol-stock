-- Product type governance + General fallback grouping.
-- Adds canonical product_types table, links inventory_items to it, and backfills safely.

CREATE TABLE IF NOT EXISTS public.product_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT product_types_name_not_blank CHECK (btrim(name) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_types_name_ci
  ON public.product_types (lower(name));

-- Keep updated_at current.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_product_types_updated_at ON public.product_types;
CREATE TRIGGER trg_product_types_updated_at
BEFORE UPDATE ON public.product_types
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- Add FK column on inventory items.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'inventory_items'
      AND column_name = 'product_type_id'
  ) THEN
    ALTER TABLE public.inventory_items ADD COLUMN product_type_id TEXT;
  END IF;
END $$;

-- Seed product types from existing inventory item_type values.
INSERT INTO public.product_types (id, name, active)
SELECT
  'ptype-' || substr(md5(normalized_name), 1, 16) AS id,
  display_name AS name,
  true
FROM (
  SELECT
    lower(btrim(item_type)) AS normalized_name,
    min(btrim(item_type)) AS display_name
  FROM public.inventory_items
  WHERE item_type IS NOT NULL
    AND btrim(item_type) <> ''
  GROUP BY lower(btrim(item_type))
) seeded
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name;

-- Ensure General exists.
INSERT INTO public.product_types (id, name, active)
VALUES ('ptype-general', 'General', true)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name, active = true;

-- Backfill product_type_id from item_type (case-insensitive), fallback to General.
UPDATE public.inventory_items i
SET product_type_id = COALESCE(
  (
    SELECT pt.id
    FROM public.product_types pt
    WHERE lower(pt.name) = lower(btrim(i.item_type))
    ORDER BY pt.created_at ASC
    LIMIT 1
  ),
  'ptype-general'
)
WHERE i.product_type_id IS NULL;

-- Normalize category to General where missing.
UPDATE public.inventory_items
SET category = 'General'
WHERE category IS NULL OR btrim(category) = '';

-- Keep legacy item_type non-empty for compatibility.
UPDATE public.inventory_items i
SET item_type = COALESCE(
  (
    SELECT pt.name
    FROM public.product_types pt
    WHERE pt.id = i.product_type_id
    LIMIT 1
  ),
  'General'
)
WHERE i.item_type IS NULL OR btrim(i.item_type) = '';

-- Enforce referential integrity.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'inventory_items_product_type_id_fkey'
  ) THEN
    ALTER TABLE public.inventory_items
      ADD CONSTRAINT inventory_items_product_type_id_fkey
      FOREIGN KEY (product_type_id)
      REFERENCES public.product_types(id)
      ON UPDATE CASCADE
      ON DELETE RESTRICT;
  END IF;
END $$;

ALTER TABLE public.inventory_items
  ALTER COLUMN product_type_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_items_product_type_id
  ON public.inventory_items(product_type_id);

ALTER TABLE public.product_types ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin full access product_types" ON public.product_types;
CREATE POLICY "Admin full access product_types"
  ON public.product_types FOR ALL
  TO authenticated
  USING ((SELECT public.get_my_role()) = 'admin')
  WITH CHECK ((SELECT public.get_my_role()) = 'admin');

DROP POLICY IF EXISTS "Non-admin read product_types" ON public.product_types;
CREATE POLICY "Non-admin read product_types"
  ON public.product_types FOR SELECT
  TO authenticated
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'));
