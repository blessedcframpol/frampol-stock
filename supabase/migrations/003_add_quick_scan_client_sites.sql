-- Add client and site columns to quick_scans for sale/outbound-type scans (Sale, POC Out, Rentals, Transfer, Dispose).

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'quick_scans' AND column_name = 'client_id') THEN
    ALTER TABLE public.quick_scans ADD COLUMN client_id TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'quick_scans' AND column_name = 'client_name') THEN
    ALTER TABLE public.quick_scans ADD COLUMN client_name TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'quick_scans' AND column_name = 'client_company') THEN
    ALTER TABLE public.quick_scans ADD COLUMN client_company TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'quick_scans' AND column_name = 'client_email') THEN
    ALTER TABLE public.quick_scans ADD COLUMN client_email TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'quick_scans' AND column_name = 'client_phone') THEN
    ALTER TABLE public.quick_scans ADD COLUMN client_phone TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'quick_scans' AND column_name = 'sites') THEN
    ALTER TABLE public.quick_scans ADD COLUMN sites JSONB;
  END IF;
END $$;
