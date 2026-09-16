-- Drop unused stock_request_events.idempotency_key.
--
-- The column was declared text NULL UNIQUE in 046 but log_stock_request_event
-- has never accepted or written a value; every existing row is NULL. The table
-- is append-only and written exclusively by one REVOKE-guarded SECURITY DEFINER
-- function, with no retry or replay path that could double-write an event, so
-- there is nothing for an idempotency key to deduplicate.
--
-- If a replay path is ever added, reintroduce the key together with the logic
-- that populates it — not ahead of it. Dropping the column also drops its
-- unique constraint (stock_request_events_idempotency_key_key).

ALTER TABLE public.stock_request_events
  DROP COLUMN IF EXISTS idempotency_key;
