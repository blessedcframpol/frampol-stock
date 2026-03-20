-- Map common OAuth claims (Azure / Microsoft) into display_name when creating profiles.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  meta jsonb := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb);
  dn text;
BEGIN
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
    COALESCE(NEW.raw_user_meta_data->>'email', NEW.email),
    NULLIF(trim(dn), ''),
    COALESCE((NEW.raw_user_meta_data->>'role')::public.app_role, 'technicians')
  );
  RETURN NEW;
END;
$$;
