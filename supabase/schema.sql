-- Fram-Stock – Supabase schema
-- Run in Supabase: Dashboard → SQL Editor → New query → paste & Run
--
-- Note: Actual seed data will be added later. Column types, constraints, or
-- indexes may need changes when seeding – adjust this schema as needed then.

-- =============================================================================
-- TABLES
-- =============================================================================

-- Canonical product catalog (one row per product name; globally unique normalized name).
-- Production: apply supabase/migrations in order — this file is a readable baseline.
CREATE TABLE IF NOT EXISTS public.product_lines (
  id TEXT PRIMARY KEY,
  product_name TEXT NOT NULL,
  vendor TEXT NOT NULL DEFAULT 'General',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_lines_product_name_lower
  ON public.product_lines ((lower(trim(product_name))));

COMMENT ON TABLE public.product_lines IS 'Product name + vendor; inventory_items.product_id references this table.';

-- One row per physical asset (serialised item)
CREATE TABLE IF NOT EXISTS public.inventory_items (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES public.product_lines(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  serial_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'In Stock',
  date_added TEXT NOT NULL,
  location TEXT NOT NULL,
  client TEXT,
  notes TEXT,
  assigned_to TEXT,
  purchase_date TEXT,
  warranty_end_date TEXT,
  poc_out_date TEXT,
  return_date TEXT,
  assignment_history JSONB,
  reserved_for_request_line_id UUID,
  cloud_key TEXT,
  deleted_at TIMESTAMPTZ,
  CONSTRAINT inventory_items_status_check
    CHECK (status IN ('In Stock', 'Sold', 'POC', 'Rented', 'Maintenance', 'Disposed', 'RMA Hold'))
);

COMMENT ON TABLE public.inventory_items IS 'Physical inventory; product identity is product_lines via product_id (no name/vendor columns on this table).';

-- Movement / transaction log (audit trail)
CREATE TABLE IF NOT EXISTS public.transactions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  serial_number TEXT NOT NULL,
  item_name TEXT NOT NULL,
  client TEXT NOT NULL,
  date TEXT NOT NULL,
  invoice_number TEXT,
  notes TEXT,
  from_location TEXT,
  to_location TEXT,
  assigned_to TEXT,
  CONSTRAINT transactions_type_check
    CHECK (type IN ('Inbound', 'Sale', 'POC Out', 'POC Return', 'Rental Return', 'Transfer', 'Dispose', 'Rentals', 'Sale Return'))
);

COMMENT ON TABLE public.transactions IS 'History of stock movements (in/out, POC, transfer, dispose, sale return / RMA).';

-- Admin reversal audit for movement batches (replaces legacy quick_scans reversal columns)
CREATE TABLE IF NOT EXISTS public.batch_reversals (
  batch_id TEXT PRIMARY KEY,
  reversed_at TIMESTAMPTZ NOT NULL,
  reversal_reason TEXT,
  reversed_by TEXT
);

COMMENT ON TABLE public.batch_reversals IS 'Admin reversal audit for a transaction batch_id.';

-- Clients (for dropdowns and future CRM-style use)
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

-- =============================================================================
-- INDEXES
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_inventory_items_serial
  ON public.inventory_items(serial_number);
CREATE INDEX IF NOT EXISTS idx_inventory_items_status
  ON public.inventory_items(status);
CREATE INDEX IF NOT EXISTS idx_inventory_items_product_id
  ON public.inventory_items(product_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_date_added
  ON public.inventory_items(date_added);

CREATE INDEX IF NOT EXISTS idx_transactions_date
  ON public.transactions(date DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_serial
  ON public.transactions(serial_number);
CREATE INDEX IF NOT EXISTS idx_transactions_type
  ON public.transactions(type);

CREATE INDEX IF NOT EXISTS idx_clients_company
  ON public.clients(company);

-- =============================================================================
-- ROW LEVEL SECURITY (RLS)
-- =============================================================================
ALTER TABLE public.product_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.batch_reversals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;

-- Allow anon key full access (no auth yet). Replace with auth policies later.
-- Drop first so this script is re-runnable.
DROP POLICY IF EXISTS "Allow anon all on product_lines" ON public.product_lines;
CREATE POLICY "Allow anon all on product_lines"
  ON public.product_lines FOR ALL TO anon
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow anon all on inventory_items" ON public.inventory_items;
CREATE POLICY "Allow anon all on inventory_items"
  ON public.inventory_items FOR ALL TO anon
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow anon all on transactions" ON public.transactions;
CREATE POLICY "Allow anon all on transactions"
  ON public.transactions FOR ALL TO anon
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow anon all on batch_reversals" ON public.batch_reversals;
CREATE POLICY "Allow anon all on batch_reversals"
  ON public.batch_reversals FOR ALL TO anon
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow anon all on clients" ON public.clients;
CREATE POLICY "Allow anon all on clients"
  ON public.clients FOR ALL TO anon
  USING (true) WITH CHECK (true);
