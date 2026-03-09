-- Add batch_id to quick_scans so scan history can show one entry per submission (bulk or single).
-- Run this if your quick_scans table was created without batch_id.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'quick_scans' AND column_name = 'batch_id'
  ) THEN
    ALTER TABLE public.quick_scans ADD COLUMN batch_id TEXT;
  END IF;
END $$;
