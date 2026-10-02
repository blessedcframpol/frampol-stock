-- Record the status a movement started from, and refuse an Inbound whose insert did not happen.
-- previous_status is taken from the locked inventory row inside apply_stock_movement.
-- The client payload cannot set it. A create stores null / 'recorded', which means the row was created.
-- Existing rows are backfilled by the record-time replay (created_at, then the TXN- id clock, then the business date).

ALTER TABLE public.transactions
  ADD COLUMN previous_status text,
  ADD COLUMN previous_status_source text;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_previous_status_check
  CHECK (
    previous_status IS NULL
    OR previous_status = ANY (ARRAY[
      'In Stock', 'Sold', 'POC', 'Rented', 'Maintenance', 'Disposed', 'RMA Hold', 'Pending Inspection'
    ])
  );

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_previous_status_source_check
  CHECK (previous_status_source IN ('recorded', 'derived', 'unknown'));

COMMENT ON COLUMN public.transactions.previous_status IS
  'Inventory status before this movement. Null on a create (the movement inserted the row) and on a Reversal, which does not lock an item.';

COMMENT ON COLUMN public.transactions.previous_status_source IS
  'recorded: locked row inside apply_stock_movement. derived: the replay had one legal predecessor. unknown: several predecessors were legal; In Stock was used when it was one of them.';
