-- Reversal audit for movement batches (replaces marking rows in quick_scans).
-- Run BEFORE scripts/migrate-quick-scans.ts and BEFORE dropping quick_scans.

CREATE TABLE IF NOT EXISTS public.batch_reversals (
  batch_id TEXT PRIMARY KEY,
  reversed_at TIMESTAMPTZ NOT NULL,
  reversal_reason TEXT,
  reversed_by TEXT
);

COMMENT ON TABLE public.batch_reversals IS 'Admin reversal audit for a transaction batch_id; UI uses this instead of quick_scans.reversed_at.';

INSERT INTO public.batch_reversals (batch_id, reversed_at, reversal_reason, reversed_by)
SELECT DISTINCT ON (qs.batch_id)
  qs.batch_id,
  qs.reversed_at,
  qs.reversal_reason,
  qs.reversed_by::text
FROM public.quick_scans qs
WHERE qs.reversed_at IS NOT NULL
  AND qs.batch_id IS NOT NULL
  AND trim(qs.batch_id) <> ''
ORDER BY qs.batch_id, qs.reversed_at DESC
ON CONFLICT (batch_id) DO NOTHING;

ALTER TABLE public.batch_reversals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin full access batch_reversals" ON public.batch_reversals;
CREATE POLICY "Admin full access batch_reversals"
  ON public.batch_reversals FOR ALL
  TO authenticated
  USING ((SELECT public.get_my_role()) = 'admin')
  WITH CHECK ((SELECT public.get_my_role()) = 'admin');

DROP POLICY IF EXISTS "Non-admin read batch_reversals" ON public.batch_reversals;
CREATE POLICY "Non-admin read batch_reversals"
  ON public.batch_reversals FOR SELECT
  TO authenticated
  USING ((SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians'));
