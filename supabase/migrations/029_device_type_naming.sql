-- Standardise naming: item_type → device_type, product_types → device_types,
-- product_type_id → device_type_id, stock_request_lines.item_type → device_type.
-- Primary key values (e.g. ptype-general) unchanged.

-- 1) Drop FK from inventory to product_types / device_types
ALTER TABLE public.inventory_items DROP CONSTRAINT IF EXISTS inventory_items_product_type_id_fkey;

-- 2) Rename lookup table
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'product_types'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'device_types'
  ) THEN
    ALTER TABLE public.product_types RENAME TO device_types;
  END IF;
END $$;

-- 3) Rename constraints and index on device_types (names stay product_* until renamed)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_types_pkey') THEN
    ALTER TABLE public.device_types RENAME CONSTRAINT product_types_pkey TO device_types_pkey;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_types_name_not_blank') THEN
    ALTER TABLE public.device_types RENAME CONSTRAINT product_types_name_not_blank TO device_types_name_not_blank;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'i' AND c.relname = 'idx_product_types_name_ci'
  ) THEN
    ALTER INDEX public.idx_product_types_name_ci RENAME TO idx_device_types_name_ci;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_product_types_updated_at ON public.device_types;
CREATE TRIGGER trg_device_types_updated_at
BEFORE UPDATE ON public.device_types
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- 4) Rename inventory columns
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'inventory_items' AND column_name = 'product_type_id'
  ) THEN
    ALTER TABLE public.inventory_items RENAME COLUMN product_type_id TO device_type_id;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'inventory_items' AND column_name = 'item_type'
  ) THEN
    ALTER TABLE public.inventory_items RENAME COLUMN item_type TO device_type;
  END IF;
END $$;

-- 5) Recreate FK
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_items_device_type_id_fkey'
  ) THEN
    ALTER TABLE public.inventory_items
      ADD CONSTRAINT inventory_items_device_type_id_fkey
      FOREIGN KEY (device_type_id)
      REFERENCES public.device_types(id)
      ON UPDATE CASCADE
      ON DELETE RESTRICT;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'i' AND c.relname = 'idx_inventory_items_product_type_id'
  ) THEN
    ALTER INDEX public.idx_inventory_items_product_type_id RENAME TO idx_inventory_items_device_type_id;
  END IF;
END $$;

-- 6) Stock request lines
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'stock_request_lines' AND column_name = 'item_type'
  ) THEN
    ALTER TABLE public.stock_request_lines RENAME COLUMN item_type TO device_type;
  END IF;
END $$;

-- 7) Documentation
COMMENT ON TABLE public.device_types IS 'Catalogue of device types (e.g. Starlink Kit, Router); links via inventory_items.device_type_id.';
COMMENT ON COLUMN public.inventory_items.name IS 'Product name / SKU line; groups serials of the same product.';
COMMENT ON COLUMN public.inventory_items.device_type IS 'Hardware kind label; denormalised from device_types.name.';
COMMENT ON COLUMN public.inventory_items.device_type_id IS 'FK to device_types.id.';
COMMENT ON COLUMN public.stock_request_lines.device_type IS 'Optional device type for the line (matches inventory device_type).';
