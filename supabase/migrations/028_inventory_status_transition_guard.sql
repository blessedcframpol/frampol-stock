-- Enforce allowed inventory_items.status transitions at the database layer.
-- Location-only updates (status unchanged) are always allowed.
-- Complements app-side validation in lib/supabase/movement-utils.ts (validateMovementForItem).

CREATE OR REPLACE FUNCTION public.inventory_items_guard_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;
  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  IF (
    (OLD.status = 'In Stock' AND NEW.status IN ('Sold', 'POC', 'Rented', 'Disposed'))
    OR (OLD.status = 'Maintenance' AND NEW.status IN ('In Stock', 'Disposed'))
    OR (OLD.status = 'POC' AND NEW.status = 'In Stock')
    OR (OLD.status = 'Rented' AND NEW.status = 'In Stock')
    -- Undo Sale (transaction delete) back to warehouse stock
    OR (OLD.status = 'Sold' AND NEW.status = 'In Stock')
  ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid inventory status transition: % -> %', OLD.status, NEW.status;
END;
$$;

DROP TRIGGER IF EXISTS trg_inventory_items_status_guard ON public.inventory_items;

CREATE TRIGGER trg_inventory_items_status_guard
  BEFORE UPDATE ON public.inventory_items
  FOR EACH ROW
  EXECUTE FUNCTION public.inventory_items_guard_status_transition();

COMMENT ON FUNCTION public.inventory_items_guard_status_transition() IS
  'Allows only warehouse-defined status transitions; blocks e.g. Sold -> In Stock without matching app rules.';
