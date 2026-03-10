-- Add return_date for rental alerts (kit due back date)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'inventory_items' AND column_name = 'return_date'
  ) THEN
    ALTER TABLE public.inventory_items ADD COLUMN return_date TEXT;
  END IF;
END $$;

COMMENT ON COLUMN public.inventory_items.return_date IS 'When the item is due to be returned (for rentals); used for overdue alerts.';
