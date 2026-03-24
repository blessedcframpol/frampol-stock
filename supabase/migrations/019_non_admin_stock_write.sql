-- After 014, sales/accounts/technicians could only read inventory and transactions.
-- Stock movements, quick scans, and new clients require INSERT/UPDATE/DELETE — without these policies,
-- the UI updated local state but Supabase persist failed silently (RLS).

-- New clients from sales / quick scan (017 added UPDATE only)
DROP POLICY IF EXISTS "Non-admin insert clients" ON public.clients;
CREATE POLICY "Non-admin insert clients"
  ON public.clients FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'));

-- Receive stock and apply movement updates
DROP POLICY IF EXISTS "Non-admin insert inventory_items" ON public.inventory_items;
CREATE POLICY "Non-admin insert inventory_items"
  ON public.inventory_items FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'));

DROP POLICY IF EXISTS "Non-admin update inventory_items" ON public.inventory_items;
CREATE POLICY "Non-admin update inventory_items"
  ON public.inventory_items FOR UPDATE
  TO authenticated
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'))
  WITH CHECK ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'));

-- Movement log + undo + reassign (item_name)
DROP POLICY IF EXISTS "Non-admin insert transactions" ON public.transactions;
CREATE POLICY "Non-admin insert transactions"
  ON public.transactions FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'));

DROP POLICY IF EXISTS "Non-admin update transactions" ON public.transactions;
CREATE POLICY "Non-admin update transactions"
  ON public.transactions FOR UPDATE
  TO authenticated
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'))
  WITH CHECK ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'));

DROP POLICY IF EXISTS "Non-admin delete transactions" ON public.transactions;
CREATE POLICY "Non-admin delete transactions"
  ON public.transactions FOR DELETE
  TO authenticated
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'));

-- Scan log + undo batch
DROP POLICY IF EXISTS "Non-admin insert quick_scans" ON public.quick_scans;
CREATE POLICY "Non-admin insert quick_scans"
  ON public.quick_scans FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'));

DROP POLICY IF EXISTS "Non-admin delete quick_scans" ON public.quick_scans;
CREATE POLICY "Non-admin delete quick_scans"
  ON public.quick_scans FOR DELETE
  TO authenticated
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'));

-- POC Out / Rentals batch header
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'outbound_batches'
  ) THEN
    DROP POLICY IF EXISTS "Non-admin insert outbound_batches" ON public.outbound_batches;
    CREATE POLICY "Non-admin insert outbound_batches"
      ON public.outbound_batches FOR INSERT
      TO authenticated
      WITH CHECK ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'));
  END IF;
END $$;
