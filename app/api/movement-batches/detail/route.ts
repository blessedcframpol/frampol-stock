import { NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error-response"
import { requestLookupBatchId, loadBatchRequestContext } from "@/lib/batch-request-context"
import { getTransactionOrderGroupKey } from "@/lib/client-transactions"
import { loadProfileLabels } from "@/lib/profile-labels"
import { invoiceBatchKey } from "@/lib/invoices"
import { invoiceStateFromRow } from "@/lib/supabase/invoices-db"
import { rowToTransaction } from "@/lib/supabase/inventory-db"
import { fetchAllPages } from "@/lib/supabase/postgrest-page"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import type { Json } from "@/lib/supabase/database.types"
import type { MovementBatchDrawerLine, MovementBatchTimelineEntry } from "@/lib/movement-batch-drawer"

function parseTimeline(data: Json | null): MovementBatchTimelineEntry[] {
  if (!Array.isArray(data)) return []
  const out: MovementBatchTimelineEntry[] = []
  for (const row of data) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue
    const at = row.at
    if (typeof at !== "string") continue
    out.push({
      at,
      actorId: typeof row.actorId === "string" ? row.actorId : null,
      kind: typeof row.kind === "string" ? row.kind : "event",
      title: typeof row.title === "string" ? row.title : "Event",
      detail: typeof row.detail === "string" ? row.detail : null,
      changeFrom: typeof row.changeFrom === "string" ? row.changeFrom : null,
      changeTo: typeof row.changeTo === "string" ? row.changeTo : null,
      reason: typeof row.reason === "string" ? row.reason : null,
    })
  }
  return out
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const batchKey = url.searchParams.get("batchKey")?.trim()
    if (!batchKey) {
      return apiErrorResponse(400, "batchKey is required", { logLabel: "movement-batch detail" })
    }
    const batchId = requestLookupBatchId(batchKey)
    if (!batchId) {
      return apiErrorResponse(400, "Invalid batch key", { logLabel: "movement-batch detail" })
    }

    const supabase = await createServerSupabaseClient()
    const txnRows = await fetchAllPages((from, to) =>
      supabase
        .from("active_transactions")
        .select("*")
        .or(`batch_id.eq.${batchId},id.eq.${batchId}`)
        .order("date", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to),
    )
    const transactions = txnRows.map(rowToTransaction)
    if (transactions.length === 0) {
      return apiErrorResponse(404, "Batch not found", { logLabel: "movement-batch detail" })
    }

    const first = transactions[0]!
    const serials = [...new Set(transactions.map((txn) => txn.serialNumber))]
    const itemRows = await fetchAllPages((from, to) =>
      supabase
        .from("inventory_items")
        .select("serial_number, status, assigned_to, stock_pool, cloud_key, product_lines(product_name, vendor, requires_cloud_key)")
        .in("serial_number", serials)
        .is("deleted_at", null)
        .range(from, to),
    )
    const itemBySerial = new Map<string, MovementBatchDrawerLine>()
    for (const row of itemRows) {
      const pl = row.product_lines as { product_name?: string; vendor?: string; requires_cloud_key?: boolean } | null
      itemBySerial.set(row.serial_number, {
        serialNumber: row.serial_number,
        productName: pl?.product_name ?? undefined,
        status: row.status ?? undefined,
        assignedTo: row.assigned_to ?? undefined,
        stockPool: row.stock_pool,
        cloudKey: row.cloud_key ?? null,
        requiresCloudKey: pl?.requires_cloud_key === true || (pl?.vendor ?? "").toLowerCase() === "fortinet",
      })
    }

    const lines: MovementBatchDrawerLine[] = serials.map((serial) => {
      const fromItem = itemBySerial.get(serial)
      const txn = transactions.find((t) => t.serialNumber === serial)
      return {
        serialNumber: serial,
        productName: fromItem?.productName ?? txn?.itemName,
        status: fromItem?.status,
        assignedTo: fromItem?.assignedTo ?? txn?.assignedTo,
        stockPool: fromItem?.stockPool,
        cloudKey: fromItem?.cloudKey,
        requiresCloudKey: fromItem?.requiresCloudKey,
      }
    })

    const requestByBatch = await loadBatchRequestContext(supabase, [batchId])
    const request = requestByBatch.get(batchId) ?? null

    const { data: timelineRaw, error: timelineError } = await supabase.rpc("batch_movement_history", {
      p_batch_id: batchId,
    })
    if (timelineError) throw new Error(timelineError.message)
    const timeline = parseTimeline(timelineRaw as Json)

    const invoiceKey = invoiceBatchKey(first)
    let invoiceState = first.invoiceState
    const { data: invoiceRow } = await supabase.from("batch_invoices").select("*").eq("batch_id", invoiceKey).maybeSingle()
    if (invoiceRow) invoiceState = invoiceStateFromRow(invoiceRow)

    const actorIds = [
      ...timeline.map((e) => e.actorId),
      ...transactions.map((t) => t.createdBy),
      invoiceState?.enteredBy,
      invoiceState?.approvedBy,
      request ? null : null,
    ]
    const labels = await loadProfileLabels(supabase, actorIds)
    for (const entry of timeline) {
      if (entry.actorId) entry.actorName = labels.get(entry.actorId)
    }

    const recordedByIds = [...new Set(transactions.map((t) => t.createdBy).filter(Boolean))] as string[]
    const recordedBy = recordedByIds.map((id) => labels.get(id)).filter(Boolean).join(", ")

    const { data: reversalRow } = await supabase
      .from("batch_reversals")
      .select("kind")
      .eq("batch_id", batchId)
      .maybeSingle()

    return NextResponse.json({
      batchId,
      batchKey: getTransactionOrderGroupKey(first),
      movementType: first.type,
      date: first.date,
      recordedAt: transactions.map((t) => t.createdAt).filter(Boolean).sort().reverse()[0],
      count: transactions.length,
      productLabel: [...new Set(transactions.map((t) => t.itemName))].join(", "),
      clientDisplay: first.client,
      clientId: transactions.every((t) => t.clientId === first.clientId) ? first.clientId : undefined,
      invoiceState,
      invoiceBatchId: invoiceKey,
      deliveryNoteUrl: transactions.find((t) => t.deliveryNoteUrl)?.deliveryNoteUrl,
      notesSummary: [...new Set(transactions.map((t) => t.notes?.trim()).filter(Boolean))].join("\n\n---\n\n") || undefined,
      request,
      recordedBy,
      recordedById: recordedByIds[0] ?? null,
      lines,
      timeline,
      isReversed: Boolean(reversalRow),
      reversalKind: reversalRow?.kind === "void" ? "void" : reversalRow ? "reversal" : undefined,
    })
  } catch (error) {
    return apiErrorResponse(500, "Failed to load batch details", {
      cause: error,
      logLabel: "movement-batch detail GET",
    })
  }
}
