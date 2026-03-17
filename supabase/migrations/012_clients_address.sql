-- Add company address to clients
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'clients' AND column_name = 'address'
  ) THEN
    ALTER TABLE public.clients ADD COLUMN address TEXT;
  END IF;
END $$;

COMMENT ON COLUMN public.clients.address IS 'Company or primary business address.';
