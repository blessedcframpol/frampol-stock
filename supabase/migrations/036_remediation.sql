-- Remediation providers (Starlink-first) and cases; Remediation Loaner Issue movement type.

-- ---------------------------------------------------------------------------
-- remediation_providers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.remediation_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.remediation_providers (slug, display_name)
VALUES ('starlink', 'Starlink')
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- remediation_cases
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.remediation_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES public.remediation_providers(id) ON DELETE RESTRICT,
  faulty_inventory_item_id TEXT NOT NULL REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
  faulty_serial TEXT NOT NULL,
  loaner_inventory_item_id TEXT REFERENCES public.inventory_items(id) ON DELETE SET NULL,
  loaner_serial TEXT,
  provider_replacement_inventory_item_id TEXT REFERENCES public.inventory_items(id) ON DELETE SET NULL,
  provider_replacement_serial TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'replacement_received', 'closed')),
  date_sent_to_provider DATE,
  date_replacement_received DATE,
  tracking_reference TEXT,
  notes TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_remediation_cases_faulty_serial ON public.remediation_cases (faulty_serial);
CREATE INDEX IF NOT EXISTS idx_remediation_cases_status ON public.remediation_cases (status);

COMMENT ON TABLE public.remediation_cases IS 'Upstream provider RMA chain: faulty unit, loaner from stock, provider replacement serial.';

-- ---------------------------------------------------------------------------
-- transactions.type: Remediation Loaner Issue
-- ---------------------------------------------------------------------------
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_type_check
  CHECK (type IN (
    'Inbound',
    'Sale',
    'POC Out',
    'POC Return',
    'Rental Return',
    'Transfer',
    'Dispose',
    'Rentals',
    'Sale Return',
    'Decommissioned',
    'Inspection Pass',
    'Inspection Fail',
    'Remediation Loaner Issue'
  ));

-- Guard already allows In Stock -> Sold; loaner issue uses Sale-like transition.

ALTER TABLE public.remediation_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.remediation_cases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read remediation_providers"
  ON public.remediation_providers FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admin write remediation_providers"
  ON public.remediation_providers FOR ALL
  TO authenticated
  USING ((SELECT public.get_my_role()) = 'admin')
  WITH CHECK ((SELECT public.get_my_role()) = 'admin');

CREATE POLICY "Admin full access remediation_cases"
  ON public.remediation_cases FOR ALL
  TO authenticated
  USING ((SELECT public.get_my_role()) = 'admin')
  WITH CHECK ((SELECT public.get_my_role()) = 'admin');

CREATE POLICY "Non-admin read remediation_cases"
  ON public.remediation_cases FOR SELECT
  TO authenticated
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'));

CREATE POLICY "Non-admin insert remediation_cases"
  ON public.remediation_cases FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'));

CREATE POLICY "Non-admin update remediation_cases"
  ON public.remediation_cases FOR UPDATE
  TO authenticated
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'))
  WITH CHECK ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'));
