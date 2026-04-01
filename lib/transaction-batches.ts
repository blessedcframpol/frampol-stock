import type { Transaction, TransactionType } from "@/lib/data"
import { getTransactionOrderGroupKey } from "@/lib/client-transactions"

/** One logical submission / batch for history UI (matches grouped `transactions` rows). */
export type TransactionBatchSummary = {
  /** Stable key for React lists */
  batchKey: string
  /** `transactions.batch_id` when present — use for quick-scan reverse lookup */
  reverseBatchId: string | null
  date: string
  movementType: TransactionType
  productLabel: string
  clientDisplay: string
  count: number
  serials: string[]
  isReversed: boolean
  reversalReason?: string
  reversedAt?: string
  invoiceNumber?: string
  hasDeliveryNote: boolean
  /** First delivery note URL in batch (Inbound), if any */
  deliveryNoteUrl?: string
}

function productLabelFromTransactions(txns: Transaction[]): string {
  const names = [...new Set(txns.map((t) => t.itemName).filter(Boolean))].sort()
  if (names.length === 0) return "—"
  if (names.length === 1) return names[0]!
  if (names.length === 2) return `${names[0]!}, ${names[1]!}`
  return `${names[0]!} +${names.length - 1} more`
}

function clientDisplayFromTransactions(txns: Transaction[]): string {
  const c = txns[0]?.client?.trim()
  return c && c.length > 0 ? c : "—"
}

/**
 * Group flat transaction rows into batch summaries (same rules as client order grouping).
 */
export function groupTransactionsIntoBatches(
  transactions: Transaction[],
  reversalByBatchId: Map<string, { reversedAt: string; reversalReason?: string }>
): TransactionBatchSummary[] {
  const map = new Map<string, Transaction[]>()
  for (const txn of transactions) {
    const key = getTransactionOrderGroupKey(txn)
    const list = map.get(key) ?? []
    list.push(txn)
    map.set(key, list)
  }

  const out: TransactionBatchSummary[] = []
  for (const [batchKey, txns] of map) {
    if (txns.length === 0) continue
    const sorted = [...txns].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    const first = sorted[0]!
    const batchId = first.batchId ?? null
    const rev = batchId ? reversalByBatchId.get(batchId) : undefined
    out.push({
      batchKey,
      reverseBatchId: batchId,
      date: first.date,
      movementType: first.type,
      productLabel: productLabelFromTransactions(sorted),
      clientDisplay: clientDisplayFromTransactions(sorted),
      count: sorted.length,
      serials: sorted.map((t) => t.serialNumber),
      isReversed: !!rev,
      reversalReason: rev?.reversalReason,
      reversedAt: rev?.reversedAt,
      invoiceNumber: first.invoiceNumber,
      hasDeliveryNote: sorted.some((t) => !!t.deliveryNoteUrl),
      deliveryNoteUrl: sorted.find((t) => t.deliveryNoteUrl)?.deliveryNoteUrl,
    })
  }

  out.sort((a, b) => {
    const ar = a.isReversed ? 1 : 0
    const br = b.isReversed ? 1 : 0
    if (ar !== br) return ar - br
    return new Date(b.date).getTime() - new Date(a.date).getTime()
  })
  return out
}
