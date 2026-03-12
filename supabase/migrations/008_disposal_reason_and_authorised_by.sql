-- Add disposal reason and authorisation to transactions (for Dispose)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'transactions' AND column_name = 'disposal_reason'
  ) THEN
    ALTER TABLE public.transactions ADD COLUMN disposal_reason TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'transactions' AND column_name = 'authorised_by'
  ) THEN
    ALTER TABLE public.transactions ADD COLUMN authorised_by TEXT;
  END IF;
END $$;

COMMENT ON COLUMN public.transactions.disposal_reason IS 'Reason for disposal (e.g. beyond repair, lost, end of life).';
COMMENT ON COLUMN public.transactions.authorised_by IS 'Name or ID of person who authorised the disposal.';
