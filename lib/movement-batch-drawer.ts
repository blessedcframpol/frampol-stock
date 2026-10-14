import type { InvoiceState } from "@/lib/invoices"
import type { BatchRequestContext } from "@/lib/batch-request-context"

export type MovementBatchTimelineEntry = {
  at: string
  actorId: string | null
  kind: string
  title: string
  detail?: string | null
  changeFrom?: string | null
  changeTo?: string | null
  reason?: string | null
  actorName?: string
}

export type MovementBatchDrawerLine = {
  serialNumber: string
  productName?: string
  status?: string
  assignedTo?: string
  stockPool?: string | null
  cloudKey?: string | null
  requiresCloudKey?: boolean
}

export type MovementBatchDrawerPayload = {
  batchId: string
  batchKey: string
  movementType: string
  originalMovementType?: string
  date: string
  recordedAt?: string
  count: number
  productLabel: string
  clientDisplay: string
  clientId?: string
  invoiceState?: InvoiceState
  invoiceBatchId?: string
  invoiceNumber?: string
  deliveryNoteUrl?: string
  notesSummary?: string
  request?: BatchRequestContext | null
  recordedBy?: string
  recordedById?: string | null
  isReversed?: boolean
  reversalKind?: "reversal" | "void"
  lines: MovementBatchDrawerLine[]
  timeline: MovementBatchTimelineEntry[]
}

/** Header: "Sale · 3 × Starlink …" or mixed products. */
export function movementBatchDrawerTitle(payload: {
  movementType: string
  originalMovementType?: string
  count: number
  productLabel: string
  lines: MovementBatchDrawerLine[]
}): string {
  const movement =
    payload.movementType === "Reversal" && payload.originalMovementType
      ? `Reversal of ${payload.originalMovementType}`
      : payload.movementType || "Movement"
  const products = [
    ...new Set(
      payload.lines.map((line) => line.productName?.trim()).filter((name): name is string => Boolean(name)),
    ),
  ].sort()
  if (products.length === 0) {
    return `${movement} · ${payload.count} item${payload.count === 1 ? "" : "s"}`
  }
  if (products.length === 1) {
    return `${movement} · ${payload.count} × ${products[0]}`
  }
  return `${movement} · ${payload.count} items · ${products.length} products`
}

export function invoicePendingDays(enteredAt: string | undefined, timeZone: string): number | null {
  if (!enteredAt) return null
  const start = new Date(enteredAt)
  if (Number.isNaN(start.getTime())) return null
  const now = new Date()
  const startDay = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(start)
  const today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
  const parse = (d: string) => {
    const [y, m, day] = d.split("-").map(Number)
    return Date.UTC(y!, m! - 1, day!)
  }
  return Math.max(0, Math.floor((parse(today) - parse(startDay)) / 86_400_000))
}

export function movementBatchStatePill(payload: {
  isReversed?: boolean
  reversalKind?: "reversal" | "void"
  invoiceState?: InvoiceState
  enteredAt?: string
  timeZone: string
}): string | null {
  if (payload.isReversed) {
    return payload.reversalKind === "void" ? "Voided" : "Reversed"
  }
  const state = payload.invoiceState
  if (!state) return null
  if (state.status === "invoiced") return "Invoiced"
  if (state.approval === "awaiting") return "Awaiting approval"
  if (state.status === "pending") {
    const days = invoicePendingDays(state.enteredAt, payload.timeZone)
    return days != null ? `Invoice pending · ${days} day${days === 1 ? "" : "s"}` : "Invoice pending"
  }
  if (state.status === "legacy_unreviewed") return "Legacy unreviewed"
  return null
}
