-- Rename transaction type 'Outbound' to 'Sale'.
-- Run after 004 if you already have Outbound rows.

UPDATE public.transactions SET type = 'Sale' WHERE type = 'Outbound';

ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_type_check
  CHECK (type IN ('Inbound', 'Sale', 'POC Out', 'POC Return', 'Transfer', 'Dispose', 'Rentals'));
