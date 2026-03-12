-- Add 'Rented' to inventory_items status (Rentals use their own status, not POC)
ALTER TABLE public.inventory_items DROP CONSTRAINT IF EXISTS inventory_items_status_check;
ALTER TABLE public.inventory_items ADD CONSTRAINT inventory_items_status_check
  CHECK (status IN ('In Stock', 'Sold', 'POC', 'Rented', 'Maintenance', 'Disposed'));

-- Add client_id to transactions (reference to clients.id for Sale/POC/Rentals)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'transactions' AND column_name = 'client_id'
  ) THEN
    ALTER TABLE public.transactions ADD COLUMN client_id TEXT;
  END IF;
END $$;

COMMENT ON COLUMN public.transactions.client_id IS 'Reference to clients.id when client was selected from directory.';

-- Allow 'Rental Return' as a transaction type
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_type_check
  CHECK (type IN ('Inbound', 'Sale', 'POC Out', 'POC Return', 'Rental Return', 'Transfer', 'Dispose', 'Rentals'));
