import type { AppSupabaseClient } from "@/lib/supabase/app-client"
import type { InternalLocation, JsonValue } from "@/lib/data"
import { fetchAllPages } from "@/lib/supabase/postgrest-page"

export function isQuickScanStockReversibleMovement(movementType: string | null | undefined): boolean {
  if (!movementType) return false
  return movementType !== "Reversal"
}

export type QuickScanBatchTxn = {
  id: string
  serial_number: string
  movement_type: string | null
  date: string
  created_at: string | null
  metadata: JsonValue | null
  from_location: string | null
  to_location: string | null
  item_name: string
  client: string
  client_id: string | null
}

export async function fetchActiveBatchTransactions(
  supabase: AppSupabaseClient,
  batchId: string
): Promise<QuickScanBatchTxn[] | null> {
  const { data: rev } = await supabase.from("batch_reversals").select("batch_id").eq("batch_id", batchId).maybeSingle()
  if (rev?.batch_id) return []

  let data
  try {
    data = await fetchAllPages((from, to) =>
      supabase
        .from("transactions")
        .select(
          "id, serial_number, type, date, created_at, metadata, from_location, to_location, item_name, client, client_id"
        )
        .eq("batch_id", batchId)
        .order("serial_number", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to)
    )
  } catch (error) {
    console.error("fetchActiveBatchTransactions:", error)
    return null
  }
  return data.map((row) => ({
    id: row.id,
    serial_number: row.serial_number,
    movement_type: row.type,
    date: row.date,
    created_at: row.created_at ?? null,
    metadata: (row.metadata ?? null) as JsonValue | null,
    from_location: row.from_location ?? null,
    to_location: row.to_location ?? null,
    item_name: row.item_name,
    client: row.client,
    client_id: row.client_id ?? null,
  }))
}

export type RevertInventoryResult =
  | {
      ok: true
      requestedCount: number
      reversedCount: number
      alreadyReversedCount: number
      reversedSerials: string[]
      alreadyReversedSerials: string[]
      reversalBatchId: string
    }
  | { ok: false; status: number; error: string; detail?: string[] }

export async function revertInventoryAndTransactionsForQuickScan(
  supabase: AppSupabaseClient,
  options: {
    batchId: string
    batchTxns: QuickScanBatchTxn[]
    returnLocation: InternalLocation
    reversalReason: string
    createdBy: string | null
    confirmed?: { transactionId: string; status: string }[]
  }
): Promise<RevertInventoryResult> {
  const { batchId, returnLocation, reversalReason, confirmed } = options
  const { data, error } = await supabase.rpc("reverse_quick_scan_batch", {
    p_batch_id: batchId,
    p_reason: reversalReason,
    p_return_location: returnLocation,
    p_confirmed: (confirmed ?? []).map((row) => ({
      transaction_id: row.transactionId,
      status: row.status,
    })),
  })
  if (error) {
    const msg = error.message ?? ""
    if (/forbidden/i.test(msg)) {
      return { ok: false, status: 403, error: "Only admins can reverse a batch", detail: [msg] }
    }
    if (/reason must be at least/i.test(msg)) {
      return { ok: false, status: 400, error: "Reason must be at least 15 characters", detail: [msg] }
    }
    if (/cannot be reversed/i.test(msg)) {
      return { ok: false, status: 409, error: "A reversal cannot be reversed", detail: [msg] }
    }
    if (/blocked by later batch/i.test(msg)) {
      return { ok: false, status: 409, error: msg, detail: [msg] }
    }
    if (/unknown previous status|legal predecessor|changed stock/i.test(msg)) {
      return { ok: false, status: 409, error: msg, detail: [msg] }
    }
    return { ok: false, status: 500, error: "Failed to reverse batch.", detail: [msg] }
  }
  const rpc = (data ?? null) as { ok?: boolean; reversal_batch_id?: string; reversed_count?: number } | null
  return {
    ok: true,
    requestedCount: Number(rpc?.reversed_count ?? options.batchTxns.length),
    reversedCount: Number(rpc?.reversed_count ?? options.batchTxns.length),
    alreadyReversedCount: 0,
    reversedSerials: options.batchTxns.map((txn) => txn.serial_number),
    alreadyReversedSerials: [],
    reversalBatchId: rpc?.reversal_batch_id ?? "",
  }
}

export type BatchReversalCompleteness = {
  batchId: string
  batchReversalExists: boolean
  remainingTransactions: number
  nonRevertedSerials: string[]
}

export async function getQuickScanBatchReversalCompleteness(
  supabase: AppSupabaseClient,
  batchId: string
): Promise<BatchReversalCompleteness | null> {
  const { data: rev, error: revErr } = await supabase
    .from("batch_reversals")
    .select("batch_id")
    .eq("batch_id", batchId)
    .maybeSingle()
  if (revErr) {
    console.error("getQuickScanBatchReversalCompleteness batch_reversals:", revErr)
    return null
  }
  let txRows
  try {
    txRows = await fetchAllPages((from, to) =>
      supabase
        .from("transactions")
        .select("id")
        .eq("batch_id", batchId)
        .order("id", { ascending: true })
        .range(from, to)
    )
  } catch (error) {
    console.error("getQuickScanBatchReversalCompleteness transactions:", error)
    return null
  }
  return {
    batchId,
    batchReversalExists: Boolean(rev?.batch_id),
    remainingTransactions: rev?.batch_id ? 0 : txRows.length,
    nonRevertedSerials: [],
  }
}
