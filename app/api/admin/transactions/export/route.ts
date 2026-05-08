import { NextResponse } from "next/server"
import { apiClientError, apiErrorResponse } from "@/lib/api-error-response"
import { buildCsvFilename } from "@/lib/utils"
import { rowToTransaction } from "@/lib/supabase/inventory-db"
import { createServerSupabaseClient } from "@/lib/supabase/server"

function csvEscape(value: unknown): string {
  if (value == null) return ""
  return String(value).replace(/"/g, '""')
}

function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map((cell) => `"${csvEscape(cell)}"`).join(",")).join("\n")
}

export async function GET() {
  try {
    const supabase = await createServerSupabaseClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      return apiClientError(401, "Unauthorized", { log: "warn", logLabel: "admin transactions export GET" })
    }

    const { data: profileRow } = await supabase
      .from("profiles")
      .select("role, active")
      .eq("id", user.id)
      .single()
    const profile = profileRow as { role: string | null; active: boolean } | null
    if (!profile?.active || profile.role !== "admin") {
      return apiClientError(403, "Only admins can export all transactions", {
        log: "warn",
        logLabel: "admin transactions export GET",
      })
    }

    const { data: txnRows, error: txnError } = await supabase
      .from("transactions")
      .select("*")
      .order("date", { ascending: false })
    if (txnError) {
      return apiErrorResponse(500, "Failed to load transactions for export", {
        cause: txnError,
        logLabel: "admin transactions export query",
      })
    }

    const transactions = (txnRows ?? []).map(rowToTransaction)
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
        txn.invoiceNumber ?? "",
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
      ])
    }

    const csv = `\uFEFF${toCsv(rows)}`
    const filename = buildCsvFilename(["all transactions"], new Date().toISOString())
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    })
  } catch (error) {
    return apiErrorResponse(500, "Failed to export transactions", {
      cause: error,
      logLabel: "admin transactions export GET",
    })
  }
}
