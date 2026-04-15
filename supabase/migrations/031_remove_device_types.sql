-- Remove device_types catalogue and device_type / device_type_id from inventory;
-- stock_request_lines no longer stores a parallel hardware-kind field.

-- 1) FK and index on inventory_items
ALTER TABLE public.inventory_items DROP CONSTRAINT IF EXISTS inventory_items_device_type_id_fkey;

DROP INDEX IF EXISTS public.idx_inventory_items_device_type_id;

-- 2) Inventory columns
ALTER TABLE public.inventory_items
  DROP COLUMN IF EXISTS device_type_id,
  DROP COLUMN IF EXISTS device_type;

-- 3) Stock request lines (029 renamed item_type → device_type; handle legacy name)
ALTER TABLE public.stock_request_lines DROP COLUMN IF EXISTS device_type;
ALTER TABLE public.stock_request_lines DROP COLUMN IF EXISTS item_type;

-- 4) device_types table: trigger, policies, table
DROP TRIGGER IF EXISTS trg_device_types_updated_at ON public.device_types;

DROP POLICY IF EXISTS "Admin full access product_types" ON public.device_types;
DROP POLICY IF EXISTS "Non-admin read product_types" ON public.device_types;

DROP TABLE IF EXISTS public.device_types;
