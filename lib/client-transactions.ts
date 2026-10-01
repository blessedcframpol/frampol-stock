import { clientMatchKeys } from "./clients-directory"
import type { Transaction } from "./data"

/** Stored ledger text that does not name this directory row. Shown so a client_id win stays visible. */
export function ledgerTextDiffersFromClient(
  stored: string | null | undefined,
  client: { name?: string | null; company?: string | null },
): boolean {
  const text = (stored ?? "").trim().toLowerCase()
  if (!text) return false
  return !clientMatchKeys(client).includes(text)
}

/** Outbound types where multiple lines from one submit often share one invoice/time but may lack batch_id (legacy Sale). */
const GROUPABLE_WITHOUT_BATCH = new Set<string>(["Sale", "POC Out", "Rentals"])

/**
 * Stable key for "one order": shared batch_id, or (legacy) same type + invoice + timestamp for bulk Sale/POC/Rental.
 * Other movements are one key per row.
 */
export function getTransactionOrderGroupKey(txn: Pick<Transaction, "id" | "type" | "batchId" | "invoiceNumber" | "date">): string {
  if (txn.batchId) return `b:${txn.batchId}`
  if (GROUPABLE_WITHOUT_BATCH.has(txn.type)) {
    return `l:${txn.type}:${txn.invoiceNumber ?? ""}:${txn.date}`
  }
  return `u:${txn.id}`
}

/** Groups already-filtered client transactions into consignment/order units (matches client detail table). */
export function groupClientOrderTransactions(clientTxns: Transaction[]): Transaction[][] {
  const map = new Map<string, Transaction[]>()
  for (const txn of clientTxns) {
    const key = getTransactionOrderGroupKey(txn)
    const list = map.get(key) ?? []
    list.push(txn)
    map.set(key, list)
  }
  return Array.from(map.values())
}

