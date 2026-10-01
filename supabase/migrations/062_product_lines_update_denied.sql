-- A non-admin UPDATE on product_lines matches no UPDATE policy, so Postgres
-- reports success and changes zero rows. This permissive UPDATE policy makes
-- the row visible to roles that can already SELECT it, then rejects the new
-- row unless the caller is admin. The rejection is SQLSTATE 42501.
-- Admin writes still pass "Admin full access product_lines": permissive
-- policies are combined with OR.

CREATE POLICY "Non-admin product_lines update denied"
  ON public.product_lines
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians', 'viewer')
  )
  WITH CHECK ((SELECT public.get_my_role()) = 'admin');
