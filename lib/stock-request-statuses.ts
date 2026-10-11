/**
 * Request review_state values (canonical). Display labels come from
 * public.request_display_status — do not re-implement that in the UI.
 */
export type StockRequestReviewState =
  | "submitted"
  | "awaiting_approval"
  | "rejected"
  | "cancelled"
  | "closed"

export type RequestDisplayStatus =
  | "cancelled"
  | "closed"
  | "rejected"
  | "awaiting_approval"
  | "being_reviewed"
  | "partially_issued"
  | "awaiting_invoice"
  | "completed"

/** Order used by status filters: needs-attention first, finished last. */
export const REQUEST_DISPLAY_STATUSES: readonly RequestDisplayStatus[] = [
  "awaiting_approval",
  "being_reviewed",
  "partially_issued",
  "awaiting_invoice",
  "completed",
  "rejected",
  "closed",
  "cancelled",
]

export const DISPLAY_STATUS_LABELS: Record<RequestDisplayStatus, string> = {
  awaiting_approval: "Awaiting approval",
  being_reviewed: "Being reviewed",
  partially_issued: "Partially issued",
  awaiting_invoice: "Awaiting invoice",
  completed: "Completed",
  rejected: "Rejected",
  closed: "Closed",
  cancelled: "Cancelled",
}

/** Same palette tokens as STATUS_PILL_CLASS in components/fs/status-pill.tsx. */
export const DISPLAY_STATUS_PILL_CLASS: Record<RequestDisplayStatus, string> = {
  awaiting_approval: "bg-warning-soft text-warning",
  being_reviewed: "bg-info-soft text-info",
  partially_issued: "bg-brand/15 text-brand",
  awaiting_invoice: "bg-warning-soft text-warning",
  completed: "bg-success-soft text-success",
  rejected: "bg-danger-soft text-danger",
  closed: "bg-muted text-muted-foreground",
  cancelled: "bg-muted text-muted-foreground",
}

/** Display statuses that still need somebody to act (shown as "open" on a client). */
export const OPEN_DISPLAY_STATUSES: ReadonlySet<RequestDisplayStatus> = new Set<RequestDisplayStatus>([
  "awaiting_approval",
  "being_reviewed",
  "partially_issued",
  "awaiting_invoice",
])

export function isRequestDisplayStatus(value: string | null | undefined): value is RequestDisplayStatus {
  return Boolean(value) && (REQUEST_DISPLAY_STATUSES as readonly string[]).includes(value as string)
}

export function displayStatusLabel(status: string | null | undefined): string {
  return isRequestDisplayStatus(status) ? DISPLAY_STATUS_LABELS[status] : "Unknown"
}

export function displayStatusPillClass(status: string | null | undefined): string {
  return isRequestDisplayStatus(status) ? DISPLAY_STATUS_PILL_CLASS[status] : "bg-muted text-muted-foreground"
}

export type DisplayStatusTone = "success" | "warning" | "info" | "danger" | "brand" | "muted"

export const DISPLAY_STATUS_TONES: Record<RequestDisplayStatus, DisplayStatusTone> = {
  awaiting_approval: "warning",
  being_reviewed: "info",
  partially_issued: "brand",
  awaiting_invoice: "warning",
  completed: "success",
  rejected: "danger",
  closed: "muted",
  cancelled: "muted",
}

/** Semantic tone for a display status; unknown values stay muted. */
export function displayStatusTone(status: string | null | undefined): DisplayStatusTone {
  return isRequestDisplayStatus(status) ? DISPLAY_STATUS_TONES[status] : "muted"
}

export const REJECT_REASON_LABELS: Record<string, string> = {
  insufficient_customer_info: "Insufficient customer info",
  no_atlas_task: "No Atlas task",
  no_invoice: "No invoice",
  other: "Other",
}

export function isStockRequestReviewState(value: string): value is StockRequestReviewState {
  return (
    value === "submitted" ||
    value === "awaiting_approval" ||
    value === "rejected" ||
    value === "cancelled" ||
    value === "closed"
  )
}

/** Labels for review_state when the display status is not available. */
export const REVIEW_STATE_LABELS: Record<StockRequestReviewState, string> = {
  submitted: "Submitted",
  awaiting_approval: "Awaiting approval",
  rejected: "Rejected",
  cancelled: "Cancelled",
  closed: "Closed",
}

/** Display status when the RPC value is missing: falls back to the review_state label. */
export function displayStatusOrReviewState(
  display: string | null | undefined,
  reviewState: string | null | undefined
): RequestDisplayStatus {
  if (isRequestDisplayStatus(display)) return display
  if (reviewState === "rejected" || reviewState === "cancelled" || reviewState === "closed") return reviewState
  if (reviewState === "awaiting_approval") return "awaiting_approval"
  return "being_reviewed"
}

/** List/detail invoice column: number / Pending / Awaiting approval / Not invoiced · kind. */
export function requestInvoiceColumnLabel(row: {
  invoice_status: string
  invoice_number?: string | null
  invoice_approval?: string | null
  not_invoiced_kind?: string | null
}): string {
  if (row.invoice_status === "invoiced") {
    const n = row.invoice_number?.trim()
    return n || "—"
  }
  if (row.invoice_status === "pending") return "Pending"
  if (row.invoice_approval === "awaiting") return "Awaiting approval"
  if (row.not_invoiced_kind === "internal") return "Not invoiced · Internal"
  if (row.not_invoiced_kind === "complimentary") return "Not invoiced · Complimentary"
  return "Not invoiced"
}

/** Compact line summary: first qty uses ×, later lines use +. */
export function requestItemsSummary(
  lines: ReadonlyArray<{ product_name: string; quantity_requested: number; sort_order?: number }>
): string {
  const ordered = [...lines].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
  if (ordered.length === 0) return "—"
  return ordered
    .map((line, index) => {
      const qty = line.quantity_requested
      const mark = index === 0 ? "×" : "+"
      return `${line.product_name} ${mark}${qty}`
    })
    .join(", ")
}
