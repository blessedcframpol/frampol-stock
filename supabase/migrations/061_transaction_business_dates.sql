-- 061: transactions.date is the business date; created_at is when the row was recorded.
--
-- Measured on the live database before this migration (do not treat as apply-time counts;
-- the statements below report the counts they actually change):
--   2977 transactions
--   767 midnight dates, all Sale, with no outbound_batches or batch_reversals row — created_at stays NULL
--   51 rows whose batch_id is outbound_batches.id — created_at copied from that text timestamp
--   0 rows whose batch_id is batch_reversals.batch_id
--   2159 other rows whose date has a clock time — created_at = date::timestamptz
--   2210 rows whose time part is not 00:00:00.000 — date rewritten to local midnight
--
-- Timezone source is app_settings.timezone (Africa/Harare). A row entered late in the UTC
-- day shifts to the next local calendar day. Example: 2026-09-16T22:30:00.000Z is 00:30 on
-- 17 September in Africa/Harare, so its business date becomes 2026-09-17T00:00:00.000Z
-- while created_at keeps 2026-09-16 22:30 UTC.
--
-- inventory_items date columns are not modified. They are already calendar dates
-- (date_added 1720, purchase_date 4, warranty_end_date 4, poc_out_date 31, return_date 23;
-- none are midnight timestamps and none carry a time).
--
-- ADD COLUMN is nullable with no default, then DEFAULT now() is set. A volatile default
-- on ADD COLUMN would stamp every existing row with the migration time.

BEGIN;

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS created_at timestamptz NULL;

ALTER TABLE public.transactions
  ALTER COLUMN created_at SET DEFAULT now();

COMMENT ON COLUMN public.transactions.created_at IS
  'Instant the row was recorded. NULL for legacy business-date rows that had no batch timestamp. New inserts use now().';

COMMENT ON COLUMN public.transactions.date IS
  'Business date in app_settings.timezone, stored as YYYY-MM-DDT00:00:00.000Z so lexicographic order matches calendar order. The recorded instant is created_at.';

CREATE TEMP TABLE _061_counts (
  step text PRIMARY KEY,
  affected integer NOT NULL
) ON COMMIT DROP;

WITH updated AS (
  UPDATE public.transactions AS txn
  SET created_at = batch.created_at::timestamptz
  FROM public.outbound_batches AS batch
  WHERE batch.id = txn.batch_id
    AND batch.created_at ~ '^\d{4}-\d{2}-\d{2}T'
    AND txn.created_at IS NULL
  RETURNING txn.id
)
INSERT INTO _061_counts (step, affected)
SELECT 'outbound_batch', count(*)::integer FROM updated;

WITH updated AS (
  UPDATE public.transactions AS txn
  SET created_at = reversal.reversed_at
  FROM public.batch_reversals AS reversal
  WHERE reversal.batch_id = txn.batch_id
    AND txn.created_at IS NULL
  RETURNING txn.id
)
INSERT INTO _061_counts (step, affected)
SELECT 'batch_reversal', count(*)::integer FROM updated;

WITH updated AS (
  UPDATE public.transactions AS txn
  SET created_at = txn.date::timestamptz
  WHERE txn.created_at IS NULL
    AND substring(txn.date FROM 12 FOR 12) <> '00:00:00.000'
  RETURNING txn.id
)
INSERT INTO _061_counts (step, affected)
SELECT 'timed_date', count(*)::integer FROM updated;

WITH updated AS (
  UPDATE public.transactions AS txn
  SET date = to_char((txn.date::timestamptz) AT TIME ZONE settings.timezone, 'YYYY-MM-DD')
             || 'T00:00:00.000Z'
  FROM public.app_settings AS settings
  WHERE settings.id
    AND substring(txn.date FROM 12 FOR 12) <> '00:00:00.000'
  RETURNING txn.id
)
INSERT INTO _061_counts (step, affected)
SELECT 'dates_normalised', count(*)::integer FROM updated;

INSERT INTO _061_counts (step, affected)
SELECT 'created_at_non_null', count(*)::integer
FROM public.transactions
WHERE created_at IS NOT NULL;

INSERT INTO _061_counts (step, affected)
SELECT 'created_at_null', count(*)::integer
FROM public.transactions
WHERE created_at IS NULL;

DO $$
DECLARE
  bad integer;
  constraint_def text;
  tz text;
BEGIN
  SELECT timezone INTO tz FROM public.app_settings WHERE id;
  IF tz IS NULL OR btrim(tz) = '' THEN
    RAISE EXCEPTION '061: app_settings.timezone is empty';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO constraint_def
  FROM pg_constraint
  WHERE conrelid = 'public.transactions'::regclass
    AND conname = 'transactions_date_iso_utc';
  IF constraint_def IS NULL THEN
    RAISE EXCEPTION '061: transactions_date_iso_utc is missing';
  END IF;

  SELECT count(*) INTO bad
  FROM public.transactions
  WHERE substring(date FROM 12 FOR 12) <> '00:00:00.000'
     OR date !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$';
  IF bad <> 0 THEN
    RAISE EXCEPTION '061: % transaction dates are not business-date midnights', bad;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_transactions_created_at
  ON public.transactions (created_at DESC NULLS LAST);

-- reverse_quick_scan_batch inserts its reversal ledger row and only then deletes
-- the original batch. Insert order therefore does not hide that ledger row from
-- this BEFORE DELETE trigger. The ledger is excluded explicitly:
--   later.type = 'Reversal'
--   OR later.metadata->>'reversedBatchId' IS NOT NULL
-- The app ledger uses serial '(batch)'; the exclusion also covers a ledger row
-- that carries the item serial. An original with created_at NULL and no other
-- movement is not a conflict with itself. A different-batch row on the same
-- business date with created_at NULL still blocks, because its order cannot be
-- proven. Every other candidate uses COALESCE(created_at, date::timestamptz).
CREATE OR REPLACE FUNCTION public.guard_quick_scan_reversal_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF current_setting('app.quick_scan_reversal', true) = 'on'
     AND EXISTS (
       SELECT 1
       FROM public.transactions AS later
       WHERE later.serial_number = OLD.serial_number
         AND later.id <> OLD.id
         AND later.batch_id IS DISTINCT FROM OLD.batch_id
         AND later.type IS DISTINCT FROM 'Reversal'
         AND later.metadata->>'reversedBatchId' IS NULL
         AND (
           COALESCE(later.created_at, later.date::timestamptz)
             > COALESCE(OLD.created_at, OLD.date::timestamptz)
           OR (
             later.date = OLD.date
             AND later.created_at IS NULL
           )
         )
     ) THEN
    RAISE EXCEPTION
      'reverse_quick_scan_batch: % has a later or same-day movement with unknown recorded time',
      OLD.serial_number;
  END IF;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_quick_scan_reversal_order() FROM PUBLIC;

DROP TRIGGER IF EXISTS tr_transactions_guard_quick_scan_reversal_order
  ON public.transactions;
CREATE TRIGGER tr_transactions_guard_quick_scan_reversal_order
  BEFORE DELETE ON public.transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_quick_scan_reversal_order();

SELECT step, affected
FROM _061_counts
ORDER BY step;

COMMIT;
