-- Add delivery note URL to transactions (for Inbound: link to uploaded delivery note file)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'transactions' AND column_name = 'delivery_note_url'
  ) THEN
    ALTER TABLE public.transactions ADD COLUMN delivery_note_url TEXT;
  END IF;
END $$;

COMMENT ON COLUMN public.transactions.delivery_note_url IS 'Public URL of uploaded delivery note (e.g. PDF) for Inbound transactions.';

-- Storage: create uploads bucket and policies (bucket must exist for uploads).
-- Create the bucket in Dashboard: Storage → New bucket → id: uploads, Public: on.
-- Then run the policy statements below, or use Dashboard Storage policies for bucket 'uploads'.
DROP POLICY IF EXISTS "Allow anon upload" ON storage.objects;
CREATE POLICY "Allow anon upload"
  ON storage.objects FOR INSERT TO anon
  WITH CHECK (bucket_id = 'uploads');

DROP POLICY IF EXISTS "Allow anon read uploads" ON storage.objects;
CREATE POLICY "Allow anon read uploads"
  ON storage.objects FOR SELECT TO anon
  USING (bucket_id = 'uploads');
