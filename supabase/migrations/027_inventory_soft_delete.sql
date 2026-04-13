-- Soft delete for inventory_items: trash for 30 days before permanent removal.
-- Optional scheduled purge (pg_cron / Edge Function):
--   DELETE FROM public.inventory_items
--   WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '30 days';

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.inventory_items.deleted_at IS 'When set, item is in trash; hidden from normal inventory. Purge after retention.';

CREATE INDEX IF NOT EXISTS idx_inventory_items_deleted_at
  ON public.inventory_items (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- Non-admins must not see trashed rows
DROP POLICY IF EXISTS "Non-admin read inventory_items" ON public.inventory_items;
CREATE POLICY "Non-admin read inventory_items"
  ON public.inventory_items FOR SELECT
  TO authenticated
  USING (
    (SELECT public.get_my_role()) IN ('sales', 'accounts', 'technicians')
    AND deleted_at IS NULL
  );
