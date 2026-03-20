-- Outbound batches for POC Out and Rentals (group items sent out together; used for return flow)
-- Single CHECK per column: do not add a duplicate named constraint (PostgreSQL names the
-- column-level CHECK outbound_batches_type_check, which clashes with a second CONSTRAINT of the same name).
CREATE TABLE IF NOT EXISTS public.outbound_batches (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('POC Out', 'Rentals')),
  client TEXT,
  client_id TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partial_return', 'closed')),
  invoice_number TEXT,
  created_at TEXT NOT NULL
);

COMMENT ON TABLE public.outbound_batches IS 'Groups of items sent out for POC or Rental; used to track return and close when all returned.';

CREATE INDEX IF NOT EXISTS idx_outbound_batches_status ON public.outbound_batches(status);
CREATE INDEX IF NOT EXISTS idx_outbound_batches_created_at ON public.outbound_batches(created_at DESC);

-- Link transactions to batch when they are part of a POC Out or Rentals outbound
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'transactions' AND column_name = 'batch_id'
  ) THEN
    ALTER TABLE public.transactions ADD COLUMN batch_id TEXT;
  END IF;
END $$;

COMMENT ON COLUMN public.transactions.batch_id IS 'Links to outbound_batches.id when this transaction is part of a POC Out or Rentals batch.';

ALTER TABLE public.outbound_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow anon all on outbound_batches" ON public.outbound_batches;
CREATE POLICY "Allow anon all on outbound_batches"
  ON public.outbound_batches FOR ALL TO anon
  USING (true) WITH CHECK (true);
