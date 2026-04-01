-- After running scripts/migrate-quick-scans.ts (service role) to backfill inventory_items + transactions.
-- Drops quick_scans; batch reversals live in batch_reversals (025).

DROP POLICY IF EXISTS "Admin full access quick_scans" ON public.quick_scans;
DROP POLICY IF EXISTS "Non-admin read quick_scans" ON public.quick_scans;
DROP POLICY IF EXISTS "Non-admin insert quick_scans" ON public.quick_scans;
DROP POLICY IF EXISTS "Non-admin delete quick_scans" ON public.quick_scans;

DROP TABLE IF EXISTS public.quick_scans;
