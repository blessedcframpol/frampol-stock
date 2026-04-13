-- Rename inventory_items.category → vendor (aligns with app vocabulary).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'inventory_items' AND column_name = 'category'
  ) THEN
    ALTER TABLE public.inventory_items RENAME COLUMN category TO vendor;
  END IF;
END $$;

COMMENT ON COLUMN public.inventory_items.vendor IS 'Vendor or product line for grouping (e.g. Starlink, Fortinet); empty stored as General in app.';
