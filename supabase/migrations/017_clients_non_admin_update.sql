-- Let all authenticated app roles update client directory rows (not only admin).
-- Admin already has full access via migration 014; this adds UPDATE for sales, accounts, technicians.

CREATE POLICY "Non-admin update clients"
  ON public.clients FOR UPDATE
  TO authenticated
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'))
  WITH CHECK ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'));
