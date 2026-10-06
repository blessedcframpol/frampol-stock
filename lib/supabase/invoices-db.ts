import type { InvoiceEvent, InvoiceState } from "@/lib/invoices"
import { invoiceBatchKey } from "@/lib/invoices"
import type { Transaction } from "@/lib/data"
import type { Database } from "@/lib/supabase/database.types"
import { fetchAllPages } from "@/lib/supabase/postgrest-page"
import type { SupabaseClient } from "@supabase/supabase-js"

type InvoiceRow = Database["public"]["Tables"]["batch_invoices"]["Row"]
type EventRow = Database["public"]["Tables"]["batch_invoice_events"]["Row"]

export function invoiceStateFromRow(row: InvoiceRow): InvoiceState {
  return {
    status: row.status as InvoiceState["status"],
    invoiceNumber: row.invoice_number ?? undefined,
    approval: (row.approval as InvoiceState["approval"]) ?? null,
    legacy: row.legacy,
    notInvoicedReason: row.not_invoiced_reason ?? undefined,
    rejectionReason: row.rejection_reason ?? undefined,
    enteredBy: row.entered_by ?? undefined,
    enteredAt: row.entered_at ?? undefined,
    approvedBy: row.approved_by ?? undefined,
    approvedAt: row.approved_at ?? undefined,
  }
}

export function invoiceEventFromRow(row: EventRow): InvoiceEvent {
  return {
    id: row.id,
    batchId: row.batch_id,
    oldStatus: row.old_status ?? undefined,
    newStatus: row.new_status ?? undefined,
    oldInvoiceNumber: row.old_invoice_number ?? undefined,
    newInvoiceNumber: row.new_invoice_number ?? undefined,
    oldApproval: row.old_approval ?? undefined,
    newApproval: row.new_approval ?? undefined,
    actorId: row.actor_id ?? undefined,
    reason: row.reason ?? undefined,
    createdAt: row.created_at,
  }
}

export async function fetchInvoiceStates(
  supabase: SupabaseClient<Database>,
): Promise<Map<string, InvoiceState>> {
  const rows = await fetchAllPages((from, to) =>
    supabase
      .from("batch_invoices")
      .select("*")
      .order("batch_id", { ascending: true })
      .range(from, to),
  )
  const states = new Map<string, InvoiceState>()
  for (const row of rows) states.set(row.batch_id, invoiceStateFromRow(row))
  return states
}

export function withInvoiceStates<T extends Transaction>(
  transactions: T[],
  states: Map<string, InvoiceState>,
): T[] {
  return transactions.map((txn) => {
    const state = states.get(invoiceBatchKey(txn))
    return state ? { ...txn, invoiceState: state } : txn
  })
}

export async function fetchInvoiceEvents(
  supabase: SupabaseClient<Database>,
  batchId: string,
): Promise<InvoiceEvent[]> {
  const { data, error } = await supabase
    .from("batch_invoice_events")
    .select("*")
    .eq("batch_id", batchId)
    .order("created_at", { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []).map(invoiceEventFromRow)
}
