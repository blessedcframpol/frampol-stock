import { isOverdue, returnAgeDays } from "@/lib/alerts"
import { INTERNAL_LOCATIONS, type InventoryItem } from "@/lib/data"
import { invoiceChoiceProblem, type InvoiceChoice } from "@/lib/invoices"
import { latestRentalStart } from "@/lib/rental-conversion"

/** Messages match public.bulk_resolve_holdings. */
export const RESOLVE_NOT_ON_LEDGER = "This kit is not on the ledger"
export const RESOLVE_NOT_OVERDUE = "Only overdue POC and Rented kits can be resolved here"
export const RESOLVE_CHOOSE_ACTION = "Choose Returned, Sold, or Leave"
export const RESOLVE_DUPLICATE = "This kit is already in this resolve"
export const RESOLVE_NO_DISPATCH = "This kit has no dispatch date"
export const RESOLVE_RETURN_BOUNDS = "Date returned must be between the dispatch date and today"
export const RESOLVE_RETURN_LAST = "Date returned cannot be before this kit's last movement"
export const RESOLVE_SALE_BOUNDS = "Sale date must be between the dispatch date and today"
export const RESOLVE_SALE_LAST = "Sale date cannot be before this kit's last movement"
export const RESOLVE_WAREHOUSE = "Choose a warehouse"
export const RESOLVE_POOL = "Choose Back in sellable stock or Demo unit, not for sale"
export const RESOLVE_CATEGORY = "Choose Client cancelled or Service termination"
export const RESOLVE_REASON = "Enter a reason"
export const RESOLVE_STARLINK = "Convert to sale is only for Starlink kits"
export const RESOLVE_RENTAL_START = "Convert to sale needs the rental start"
export const RESOLVE_RENTAL_END = "Rental end date must be between the rental start and today"
export const RESOLVE_SALE_BEFORE_END = "Sale date cannot be before the rental end date"

const DAY = /^\d{4}-\d{2}-\d{2}$/
const WAREHOUSES = new Set<string>(INTERNAL_LOCATIONS)
const CATEGORIES = new Set(["Client cancelled", "Service termination"])

export type ResolveAction = "returned" | "sold" | "leave"

export type ResolveDraft = {
  serialNumber: string
  kind: "POC" | "Rental"
  client: string
  dueDate: string
  daysOverdue: number
  dispatchDate: string
  lastMovementDate: string
  rentalStart: string
  starlink: boolean
  action: ResolveAction
  actionDate: string
  location: string
  returnPool: "" | "sale" | "demo"
  reasonCategory: string
  reasonText: string
  invoiceChoice: InvoiceChoice | ""
  invoiceNumber: string
  invoiceReason: string
  rentalEnd: string
  rentalEndTouched: boolean
  serverErrors: string[]
}

type LedgerTxn = { type: string; serialNumber: string; date: string }

export function isOverdueHolding(
  item: Pick<InventoryItem, "status" | "returnDate" | "deletedAt">,
  today: string,
): boolean {
  if (item.deletedAt) return false
  if (item.status !== "POC" && item.status !== "Rented") return false
  const due = item.returnDate?.slice(0, 10) ?? ""
  return DAY.test(due) && isOverdue(due, today)
}

function lastMovementDate(transactions: readonly LedgerTxn[], serial: string): string {
  let best = ""
  for (const txn of transactions) {
    if (txn.serialNumber !== serial) continue
    const day = txn.date.slice(0, 10)
    if (!DAY.test(day) || day <= best) continue
    best = day
  }
  return best
}

function latestPocOut(transactions: readonly LedgerTxn[], serial: string): string {
  let best = ""
  for (const txn of transactions) {
    if (txn.type !== "POC Out" || txn.serialNumber !== serial) continue
    const day = txn.date.slice(0, 10)
    if (!DAY.test(day) || day <= best) continue
    best = day
  }
  return best
}

export function resolveDraftFromItem(
  item: InventoryItem,
  transactions: readonly LedgerTxn[],
  today: string,
): ResolveDraft | null {
  if (!isOverdueHolding(item, today)) return null
  const due = item.returnDate!.slice(0, 10)
  const rentalStart = latestRentalStart(transactions, item.serialNumber) ?? ""
  const pocOut = item.pocOutDate?.slice(0, 10) ?? ""
  const dispatchDate =
    item.status === "Rented"
      ? rentalStart || (DAY.test(pocOut) ? pocOut : "")
      : DAY.test(pocOut)
        ? pocOut
        : latestPocOut(transactions, item.serialNumber)
  return {
    serialNumber: item.serialNumber,
    kind: item.status === "Rented" ? "Rental" : "POC",
    client: item.client?.trim() || "—",
    dueDate: due,
    daysOverdue: returnAgeDays(due, today),
    dispatchDate,
    lastMovementDate: lastMovementDate(transactions, item.serialNumber),
    rentalStart,
    starlink: item.vendor === "Starlink",
    action: "leave",
    actionDate: today.slice(0, 10),
    location: "",
    returnPool: "",
    reasonCategory: "",
    reasonText: "",
    invoiceChoice: "",
    invoiceNumber: "",
    invoiceReason: "",
    rentalEnd: today.slice(0, 10),
    rentalEndTouched: false,
    serverErrors: [],
  }
}

export function resolveRowProblems(draft: ResolveDraft, today: string): string[] {
  if (draft.action === "leave") return []
  const messages: string[] = []
  const day = today.slice(0, 10)
  const date = draft.actionDate.slice(0, 10)
  const dispatch = draft.dispatchDate.slice(0, 10)
  const last = draft.lastMovementDate.slice(0, 10)
  const bounds = draft.action === "returned" ? RESOLVE_RETURN_BOUNDS : RESOLVE_SALE_BOUNDS
  const beforeLast = draft.action === "returned" ? RESOLVE_RETURN_LAST : RESOLVE_SALE_LAST
  if (!DAY.test(dispatch)) messages.push(RESOLVE_NO_DISPATCH)
  if (!DAY.test(date) || date > day || (DAY.test(dispatch) && date < dispatch)) messages.push(bounds)
  if (DAY.test(date) && DAY.test(last) && date < last) messages.push(beforeLast)

  if (draft.action === "returned") {
    if (!WAREHOUSES.has(draft.location)) messages.push(RESOLVE_WAREHOUSE)
    if (draft.kind === "POC" && draft.returnPool !== "sale" && draft.returnPool !== "demo") {
      messages.push(RESOLVE_POOL)
    }
    if (draft.kind === "Rental") {
      if (!CATEGORIES.has(draft.reasonCategory)) messages.push(RESOLVE_CATEGORY)
      if (!draft.reasonText.trim()) messages.push(RESOLVE_REASON)
    }
    return messages
  }

  const choiceProblem = invoiceChoiceProblem(draft.invoiceChoice, draft.invoiceNumber, draft.invoiceReason)
  if (choiceProblem) messages.push(choiceProblem)
  if (draft.kind === "Rental") {
    if (!draft.starlink) messages.push(RESOLVE_STARLINK)
    const start = draft.rentalStart.slice(0, 10)
    const end = (draft.rentalEnd || date).slice(0, 10)
    if (!DAY.test(start)) messages.push(RESOLVE_RENTAL_START)
    else if (!DAY.test(end) || end < start || end > day) messages.push(RESOLVE_RENTAL_END)
    if (DAY.test(date) && DAY.test(end) && date < end) messages.push(RESOLVE_SALE_BEFORE_END)
  }
  return messages
}

export function resolveHoldingRow(draft: ResolveDraft): Record<string, string> {
  const row: Record<string, string> = {
    serial_number: draft.serialNumber,
    action: draft.action,
  }
  if (draft.action === "leave") return row
  row.action_date = draft.actionDate.slice(0, 10)
  if (draft.action === "returned") {
    row.location = draft.location
    if (draft.kind === "POC") row.return_pool = draft.returnPool
    if (draft.kind === "Rental") {
      row.reason_category = draft.reasonCategory
      row.reason_text = draft.reasonText.trim()
    }
    return row
  }
  if (draft.invoiceChoice) row.invoice_choice = draft.invoiceChoice
  if (draft.invoiceChoice === "number") row.invoice_number = draft.invoiceNumber.trim()
  if (draft.invoiceChoice === "not_invoiced") row.invoice_reason = draft.invoiceReason.trim()
  if (draft.kind === "Rental") row.rental_end = (draft.rentalEnd || draft.actionDate).slice(0, 10)
  return row
}

export type BulkResolveResult = {
  ok: boolean
  returned: number
  sold: number
  inspection: number
  awaitingApproval: number
  errors: { serial: string; messages: string[] }[]
  batches: { serial: string; batchId: string; type: string }[]
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function messageList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === "string" && entry !== "")
}

export function readBulkResolveResult(data: unknown): BulkResolveResult | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  const row = data as Record<string, unknown>
  if (typeof row.ok !== "boolean") return null
  const errors = Array.isArray(row.errors)
    ? row.errors.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return []
        const error = entry as Record<string, unknown>
        const serial = typeof error.serial === "string" ? error.serial : ""
        return [{ serial, messages: messageList(error.messages) }]
      })
    : []
  const batches = Array.isArray(row.batches)
    ? row.batches.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return []
        const batch = entry as Record<string, unknown>
        if (typeof batch.serial !== "string" || typeof batch.batch_id !== "string") return []
        return [{ serial: batch.serial, batchId: batch.batch_id, type: typeof batch.type === "string" ? batch.type : "" }]
      })
    : []
  return {
    ok: row.ok,
    returned: numberField(row.returned),
    sold: numberField(row.sold),
    inspection: numberField(row.inspection),
    awaitingApproval: numberField(row.awaiting_approval),
    errors,
    batches,
  }
}

export function resolveSummaryText(result: Pick<BulkResolveResult, "returned" | "sold" | "inspection" | "awaitingApproval">): string {
  return `${result.returned} returned, ${result.sold} sold, ${result.inspection} to inspection, ${result.awaitingApproval} awaiting invoice approval`
}
