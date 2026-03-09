-- Allow 'Rentals' as a transaction type (stock movement).
-- Existing DBs: drop and re-add the check constraint.

ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_type_check
  CHECK (type IN ('Inbound', 'Sale', 'POC Out', 'POC Return', 'Transfer', 'Dispose', 'Rentals'));
