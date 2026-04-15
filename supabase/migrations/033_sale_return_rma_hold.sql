-- Sale Return: customer return of previously sold units into RMA Hold (vendor replacement / faulty kit workflow).
-- See docs/inventory-movements-and-rma.md

-- ---------------------------------------------------------------------------
-- inventory_items.status: add RMA Hold
-- ---------------------------------------------------------------------------
ALTER TABLE public.inventory_items DROP CONSTRAINT IF EXISTS inventory_items_status_check;
ALTER TABLE public.inventory_items ADD CONSTRAINT inventory_items_status_check
  CHECK (status IN (
    'In Stock',
    'Sold',
    'POC',
    'Rented',
    'Maintenance',
    'Disposed',
    'RMA Hold'
  ));

-- ---------------------------------------------------------------------------
-- transactions.type: add Sale Return
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
    'Sale Return'
  ));

-- ---------------------------------------------------------------------------
-- Status transition guard: Sold -> RMA Hold; RMA Hold -> In Stock | Disposed
-- ---------------------------------------------------------------------------
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
    OR (OLD.status = 'Sold' AND NEW.status IN ('In Stock', 'RMA Hold'))
    OR (OLD.status = 'RMA Hold' AND NEW.status IN ('In Stock', 'Disposed', 'Sold'))
  ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid inventory status transition: % -> %', OLD.status, NEW.status;
END;
$$;

COMMENT ON FUNCTION public.inventory_items_guard_status_transition() IS
  'Allows warehouse-defined status transitions; includes Sold->RMA Hold (Sale Return) and RMA Hold->In Stock|Disposed.';
