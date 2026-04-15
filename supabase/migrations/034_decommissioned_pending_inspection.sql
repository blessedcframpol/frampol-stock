-- Decommissioned intake: Pending Inspection status, transaction type, metadata + audit on transactions.

-- ---------------------------------------------------------------------------
-- inventory_items.status: Pending Inspection
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
    'RMA Hold',
    'Pending Inspection'
  ));

-- ---------------------------------------------------------------------------
-- transactions: metadata JSONB, created_by audit
-- ---------------------------------------------------------------------------
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS metadata JSONB;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.transactions.metadata IS 'Structured movement fields (e.g. decommission reason, inspection, remediation case id).';
COMMENT ON COLUMN public.transactions.created_by IS 'Authenticated user who recorded the transaction, when available.';

-- ---------------------------------------------------------------------------
-- transactions.type: Decommissioned
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
    'Decommissioned'
  ));

-- ---------------------------------------------------------------------------
-- Status transition guard
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
    OR (OLD.status = 'POC' AND NEW.status IN ('In Stock', 'Pending Inspection'))
    OR (OLD.status = 'Rented' AND NEW.status IN ('In Stock', 'Pending Inspection'))
    OR (OLD.status = 'Sold' AND NEW.status IN ('In Stock', 'RMA Hold', 'Pending Inspection'))
    OR (OLD.status = 'RMA Hold' AND NEW.status IN ('In Stock', 'Disposed', 'Sold'))
    OR (OLD.status = 'Pending Inspection' AND NEW.status IN ('In Stock', 'RMA Hold', 'Disposed'))
  ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid inventory status transition: % -> %', OLD.status, NEW.status;
END;
$$;

COMMENT ON FUNCTION public.inventory_items_guard_status_transition() IS
  'Allows defined status transitions; includes Decommissioned pipeline (Pending Inspection).';
