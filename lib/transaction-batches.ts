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
  /** Set when every row shares the same `clientId` (directory link in UI). */
  clientId?: string
  /** Unique non-empty notes joined when multiple; separator between distinct notes. */
  notesSummary?: string
  /** Shown when all rows agree (avoids misleading mixed transfers). */
  fromLocation?: string
  toLocation?: string
  /** Unique assignee values, comma-separated when several. */
  assignedToSummary?: string
  /** Aggregated for Dispose rows (comma-separated if multiple distinct). */
  disposalReasonSummary?: string
  authorisedBySummary?: string
}

function uniqueTrimmedStrings(values: (string | undefined | null)[]): string[] {
  const set = new Set<string>()
  for (const v of values) {
    const t = (v ?? "").trim()
    if (t) set.add(t)
  }
  return [...set].sort()
}

/** If every row yields the same trimmed string, return it; else undefined. */
function uniformTrimmedField(txns: Transaction[], getter: (t: Transaction) => string | undefined): string | undefined {
  const raw = txns.map((t) => {
    const v = getter(t)?.trim()
    return v || undefined
  })
  const defined = raw.filter((v): v is string => Boolean(v))
  if (defined.length === 0) return undefined
  const first = defined[0]!
  if (defined.every((v) => v === first)) return first
  return undefined
}

function notesSummaryFromTransactions(txns: Transaction[]): string | undefined {
  const notes = uniqueTrimmedStrings(txns.map((t) => t.notes))
  if (notes.length === 0) return undefined
  if (notes.length === 1) return notes[0]
  return notes.join("\n\n---\n\n")
}

function assignedToSummaryFromTransactions(txns: Transaction[]): string | undefined {
  const parts = uniqueTrimmedStrings(txns.map((t) => t.assignedTo))
  if (parts.length === 0) return undefined
  return parts.join(", ")
}

/** All rows must share the same `clientId` or field is omitted. */
function clientIdUniformFromTransactions(txns: Transaction[]): string | undefined {
  const ids = uniqueTrimmedStrings(txns.map((t) => t.clientId))
  if (ids.length !== 1) return undefined
  return ids[0]
}

function commaSeparatedUnique(txns: Transaction[], getter: (t: Transaction) => string | undefined): string | undefined {
  const parts = uniqueTrimmedStrings(txns.map(getter))
  if (parts.length === 0) return undefined
  return parts.join(", ")
}

function invoiceNumberFromTransactions(txns: Transaction[]): string | undefined {
  return commaSeparatedUnique(txns, (t) => t.invoiceNumber)
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
      invoiceNumber: invoiceNumberFromTransactions(sorted),
      hasDeliveryNote: sorted.some((t) => !!t.deliveryNoteUrl),
      deliveryNoteUrl: sorted.find((t) => t.deliveryNoteUrl)?.deliveryNoteUrl,
      clientId: clientIdUniformFromTransactions(sorted),
      notesSummary: notesSummaryFromTransactions(sorted),
      fromLocation: uniformTrimmedField(sorted, (t) => t.fromLocation),
      toLocation: uniformTrimmedField(sorted, (t) => t.toLocation),
      assignedToSummary: assignedToSummaryFromTransactions(sorted),
      disposalReasonSummary: commaSeparatedUnique(sorted, (t) => t.disposalReason),
      authorisedBySummary: commaSeparatedUnique(sorted, (t) => t.authorisedBy),
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
