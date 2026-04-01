import type { QuickScanRecord, Transaction, TransactionType } from "@/lib/data"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "./database.types"
import { transactionToRow } from "./inventory-db"

/** Movements that log inventory + transactions client-side via applyMovement + recordQuickScan(ledgerSynced). */
const LOG_MOVEMENTS = new Set<string>([])

export function shouldAppendLedgerFromQuickScan(movementType: string, ledgerSynced: boolean): boolean {
  if (ledgerSynced) return false
  return LOG_MOVEMENTS.has(movementType)
}

/**
 * Inserts `transactions` rows for quick-scan log-only movements so ledger matches the movement batch.
 */
export async function insertTransactionsForQuickScanRecords(
  supabase: SupabaseClient<Database>,
  records: QuickScanRecord[],
  movementType: TransactionType
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (records.length === 0) return { ok: true }
  const date = records[0]!.scannedAt
  const batchId = records[0]!.batchId
  const base = Date.now()
  const txns: Transaction[] = records.map((r, i) => ({
    id: `TXN-${base}-${i}-${Math.random().toString(36).slice(2, 9)}`,
    type: movementType,
    serialNumber: r.serialNumber,
    itemName: r.scanType,
    client: "Internal",
    date,
    batchId,
  }))
  const { error } = await supabase.from("transactions").insert(txns.map(transactionToRow))
  if (error) return { ok: false, message: error.message }
  return { ok: true }
}
