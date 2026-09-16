-- Repair corrupt transactions.date values and constrain the column to toISOString() form.
-- Keeps date as text (apply_stock_movement / reverse_quick_scan_batch declare date text);
-- the CHECK makes lexicographic ORDER BY chronologically correct.

-- ---------------------------------------------------------------------------
-- 1. Repair the two known corrupt admin catch-up Sale rows by id + prior value
-- ---------------------------------------------------------------------------

-- Expanded-year ISO from unguarded new Date('52026-05-28') in UTC+2
-- (admin catch-up Sale). TXN id embeds Date.now() ≈ 2026-06-03; intended day 2026-05-28.
UPDATE public.transactions
SET date = '2026-05-28T00:00:00.000Z'
WHERE id = 'TXN-1780493607186-1-edls5x7'
  AND date = '+052026-05-27T22:00:00.000Z';

-- Year 0206 from unguarded YYYY-MM-DD override (meant 2026-05-18).
-- TXN id embeds Date.now() ≈ 2026-05-26; intended day 2026-05-18.
UPDATE public.transactions
SET date = '2026-05-18T00:00:00.000Z'
WHERE id = 'TXN-1779783032001-1-h9wwmik'
  AND date = '0206-05-18T00:00:00.000Z';

-- ---------------------------------------------------------------------------
-- 2. Fail loudly if any row still fails the ISO format check
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad FROM public.transactions
  WHERE date !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$';
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'transactions.date: % row(s) still fail the ISO format check', v_bad;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Constraint (re-runnable)
-- ---------------------------------------------------------------------------
ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_date_iso_utc;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_date_iso_utc CHECK (
    date ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    AND substring(date from 1 for 4)::int BETWEEN 2020 AND 2100
  );

-- date is already NOT NULL (confirmed via information_schema); no ALTER needed.

COMMENT ON COLUMN public.transactions.date IS
  'ISO-8601 UTC text in exactly Date.prototype.toISOString() form '
  '(YYYY-MM-DDTHH:mm:ss.sssZ). Fixed-width format makes lexicographic ORDER BY '
  'chronologically correct; constraint transactions_date_iso_utc is load-bearing for that guarantee. '
  'Admin catch-up Sale overrides use midnight UTC (…T00:00:00.000Z).';
