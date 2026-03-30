-- Quick scan log: retain rows when reversing a batch; record admin reversal with reason.
-- Removes non-admin DELETE so only admins can hard-delete or reverse (reversal = UPDATE).

ALTER TABLE public.quick_scans
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversal_reason TEXT,
  ADD COLUMN IF NOT EXISTS reversed_by UUID REFERENCES auth.users (id);

COMMENT ON COLUMN public.quick_scans.reversed_at IS 'When this scan row was reversed; NULL = active.';
COMMENT ON COLUMN public.quick_scans.reversal_reason IS 'Explanation when an admin reverses a batch.';
COMMENT ON COLUMN public.quick_scans.reversed_by IS 'Auth user who reversed the batch.';

DROP POLICY IF EXISTS "Non-admin delete quick_scans" ON public.quick_scans;
