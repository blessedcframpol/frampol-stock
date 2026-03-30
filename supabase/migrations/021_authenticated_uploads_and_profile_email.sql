-- 1) Storage: allow authenticated users to use the `uploads` bucket.
--    Migration 010 only granted anon; browser clients with a session use role `authenticated`,
--    so uploads (delivery notes, quotations, invoices) could fail or behave inconsistently.
-- 2) Profiles: ensure handle_new_user never inserts NULL email (NOT NULL column).
--    OAuth edge cases can leave both NEW.email and metadata email empty; that aborts the
--    auth.users insert and Supabase Auth often returns HTTP 500 + error_code "unexpected_failure".

DROP POLICY IF EXISTS "Authenticated insert uploads" ON storage.objects;
CREATE POLICY "Authenticated insert uploads"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'uploads');

DROP POLICY IF EXISTS "Authenticated read uploads" ON storage.objects;
CREATE POLICY "Authenticated read uploads"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'uploads');

-- Optional: allow users to remove/replace their own objects under requests/ or txn paths if needed later.
-- For now INSERT + SELECT matches typical quotation / delivery note flows (public URLs).

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  meta jsonb := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb);
  dn text;
  user_email text;
BEGIN
  user_email := COALESCE(
    NULLIF(trim(NEW.email), ''),
    NULLIF(trim(meta->>'email'), ''),
    NULLIF(trim(meta->>'preferred_username'), ''),
    NULLIF(trim(meta #>> '{identities,0,identity_data,email}'), '')
  );

  IF user_email IS NULL OR user_email = '' THEN
    user_email := NEW.id::text || '@oauth.placeholder.local';
  END IF;

  dn := COALESCE(
    NULLIF(trim(meta->>'display_name'), ''),
    NULLIF(trim(meta->>'full_name'), ''),
    NULLIF(trim(meta->>'name'), ''),
    NULLIF(trim(meta->>'given_name'), '') || CASE
      WHEN NULLIF(trim(meta->>'family_name'), '') IS NOT NULL
      THEN ' ' || trim(meta->>'family_name')
      ELSE ''
    END
  );

  INSERT INTO public.profiles (id, email, display_name, role)
  VALUES (
    NEW.id,
    user_email,
    NULLIF(trim(dn), ''),
    NULL
  );
  RETURN NEW;
END;
$$;
