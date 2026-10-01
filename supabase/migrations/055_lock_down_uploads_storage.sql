-- Make uploaded business documents private and enforce role/prefix access.

BEGIN;

UPDATE storage.buckets
SET public = false,
    file_size_limit = 10485760,
    allowed_mime_types = ARRAY[
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp'
    ]::text[]
WHERE id = 'uploads';

COMMENT ON COLUMN public.stock_requests.quotation_url IS
  'Private uploads bucket object path for the quotation; resolve with a short-lived signed URL.';
COMMENT ON COLUMN public.stock_requests.invoice_document_url IS
  'Private uploads bucket object path for the invoice document; resolve with a short-lived signed URL.';
COMMENT ON COLUMN public.transactions.delivery_note_url IS
  'Private uploads bucket object path for the delivery note; resolve with a short-lived signed URL.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'uploads') THEN
    RAISE EXCEPTION '055_lock_down_uploads_storage: uploads bucket does not exist';
  END IF;
END;
$$;

DROP POLICY IF EXISTS "Allow anon upload" ON storage.objects;
DROP POLICY IF EXISTS "Allow anon read uploads" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated insert uploads" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated read uploads" ON storage.objects;

DROP POLICY IF EXISTS "uploads insert quotations" ON storage.objects;
CREATE POLICY "uploads insert quotations"
  ON storage.objects
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

COMMIT;
