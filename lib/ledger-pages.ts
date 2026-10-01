import { isQuickScanStockReversibleMovement } from "@/lib/quick-scan-reversal-inventory"
import { canExportAllTransactions, canReverseQuickScanBatches, type AppRole } from "@/lib/permissions"

export const LEDGER_PAGE_SIZE = 24

export const DISPATCHED_MOVEMENTS = ["Sale", "POC Out", "Rentals", "Dispose"] as const

export type MovementCounts = Record<string, number>

/** Total for the active movement. Null movement is every chip, including unnamed rows. */
export function filteredTotal(counts: MovementCounts, movement: string | null | undefined): number {
  if (!movement) {
    return Object.values(counts).reduce((sum, count) => sum + count, 0)
  }
  return counts[movement] ?? 0
}

export function pageCount(total: number, pageSize = LEDGER_PAGE_SIZE): number {
  if (!Number.isFinite(total) || total <= 0) return 1
  return Math.max(1, Math.ceil(total / pageSize))
}

/** Chips that have rows, plus the one the user already selected. */
export function movementChipIds(counts: MovementCounts, selected: string | null, order: readonly string[]): string[] {
  const present = new Set(Object.entries(counts).filter(([, count]) => count > 0).map(([movement]) => movement))
  if (selected) present.add(selected)
  const known = order.filter((movement) => present.has(movement))
  const rest = [...present].filter((movement) => movement && !order.includes(movement)).sort()
  return [...known, ...rest]
}

export type ReversalAffordanceInput = {
  role: AppRole | null | undefined
  isReversed: boolean
  movementType: string
  reverseBatchId: string | null
  reversesBatchId?: string | null
  reversedByBatchId?: string | null
}

export type ReversalAffordances = {
  showReverse: boolean
  showReversedPill: boolean
  showExport: boolean
  /** Batch id to open when this row points at the other side of a reversal. */
  linksToBatchId: string | null
}

export function reversalAffordances(input: ReversalAffordanceInput): ReversalAffordances {
  const canReverse = canReverseQuickScanBatches(input.role)
  const linksToBatchId = input.isReversed
    ? input.reversedByBatchId?.trim() || null
    : input.movementType === "Reversal"
      ? input.reversesBatchId?.trim() || null
      : null
  return {
    showReverse:
      canReverse &&
      !input.isReversed &&
      Boolean(input.reverseBatchId?.trim()) &&
      isQuickScanStockReversibleMovement(input.movementType),
    showReversedPill: input.isReversed && input.movementType !== "Reversal",
    showExport: canExportAllTransactions(input.role),
    linksToBatchId,
  }
}

/** Fields that identify a dispatch. A hit on any of these keeps the batch as one row. */
export const DISPATCH_BATCH_FIELDS = ["product", "client", "invoice", "movement", "batchId"] as const

export type DispatchMember = {
  serial: string
  product: string
  client: string
  invoice: string
  movement: string
  batchId: string
}

/**
 * How one dispatch appears for a search.
 * No needle, or any batch-level hit, is one batch row.
 * A serial-number hit with no batch-level hit is one row per matching serial.
 */
export function dispatchRowsForBatch(members: readonly DispatchMember[], needle: string | null | undefined): Array<"batch" | "serial"> {
  const normalized = needle?.trim().toLowerCase() ?? ""
  if (!normalized || members.length === 0) return members.length === 0 ? [] : ["batch"]
  const batchLevel = members.some((member) =>
    [member.product, member.client, member.invoice, member.movement, member.batchId].some((field) =>
      field.toLowerCase().includes(normalized),
    ),
  )
  if (batchLevel) return ["batch"]
  return members.filter((member) => member.serial.toLowerCase().includes(normalized)).map(() => "serial" as const)
}

export function dispatchResultLabel(total: number, kind: "batch" | "serial" | "mixed"): string {
  if (kind === "serial") return `${total} ${total === 1 ? "serial" : "serials"}`
  if (kind === "mixed") return `${total} ${total === 1 ? "result" : "results"}`
  return `${total} ${total === 1 ? "dispatch" : "dispatches"}`
}
