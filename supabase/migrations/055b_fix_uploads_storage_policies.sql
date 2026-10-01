-- Follow-up to applied migration 055.
-- Keep every uploads policy explicitly PERMISSIVE and ensure Storage's internal
-- database roles can execute the role helper used while serving private objects.

BEGIN;

DROP POLICY IF EXISTS "uploads insert quotations" ON storage.objects;
CREATE POLICY "uploads insert quotations"
  ON storage.objects
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'uploads'
    AND (storage.foldername(name))[1] = 'quotations'
    AND (SELECT public.get_my_role()) IN ('admin', 'sales', 'technicians')
  );

DROP POLICY IF EXISTS "uploads insert delivery notes" ON storage.objects;
CREATE POLICY "uploads insert delivery notes"
  ON storage.objects
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'uploads'
    AND (storage.foldername(name))[1] = 'delivery-notes'
    AND (SELECT public.get_my_role()) IN ('admin', 'technicians')
  );

DROP POLICY IF EXISTS "uploads insert invoices" ON storage.objects;
CREATE POLICY "uploads insert invoices"
  ON storage.objects
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'uploads'
    AND (storage.foldername(name))[1] = 'invoices'
    AND (SELECT public.get_my_role()) IN ('admin', 'accounts')
  );

DROP POLICY IF EXISTS "uploads select staff" ON storage.objects;
CREATE POLICY "uploads select staff"
  ON storage.objects
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'uploads'
    AND (storage.foldername(name))[1] IN (
      'quotations',
      'delivery-notes',
      'invoices'
    )
    AND (SELECT public.get_my_role()) IN (
      'admin',
      'sales',
      'accounts',
      'technicians'
    )
  );

COMMENT ON POLICY "uploads select staff" ON storage.objects IS
  'Private document reads for current staff roles. Add viewer here in the viewer-role migration.';

DROP POLICY IF EXISTS "uploads update admin" ON storage.objects;
CREATE POLICY "uploads update admin"
  ON storage.objects
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'uploads'
    AND (storage.foldername(name))[1] IN (
      'quotations',
      'delivery-notes',
      'invoices'
    )
    AND (SELECT public.get_my_role()) = 'admin'
  )
  WITH CHECK (
    bucket_id = 'uploads'
    AND (storage.foldername(name))[1] IN (
      'quotations',
      'delivery-notes',
      'invoices'
    )
    AND (SELECT public.get_my_role()) = 'admin'
  );

DROP POLICY IF EXISTS "uploads delete admin" ON storage.objects;
CREATE POLICY "uploads delete admin"
  ON storage.objects
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'uploads'
    AND (storage.foldername(name))[1] IN (
      'quotations',
      'delivery-notes',
      'invoices'
    )
    AND (SELECT public.get_my_role()) = 'admin'
  );

GRANT EXECUTE ON FUNCTION public.get_my_role() TO authenticator;
GRANT EXECUTE ON FUNCTION public.get_my_role() TO supabase_storage_admin;

COMMIT;
