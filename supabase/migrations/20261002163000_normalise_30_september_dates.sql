-- D1: Josh approved the 60 Inbound rows from 30/09/2026.
-- Their date is the batch instant. Rewrite it to the Africa/Harare business-date
-- midnight. created_at already holds the recorded instant; copy date into
-- created_at only when that column is null. Change nothing else.
-- transactions_date_iso_utc is already valid. VALIDATE rechecks every row.

BEGIN;

DO $$
DECLARE
  pending integer;
  tz text;
BEGIN
  SELECT timezone INTO tz FROM public.app_settings WHERE id;
  IF tz IS DISTINCT FROM 'Africa/Harare' THEN
    RAISE EXCEPTION 'D1: app_settings.timezone is %, expected Africa/Harare', tz;
  END IF;

  SELECT count(*) INTO pending
  FROM public.transactions
  WHERE substring(date FROM 12 FOR 12) <> '00:00:00.000';
  IF pending <> 60 THEN
    RAISE EXCEPTION 'D1: expected 60 non-midnight dates, found %', pending;
  END IF;
END $$;

UPDATE public.transactions AS txn
SET created_at = txn.date::timestamptz
WHERE substring(txn.date FROM 12 FOR 12) <> '00:00:00.000'
  AND txn.created_at IS NULL;

DO $$
DECLARE
  rewritten integer;
  remaining integer;
BEGIN
  UPDATE public.transactions AS txn
  SET date = '2026-09-30T00:00:00.000Z'
  WHERE substring(txn.date FROM 12 FOR 12) <> '00:00:00.000'
    AND to_char((txn.date::timestamptz) AT TIME ZONE 'Africa/Harare', 'YYYY-MM-DD') = '2026-09-30';
  GET DIAGNOSTICS rewritten = ROW_COUNT;
  IF rewritten <> 60 THEN
    RAISE EXCEPTION 'D1: expected to rewrite 60 dates, wrote %', rewritten;
  END IF;

  SELECT count(*) INTO remaining
  FROM public.transactions
  WHERE substring(date FROM 12 FOR 12) <> '00:00:00.000';
  IF remaining <> 0 THEN
    RAISE EXCEPTION 'D1: % transaction dates are still not midnight', remaining;
  END IF;
END $$;

ALTER TABLE public.transactions VALIDATE CONSTRAINT transactions_date_iso_utc;

COMMIT;
