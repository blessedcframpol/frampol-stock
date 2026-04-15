-- Post-decommission inspection: kit_inspections table + Inspection Pass / Fail transaction types.

-- ---------------------------------------------------------------------------
-- kit_inspections
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kit_inspections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_item_id TEXT NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  serial_number TEXT NOT NULL,
  inspector_name TEXT,
  inspected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome TEXT NOT NULL CHECK (outcome IN ('available', 'faulty')),
  condition_notes TEXT,
  attachment_urls TEXT[] NOT NULL DEFAULT '{}',
  transaction_id TEXT REFERENCES public.transactions(id) ON DELETE SET NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kit_inspections_serial ON public.kit_inspections (serial_number);
CREATE INDEX IF NOT EXISTS idx_kit_inspections_item ON public.kit_inspections (inventory_item_id);

COMMENT ON TABLE public.kit_inspections IS 'Inspection outcome after decommission intake (Pending Inspection).';

-- ---------------------------------------------------------------------------
-- transactions.type: Inspection Pass, Inspection Fail
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
    'Inspection Fail'
  ));

ALTER TABLE public.kit_inspections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin full access kit_inspections"
  ON public.kit_inspections FOR ALL
  TO authenticated
  USING ((SELECT public.get_my_role()) = 'admin')
  WITH CHECK ((SELECT public.get_my_role()) = 'admin');

CREATE POLICY "Non-admin read kit_inspections"
  ON public.kit_inspections FOR SELECT
  TO authenticated
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'));

CREATE POLICY "Non-admin insert kit_inspections"
  ON public.kit_inspections FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'));

CREATE POLICY "Non-admin update kit_inspections"
  ON public.kit_inspections FOR UPDATE
  TO authenticated
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'))
  WITH CHECK ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'));
