-- Migration: Add movement_type to quick_scans (for Quick Scan panel movement type dropdown)
-- Run in Supabase: Dashboard → SQL Editor → New query → paste & Run
-- Safe to run multiple times (idempotent).

-- Add movement_type to quick_scans if the table exists but column is missing
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'quick_scans')
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'quick_scans' AND column_name = 'movement_type'
     ) THEN
    ALTER TABLE public.quick_scans ADD COLUMN movement_type TEXT;
  END IF;
END $$;
