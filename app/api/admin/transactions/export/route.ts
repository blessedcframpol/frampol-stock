import { NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error-response"
import { requireAdmin } from "@/lib/require-admin"
import { buildCsvFilename } from "@/lib/utils"
import { rowToTransaction } from "@/lib/supabase/inventory-db"
import { displayedInvoice } from "@/lib/invoices"
import { fetchInvoiceStates, withInvoiceStates } from "@/lib/supabase/invoices-db"
import { rentalDaysFromMetadata } from "@/lib/rental-conversion"
import { fetchAllPages } from "@/lib/supabase/postgrest-page"

function csvEscape(value: unknown): string {
  if (value == null) return ""
  return String(value).replace(/"/g, '""')
}

function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map((cell) => `"${csvEscape(cell)}"`).join(",")).join("\n")
}

export async function GET() {
  try {
    const auth = await requireAdmin({
      logLabel: "admin transactions export GET",
      forbiddenMessage: "Only admins can export all transactions",
    })
    if (!auth.ok) return auth.response
    const { supabase } = auth

    const countActive = async () => {
      const { count, error } = await supabase
        .from("active_transactions")
        .select("id", { count: "exact", head: true })
      if (error) throw new Error(error.message)
      if (count == null) throw new Error("Active transaction count was missing")
      return count
    }
    const countBefore = await countActive()
    const txnRows = await fetchAllPages((from, to) =>
      supabase
        .from("active_transactions")
        .select("*")
        .order("date", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to)
    )
    const countAfter = await countActive()
    const invoiceStates = await fetchInvoiceStates(supabase)
    const transactions = withInvoiceStates(txnRows.map(rowToTransaction), invoiceStates)
    if (transactions.length !== countBefore || transactions.length !== countAfter) {
      return apiErrorResponse(409, "Export row count did not match active transactions", {
        detail: `CSV rows ${transactions.length}, active before ${countBefore}, active after ${countAfter}`,
        logLabel: "admin transactions export count",
      })
    }
    const rows: string[][] = [
      [
        "ID",
        "Date",
        "Type",
        "Serial Number",
        "Item Name",
        "Client",
        "Client ID",
        "Invoice Number",
        "Invoice status",
        "Rental days",
        "From Location",
        "To Location",
        "Assigned To",
        "Disposal Reason",
        "Authorised By",
        "Batch ID",
        "Delivery Note URL",
        "Notes",
        "Created By",
        "Metadata",
        "Recorded At",
      ],
    ]

    for (const txn of transactions) {
      rows.push([
        txn.id,
        txn.date,
        txn.type,
        txn.serialNumber,
        txn.itemName,
        txn.client,
        txn.clientId ?? "",
        displayedInvoice(txn) === "—" ? "" : displayedInvoice(txn),
        txn.invoiceState?.status ?? "",
        rentalDaysFromMetadata(txn.metadata)?.toString() ?? "",
        txn.fromLocation ?? "",
        txn.toLocation ?? "",
        txn.assignedTo ?? "",
        txn.disposalReason ?? "",
        txn.authorisedBy ?? "",
        txn.batchId ?? "",
        txn.deliveryNoteUrl ?? "",
        txn.notes ?? "",
        txn.createdBy ?? "",
        txn.metadata == null ? "" : JSON.stringify(txn.metadata),
        txn.createdAt ?? "",
      ])
    }

    const csv = `\uFEFF${toCsv(rows)}`
    const filename = buildCsvFilename(
      ["all transactions", String(transactions.length)],
      new Date().toISOString()
    )
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Transaction-Count": String(transactions.length),
      },
    })
  } catch (error) {
    return apiErrorResponse(500, "Failed to export transactions", {
      cause: error,
      logLabel: "admin transactions export GET",
    })
  }
}
