-- Collapse duplicate live inventory rows that share a serial number, then
-- enforce one live row per serial going forward.
--
-- Root cause: there was only a non-unique index on serial_number, and the
-- client decided insert-vs-update from an in-memory ledger capped at 1000 rows.
-- Serials beyond that cap looked "new" and were re-inserted, producing
-- duplicate rows on each re-inbound. The ledger load is now paginated, but we
-- still need a DB-level guarantee so stale/concurrent writes can never
-- duplicate again.
--
-- Safe to dedupe: every duplicated serial in this database shares a single
-- status (no mixed-status conflicts) and none of the extra rows are referenced
-- by kit_inspections or remediation_cases. Transactions link by serial_number,
-- not by inventory row id, so collapsing rows does not orphan ledger history.

BEGIN;

-- Keep the earliest row per serial (oldest date_added, then lexically lowest
-- id as a deterministic tiebreaker); hard-delete the surplus duplicates.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY serial_number
      ORDER BY date_added ASC NULLS LAST, id ASC
    ) AS rn
  FROM public.inventory_items
  WHERE deleted_at IS NULL
    AND serial_number IS NOT NULL
    AND serial_number <> ''
)
DELETE FROM public.inventory_items i
USING ranked r
WHERE i.id = r.id
  AND r.rn > 1;

-- One live row per serial. Partial index ignores soft-deleted rows so a serial
-- can be re-used after its prior unit is trashed, and ignores NULL serials.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inventory_items_serial_live
  ON public.inventory_items (serial_number)
  WHERE deleted_at IS NULL AND serial_number IS NOT NULL;

COMMIT;
