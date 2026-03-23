import type { Transaction } from "./data"

/** Whether a stock movement row belongs to this directory client (by id or legacy display string). */
export function isTransactionForClient(
  txn: { clientId?: string; client: string },
  client: { id: string; company: string; name: string }
): boolean {
  if (txn.clientId === client.id) return true
  if (!txn.client) return false
  const c = txn.client.trim()
  return (
    c === client.company ||
    c === client.name ||
    c.includes(client.company) ||
    c === `${client.name} - ${client.company}`
  )
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

export function countOrderGroupsForClient(
  transactions: Pick<Transaction, "id" | "type" | "clientId" | "client" | "batchId" | "invoiceNumber" | "date">[],
  client: { id: string; company: string; name: string }
): number {
  const keys = new Set<string>()
  for (const txn of transactions) {
    if (!isTransactionForClient(txn, client)) continue
    keys.add(getTransactionOrderGroupKey(txn))
  }
  return keys.size
}
