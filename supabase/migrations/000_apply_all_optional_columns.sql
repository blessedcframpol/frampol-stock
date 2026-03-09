-- Fram-Stock – Apply all optional DB column changes (for existing databases)
-- Run in Supabase: Dashboard → SQL Editor → New query → paste & Run
-- Safe to run multiple times (idempotent). Use this if your DB was created from an older schema.

-- 1. inventory_items.category (for category-based inventory view)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'inventory_items')
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'inventory_items' AND column_name = 'category'
     ) THEN
    ALTER TABLE public.inventory_items ADD COLUMN category TEXT;
  END IF;
END $$;

-- 2. quick_scans.movement_type (for Quick Scan movement type dropdown)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'quick_scans')
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'quick_scans' AND column_name = 'movement_type'
     ) THEN
    ALTER TABLE public.quick_scans ADD COLUMN movement_type TEXT;
  END IF;
END $$;
