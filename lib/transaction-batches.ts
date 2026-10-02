import type { Transaction, TransactionType } from "@/lib/data"
import { compareBusinessDatesDesc, latestRecordedAt } from "@/lib/business-date.mjs"
import { getTransactionOrderGroupKey } from "@/lib/client-transactions"

/** One logical submission / batch for history UI (matches grouped `transactions` rows). */
export type TransactionBatchSummary = {
  /** Stable key for React lists */
  batchKey: string
  /** `transactions.batch_id` when present — use for quick-scan reverse lookup */
  reverseBatchId: string | null
  date: string
  /** Latest recorded instant in the batch, when any row has created_at. */
  recordedAt?: string
  movementType: TransactionType
  productLabel: string
  clientDisplay: string
  count: number
  serials: string[]
  isReversed: boolean
  reversalReason?: string
  reversedAt?: string
  reversedByName?: string
  reversalKind?: "reversal" | "void"
  /** Unknown previous statuses the admin must confirm before reversing. */
  confirmRows?: { transactionId: string; serial: string; previousStatus: string }[]
  /** When movementType is Reversal: the batch that was undone. */
  reversesBatchId?: string
  /** When movementType is Reversal: original movement type (Inbound, Sale, etc.). */
  originalMovementType?: TransactionType
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
  /** The reversal batch that undid this one, when a reversal row points here. */
  reversedByBatchId?: string | null
  /** Display names of the people who recorded the member rows. */
  recordedBy?: string
  /** Member rows already loaded for this page. */
  lines?: TransactionBatchLine[]
}

export type TransactionBatchLine = {
  serialNumber: string
  client: string
  invoiceNumber?: string
  date: string
  recordedAt?: string
  assignedTo?: string
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

type ReversalTxnMeta = {
  reversedBatchId?: string
  originalMovementType?: string
  returnLocation?: string
  serialNumbers?: string[]
  itemCount?: number
}

function parseReversalTxnMeta(metadata: Transaction["metadata"]): ReversalTxnMeta {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {}
  const m = metadata as Record<string, unknown>
  const serialNumbers = Array.isArray(m.serialNumbers)
    ? m.serialNumbers.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : undefined
  return {
    reversedBatchId: typeof m.reversedBatchId === "string" ? m.reversedBatchId : undefined,
    originalMovementType:
      typeof m.originalMovementType === "string" ? m.originalMovementType : undefined,
    returnLocation: typeof m.returnLocation === "string" ? m.returnLocation : undefined,
    serialNumbers,
    itemCount: typeof m.itemCount === "number" ? m.itemCount : undefined,
  }
}

function asTransactionType(value: string | undefined): TransactionType | undefined {
  if (!value) return undefined
  const allowed: TransactionType[] = [
    "Inbound",
    "Sale",
    "POC Out",
    "POC Return",
    "Rental Return",
    "Sale Return",
    "Transfer",
    "Dispose",
    "Rentals",
    "Decommissioned",
    "Inspection Pass",
    "Inspection Fail",
    "Remediation Loaner Issue",
    "Reversal",
  ]
  return allowed.includes(value as TransactionType) ? (value as TransactionType) : undefined
}

/**
 * Group flat transaction rows into batch summaries (same rules as client order grouping).
 */
export function groupTransactionsIntoBatches(
  transactions: Transaction[],
  reversalByBatchId: Map<
    string,
    { reversedAt: string; reversalReason?: string; reversedByName?: string; kind?: string }
  >
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
    const sorted = [...txns].sort((a, b) => compareBusinessDatesDesc(a.date, b.date))
    const first = sorted[0]!
    const batchId = first.batchId ?? null
    const rev = batchId ? reversalByBatchId.get(batchId) : undefined
    const reversalMeta = first.type === "Reversal" ? parseReversalTxnMeta(first.metadata) : {}
    const originalMovementType = asTransactionType(reversalMeta.originalMovementType)
    const reversalSerials =
      first.type === "Reversal" && reversalMeta.serialNumbers?.length
        ? [...reversalMeta.serialNumbers].sort()
        : sorted.map((t) => t.serialNumber)
    const reversalCount =
      first.type === "Reversal"
        ? (reversalMeta.itemCount ?? reversalSerials.length)
        : sorted.length
    out.push({
      batchKey,
      reverseBatchId: batchId,
      date: first.date,
      recordedAt: latestRecordedAt(sorted.map((txn) => txn.createdAt)),
      movementType: first.type,
      productLabel: productLabelFromTransactions(sorted),
      clientDisplay: clientDisplayFromTransactions(sorted),
      count: reversalCount,
      serials: reversalSerials,
      isReversed: !!rev,
      reversalReason:
        first.type === "Reversal" ? notesSummaryFromTransactions(sorted) ?? rev?.reversalReason : rev?.reversalReason,
      reversedAt: rev?.reversedAt,
      reversedByName: rev?.reversedByName,
      reversalKind: rev?.kind === "void" ? "void" : rev ? "reversal" : undefined,
      confirmRows: sorted
        .filter((txn) => txn.previousStatusSource === "unknown" && txn.previousStatus)
        .map((txn) => ({
          transactionId: txn.id,
          serial: txn.serialNumber,
          previousStatus: txn.previousStatus as string,
        })),
      reversesBatchId: reversalMeta.reversedBatchId,
      originalMovementType,
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
    return compareBusinessDatesDesc(a.date, b.date)
  })
  return out
}

/** Matches the database function's maximum page of complete batches. */
export const TRANSACTION_BATCH_PAGE_SIZE = 100

export type TransactionBatchQuery = {
  limit?: number
  offset?: number
  movement?: string | null
  from?: string | null
  to?: string | null
  search?: string | null
  /** When true, the page contains only batches in active_transactions. */
  active?: boolean
}

export async function fetchTransactionBatchPage(
  query: TransactionBatchQuery = {}
): Promise<{ batches: TransactionBatchSummary[]; total: number; counts: Record<string, number> }> {
  const params = new URLSearchParams()
  params.set("limit", String(query.limit ?? TRANSACTION_BATCH_PAGE_SIZE))
  params.set("offset", String(query.offset ?? 0))
  if (query.movement) params.set("movement", query.movement)
  if (query.from) params.set("from", query.from)
  if (query.to) params.set("to", query.to)
  if (query.search) params.set("search", query.search)
  if (query.active) params.set("active", "1")
  const res = await fetch(`/api/transaction-batches?${params.toString()}`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const error = new Error(
      typeof data?.error === "string" ? data.error : "Failed to load transaction history"
    ) as Error & { status?: number; body?: unknown }
    error.status = res.status
    error.body = data
    throw error
  }
  if (!data || !Array.isArray(data.batches) || typeof data.total !== "number" || !data.counts || typeof data.counts !== "object") {
    throw new Error("Transaction history returned an unexpected page")
  }
  return {
    batches: data.batches as TransactionBatchSummary[],
    total: data.total,
    counts: data.counts as Record<string, number>,
  }
}

/** Every batch, each one complete. Pages until the reported total is in hand. */
export async function fetchEveryTransactionBatch(): Promise<TransactionBatchSummary[]> {
  const all: TransactionBatchSummary[] = []
  let total = 0
  for (let offset = 0; ; offset += TRANSACTION_BATCH_PAGE_SIZE) {
    const page = await fetchTransactionBatchPage({ limit: TRANSACTION_BATCH_PAGE_SIZE, offset })
    total = page.total
    all.push(...page.batches)
    if (page.batches.length < TRANSACTION_BATCH_PAGE_SIZE || all.length >= total) break
  }
  if (all.length !== total) {
    throw new Error(`Transaction history loaded ${all.length} of ${total} batches`)
  }
  return all
}
