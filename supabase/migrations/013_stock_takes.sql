-- Stock take history: completed stock takes with snapshot of results (read-only history).
-- Run this in Supabase Dashboard → SQL Editor (or `supabase db push`) to enable stock take history.
CREATE TABLE IF NOT EXISTS public.stock_takes (
  id TEXT PRIMARY KEY,
  completed_at TEXT NOT NULL,
  result_snapshot JSONB NOT NULL
);

COMMENT ON TABLE public.stock_takes IS 'Completed stock takes; result_snapshot stores matched, notInSystem, notScanned at time of completion for read-only history.';

CREATE INDEX IF NOT EXISTS idx_stock_takes_completed_at ON public.stock_takes(completed_at DESC);

ALTER TABLE public.stock_takes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow anon all on stock_takes" ON public.stock_takes;
CREATE POLICY "Allow anon all on stock_takes"
  ON public.stock_takes FOR ALL TO anon
  USING (true) WITH CHECK (true);
