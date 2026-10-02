-- Cancel the latest holding extension. The row stays; only the cancellation fields are filled in.

ALTER TABLE public.holding_extensions
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES public.profiles (id),
  ADD COLUMN IF NOT EXISTS cancel_reason text;

ALTER TABLE public.holding_extensions
  DROP CONSTRAINT IF EXISTS holding_extensions_cancel_complete;

ALTER TABLE public.holding_extensions
  ADD CONSTRAINT holding_extensions_cancel_complete
  CHECK (
    (cancelled_at IS NULL AND cancelled_by IS NULL AND cancel_reason IS NULL)
    OR (
      cancelled_at IS NOT NULL
      AND cancelled_by IS NOT NULL
      AND cancel_reason IS NOT NULL
      AND length(btrim(cancel_reason)) >= 15
    )
  );

COMMENT ON COLUMN public.holding_extensions.previous_date IS
  'Return date on the kit before this extension. Cancel writes this date back.';
COMMENT ON COLUMN public.holding_extensions.cancelled_at IS
  'When an admin cancelled this extension. The row is kept.';

CREATE OR REPLACE FUNCTION public.holding_extensions_keep_original()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.item_id IS DISTINCT FROM OLD.item_id
     OR NEW.serial_number IS DISTINCT FROM OLD.serial_number
     OR NEW.holding_type IS DISTINCT FROM OLD.holding_type
     OR NEW.previous_date IS DISTINCT FROM OLD.previous_date
     OR NEW.new_date IS DISTINCT FROM OLD.new_date
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.extended_by IS DISTINCT FROM OLD.extended_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'holding_extensions rows cannot be edited';
  END IF;
  IF OLD.cancelled_at IS NOT NULL
     AND (
       NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
       OR NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by
       OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason
     )
  THEN
    RAISE EXCEPTION 'holding_extensions cancellation cannot be edited';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_holding_extensions_keep_original ON public.holding_extensions;
CREATE TRIGGER tr_holding_extensions_keep_original
  BEFORE UPDATE ON public.holding_extensions
  FOR EACH ROW
  EXECUTE FUNCTION public.holding_extensions_keep_original();

DROP POLICY IF EXISTS holding_extensions_cancel ON public.holding_extensions;
CREATE POLICY holding_extensions_cancel
  ON public.holding_extensions
  FOR UPDATE
  TO authenticated
  USING ((SELECT public.get_my_role()) = 'admin' AND cancelled_at IS NULL)
  WITH CHECK (
    (SELECT public.get_my_role()) = 'admin'
    AND cancelled_at IS NOT NULL
    AND cancelled_by IS NOT NULL
    AND cancel_reason IS NOT NULL
  );

GRANT UPDATE (cancelled_at, cancelled_by, cancel_reason) ON public.holding_extensions TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_holding_extension(
  p_extension_id uuid,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_ext public.holding_extensions%ROWTYPE;
  v_item public.inventory_items%ROWTYPE;
  v_expected text;
  v_current text;
  v_written text;
  v_later_type text;
  v_later_batch text;
BEGIN
  IF (SELECT public.get_my_role()) IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'cancel_holding_extension: forbidden';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 15 THEN
    RAISE EXCEPTION 'cancel_holding_extension: reason must be at least 15 characters';
  END IF;

  SELECT *
  INTO v_ext
  FROM public.holding_extensions
  WHERE id = p_extension_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'cancel_holding_extension: extension not found';
  END IF;
  IF v_ext.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'cancel_holding_extension: this extension is already cancelled';
  END IF;

  PERFORM 1
  FROM public.holding_extensions
  WHERE item_id = v_ext.item_id
  FOR UPDATE;

  IF EXISTS (
    SELECT 1
    FROM public.holding_extensions AS other
    WHERE other.item_id = v_ext.item_id
      AND other.cancelled_at IS NULL
      AND other.id <> v_ext.id
      AND (
        other.created_at > v_ext.created_at
        OR (other.created_at = v_ext.created_at AND other.id::text > v_ext.id::text)
      )
  ) THEN
    RAISE EXCEPTION 'cancel_holding_extension: only the latest extension can be cancelled';
  END IF;

  SELECT *
  INTO v_item
  FROM public.inventory_items
  WHERE id = v_ext.item_id
  FOR UPDATE;

  IF NOT FOUND OR v_item.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'cancel_holding_extension: the kit is not on the ledger';
  END IF;

  v_expected := CASE WHEN v_ext.holding_type = 'POC' THEN 'POC' ELSE 'Rented' END;
  IF v_item.status IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'cancel_holding_extension: the kit is %, not still on this holding', v_item.status;
  END IF;

  v_current := NULLIF(btrim(coalesce(v_item.return_date, '')), '');
  v_written := NULLIF(btrim(coalesce(v_ext.new_date, '')), '');
  IF v_current IS DISTINCT FROM v_written THEN
    RAISE EXCEPTION 'cancel_holding_extension: the kit return date is %, not %',
      coalesce(v_current, 'empty'),
      coalesce(v_written, 'empty');
  END IF;

  SELECT later.type, later.batch_id
  INTO v_later_type, v_later_batch
  FROM public.transactions AS later
  WHERE later.serial_number = v_item.serial_number
    AND public.transaction_record_time(later.id, later.created_at, later.date) > v_ext.created_at
  ORDER BY public.transaction_record_time(later.id, later.created_at, later.date), later.id
  LIMIT 1;

  IF v_later_type IS NOT NULL THEN
    RAISE EXCEPTION 'cancel_holding_extension: a later % movement (%) changed this kit',
      v_later_type,
      coalesce(nullif(btrim(v_later_batch), ''), 'no batch');
  END IF;

  UPDATE public.inventory_items
  SET return_date = NULLIF(btrim(coalesce(v_ext.previous_date, '')), '')
  WHERE id = v_item.id;

  UPDATE public.holding_extensions
  SET
    cancelled_at = now(),
    cancelled_by = auth.uid(),
    cancel_reason = btrim(p_reason)
  WHERE id = v_ext.id;
END;
$$;

COMMENT ON FUNCTION public.cancel_holding_extension(uuid, text) IS
  'Admin cancel of the latest active extension. Restores the stored previous return date and keeps the row.';

REVOKE ALL ON FUNCTION public.cancel_holding_extension(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_holding_extension(uuid, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.holding_extensions_keep_original() FROM PUBLIC, anon;

NOTIFY pgrst, 'reload schema';
