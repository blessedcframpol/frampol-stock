import type { Transaction } from "@/lib/data"

export const INVOICE_CHOICES = ["number", "pending", "not_invoiced"] as const
export type InvoiceChoice = (typeof INVOICE_CHOICES)[number]
export type InvoiceStatus = "invoiced" | "pending" | "not_invoiced" | "legacy_unreviewed"
export type InvoiceApproval = "awaiting" | "approved" | "rejected"

export type InvoiceState = {
  status: InvoiceStatus
  invoiceNumber?: string
  approval?: InvoiceApproval | null
  legacy?: boolean
  notInvoicedReason?: string
  rejectionReason?: string
  enteredBy?: string
  enteredAt?: string
  approvedBy?: string
  approvedAt?: string
}

export type InvoiceEvent = {
  id: string
  batchId: string
  oldStatus?: string
  newStatus?: string
  oldInvoiceNumber?: string
  newInvoiceNumber?: string
  oldApproval?: string
  newApproval?: string
  actorId?: string
  reason?: string
  createdAt: string
}

export function invoiceBatchKey(txn: Pick<Transaction, "id" | "batchId">): string {
  const batch = txn.batchId?.trim()
  return batch || txn.id
}

/** Same rejections as public.real_invoice_number_problem. */
export function realInvoiceNumberProblem(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return "Invoice number is required"
  if (trimmed === "-" || trimmed.toUpperCase() === "N/A" || trimmed.toUpperCase() === "NA") {
    return "That invoice value is a placeholder"
  }
  if (/^0+$/.test(trimmed)) {
    return trimmed === "00000" ? "00000 is not an invoice number" : "That invoice value is a placeholder"
  }
  return null
}

/** Sale and Rentals must pick a number, Invoice pending, or 00000 with a reason. */
export function invoiceChoiceProblem(
  choice: InvoiceChoice | "",
  invoiceNumber: string,
  reason: string,
): string | null {
  if (choice === "number") return realInvoiceNumberProblem(invoiceNumber)
  if (choice === "pending") {
    return invoiceNumber.trim() ? "Invoice pending does not take a number" : null
  }
  if (choice === "not_invoiced") {
    return reason.trim().length < 15 ? "00000 needs a reason of at least 15 characters" : null
  }
  return "Sale and Rentals need an invoice number, Invoice pending, or 00000 — not invoiced"
}

export function invoiceStateLabel(state: InvoiceState | null | undefined): string {
  if (!state) return "Not invoiced"
  if (state.status === "invoiced") return displayInvoiceNumber(state.invoiceNumber)
  if (state.status === "pending") return "Pending"
  if (state.status === "legacy_unreviewed") return "Legacy"
  if (state.approval === "awaiting") return "Awaiting approval"
  if (state.approval === "approved") return "Not invoiced"
  return "Not invoiced"
}

/** Never a raw 00000 or a blank invoice cell. */
export function displayInvoiceNumber(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim()
  if (!trimmed) return "Not invoiced"
  if (/^0+$/.test(trimmed)) return "Legacy"
  return trimmed
}

/** Sale and Rentals show the batch invoice. Other movements keep the stored column, never 00000. */
export function displayedInvoice(txn: Pick<Transaction, "type" | "invoiceNumber" | "invoiceState">): string {
  if (txn.invoiceState) return invoiceStateLabel(txn.invoiceState)
  if (txn.type === "Sale" || txn.type === "Rentals") {
    return displayInvoiceNumber(txn.invoiceNumber)
  }
  const trimmed = (txn.invoiceNumber ?? "").trim()
  if (!trimmed) return "—"
  if (/^0+$/.test(trimmed)) return "Legacy"
  return trimmed
}

export function invoiceEventLabel(event: InvoiceEvent): string {
  const from = event.oldStatus ?? "none"
  const to = event.newStatus ?? "none"
  const number = event.newInvoiceNumber?.trim()
  const reason = event.reason?.trim()
  const parts = [`${from} → ${to}`]
  if (number) parts.push(number)
  if (event.newApproval) parts.push(event.newApproval)
  if (reason) parts.push(reason)
  return parts.join(" · ")
}
