-- Auth, profiles, and role-based RLS.
-- Run after 013. Enables Supabase Auth + profiles; replaces anon full access with authenticated role-based policies.

-- =============================================================================
-- ROLE ENUM
-- =============================================================================
DO $$ BEGIN
  CREATE TYPE public.app_role AS ENUM ('admin', 'sales', 'accounts', 'technicians');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================================
-- PROFILES TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT,
  role public.app_role NOT NULL DEFAULT 'technicians',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.profiles IS 'App users and roles; one row per auth.users.';

-- =============================================================================
-- TRIGGER: create profile on signup
-- =============================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'email', NEW.email),
    NEW.raw_user_meta_data->>'display_name',
    COALESCE((NEW.raw_user_meta_data->>'role')::public.app_role, 'technicians')
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- =============================================================================
-- HELPER: get current user's role (for RLS)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS public.app_role
LANGUAGE sql
STABLE
SECURITY DEFINER SET search_path = public
AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid() AND active = true;
$$;

-- =============================================================================
-- RLS: PROFILES
-- =============================================================================
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Allow signup trigger to insert profile (trigger runs as definer; also allow user to insert own row for signup flow)
DROP POLICY IF EXISTS "Allow insert own profile" ON public.profiles;
CREATE POLICY "Allow insert own profile"
  ON public.profiles FOR INSERT
  TO authenticated
  WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS "Users can read own profile" ON public.profiles;
CREATE POLICY "Users can read own profile"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (id = auth.uid());

DROP POLICY IF EXISTS "Admins can read all profiles" ON public.profiles;
CREATE POLICY "Admins can read all profiles"
  ON public.profiles FOR SELECT
  TO authenticated
  USING ((SELECT public.get_my_role()) = 'admin');

DROP POLICY IF EXISTS "Admins can update any profile" ON public.profiles;
CREATE POLICY "Admins can update any profile"
  ON public.profiles FOR UPDATE
  TO authenticated
  USING ((SELECT public.get_my_role()) = 'admin')
  WITH CHECK ((SELECT public.get_my_role()) = 'admin');

-- =============================================================================
-- RLS: INVENTORY_ITEMS (drop anon, add role-based)
-- =============================================================================
DROP POLICY IF EXISTS "Allow anon all on inventory_items" ON public.inventory_items;

CREATE POLICY "Admin full access inventory_items"
  ON public.inventory_items FOR ALL
  TO authenticated
  USING ((SELECT public.get_my_role()) = 'admin')
  WITH CHECK ((SELECT public.get_my_role()) = 'admin');

CREATE POLICY "Non-admin read inventory_items"
  ON public.inventory_items FOR SELECT
  TO authenticated
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'));

-- =============================================================================
-- RLS: TRANSACTIONS
-- =============================================================================
DROP POLICY IF EXISTS "Allow anon all on transactions" ON public.transactions;

CREATE POLICY "Admin full access transactions"
  ON public.transactions FOR ALL
  TO authenticated
  USING ((SELECT public.get_my_role()) = 'admin')
  WITH CHECK ((SELECT public.get_my_role()) = 'admin');

CREATE POLICY "Non-admin read transactions"
  ON public.transactions FOR SELECT
  TO authenticated
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'));

-- =============================================================================
-- RLS: QUICK_SCANS
-- =============================================================================
DROP POLICY IF EXISTS "Allow anon all on quick_scans" ON public.quick_scans;

CREATE POLICY "Admin full access quick_scans"
  ON public.quick_scans FOR ALL
  TO authenticated
  USING ((SELECT public.get_my_role()) = 'admin')
  WITH CHECK ((SELECT public.get_my_role()) = 'admin');

CREATE POLICY "Non-admin read quick_scans"
  ON public.quick_scans FOR SELECT
  TO authenticated
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'));

-- =============================================================================
-- RLS: CLIENTS
-- =============================================================================
DROP POLICY IF EXISTS "Allow anon all on clients" ON public.clients;

CREATE POLICY "Admin full access clients"
  ON public.clients FOR ALL
  TO authenticated
  USING ((SELECT public.get_my_role()) = 'admin')
  WITH CHECK ((SELECT public.get_my_role()) = 'admin');

CREATE POLICY "Non-admin read clients"
  ON public.clients FOR SELECT
  TO authenticated
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'));

-- =============================================================================
-- RLS: STOCK_TAKES (optional table — migration 013)
-- =============================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'stock_takes'
  ) THEN
    DROP POLICY IF EXISTS "Allow anon all on stock_takes" ON public.stock_takes;
    CREATE POLICY "Admin full access stock_takes"
      ON public.stock_takes FOR ALL
      TO authenticated
      USING ((SELECT public.get_my_role()) = 'admin')
      WITH CHECK ((SELECT public.get_my_role()) = 'admin');
    CREATE POLICY "Non-admin read stock_takes"
      ON public.stock_takes FOR SELECT
      TO authenticated
      USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'));
  END IF;
END $$;

-- =============================================================================
-- RLS: OUTBOUND_BATCHES (optional table — migration 009)
-- =============================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'outbound_batches'
  ) THEN
    DROP POLICY IF EXISTS "Allow anon all on outbound_batches" ON public.outbound_batches;
    CREATE POLICY "Admin full access outbound_batches"
      ON public.outbound_batches FOR ALL
      TO authenticated
      USING ((SELECT public.get_my_role()) = 'admin')
      WITH CHECK ((SELECT public.get_my_role()) = 'admin');
    CREATE POLICY "Non-admin read outbound_batches"
      ON public.outbound_batches FOR SELECT
      TO authenticated
      USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'));
  END IF;
END $$;
