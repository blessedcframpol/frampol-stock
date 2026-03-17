-- Clients table (for dropdowns and CRM-style use). Safe for migrations-only setups.
CREATE TABLE IF NOT EXISTS public.clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  company TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  total_orders INTEGER NOT NULL DEFAULT 0,
  total_spent NUMERIC(12, 2) NOT NULL DEFAULT 0,
  last_order TEXT
);

COMMENT ON TABLE public.clients IS 'Customers / companies for sales and POC.';

CREATE INDEX IF NOT EXISTS idx_clients_company ON public.clients(company);

ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow anon all on clients" ON public.clients;
CREATE POLICY "Allow anon all on clients"
  ON public.clients FOR ALL TO anon
  USING (true) WITH CHECK (true);
