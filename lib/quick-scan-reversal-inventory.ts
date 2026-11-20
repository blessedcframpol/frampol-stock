import type { AppSupabaseClient } from "@/lib/supabase/app-client"
import type { InternalLocation, JsonValue } from "@/lib/data"
import type { ReversePlanBlockedBy, ReversePlanItemState } from "@/lib/supabase/movement-utils"
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

export type ReversePlanRow = {
  transactionId: string
  serial: string
  hasImage: boolean
  softDelete: boolean
  status: string | null
  client: string | null
  assignedTo: string | null
  location: string | null
  pocOutDate: string | null
  returnDate: string | null
  needs: Array<"status" | "location" | "return_date">
  current: ReversePlanItemState | null
  after: ReversePlanItemState | null
}

export type RestorePlanRow = {
  transactionId: string
  serial: string
  status: string | null
  client: string | null
  assignedTo: string | null
  location: string | null
  pocOutDate: string | null
  returnDate: string | null
  current: ReversePlanItemState | null
  after: ReversePlanItemState | null
}

export type ReversePlanPayload = {
  batchId: string
  movementType: string | null
  batchAgeDays: number | null
  blockedBy: ReversePlanBlockedBy | null
  rows: ReversePlanRow[]
}

export type RestorePlanPayload = {
  batchId: string
  kind: string
  movementType: string | null
  batchAgeDays: number | null
  blockedBy: ReversePlanBlockedBy | null
  rows: RestorePlanRow[]
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function parseItemState(value: unknown): ReversePlanItemState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  return {
    status: textOrNull(row.status),
    location: textOrNull(row.location),
    client: textOrNull(row.client),
    assignedTo: textOrNull(row.assignedTo),
    stockPool: textOrNull(row.stockPool),
  }
}

function parseBlockedBy(value: unknown): ReversePlanBlockedBy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const batchId = typeof row.batchId === "string" ? row.batchId.trim() : ""
  if (!batchId) return null
  return {
    batchId,
    serial: typeof row.serial === "string" ? row.serial : "",
    type: typeof row.type === "string" ? row.type : "",
    date: typeof row.date === "string" ? row.date : "",
  }
}

/** @deprecated Prefer formatNowAfterLine from movement-utils (RA1). */
export function reversalResultLine(
  row: Pick<ReversePlanRow, "softDelete" | "status" | "client" | "location" | "returnDate">,
  entered?: { status?: string; location?: string; returnDate?: string }
): string {
  if (row.softDelete) return "Kit will return to: trash"
  const status = entered?.status?.trim() || row.status || "—"
  const client = row.client?.trim() || "—"
  const location = entered?.location?.trim() || row.location?.trim() || "—"
  const returnDate = entered?.returnDate?.trim() || row.returnDate?.trim() || "—"
  return `Kit will return to: ${status} · ${client} · ${location} · ${returnDate}`
}

export function parseReversePlan(data: unknown): ReversePlanPayload {
  if (!data || typeof data !== "object" || Array.isArray(data) || !("rows" in data) || !Array.isArray(data.rows)) {
    throw new Error("Reverse plan was not a list of kits")
  }
  const root = data as Record<string, unknown>
  const batchAgeRaw = root.batchAgeDays
  return {
    batchId: typeof root.batchId === "string" ? root.batchId : "",
    movementType: textOrNull(root.movementType),
    batchAgeDays: typeof batchAgeRaw === "number" && Number.isFinite(batchAgeRaw) ? batchAgeRaw : null,
    blockedBy: parseBlockedBy(root.blockedBy),
    rows: data.rows.map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Reverse plan row is invalid")
      const transactionId = "transactionId" in row && typeof row.transactionId === "string" ? row.transactionId : ""
      const serial = "serial" in row && typeof row.serial === "string" ? row.serial : ""
      if (!transactionId || !serial) throw new Error("Reverse plan row is missing its kit")
      const rawNeeds = "needs" in row && Array.isArray(row.needs) ? row.needs : []
      const needs = rawNeeds.filter(
        (need: unknown): need is ReversePlanRow["needs"][number] =>
          need === "status" || need === "location" || need === "return_date"
      )
      const softDelete = "softDelete" in row && row.softDelete === true
      return {
        transactionId,
        serial,
        hasImage: "hasImage" in row && row.hasImage === true,
        softDelete,
        status: textOrNull("status" in row ? row.status : null),
        client: textOrNull("client" in row ? row.client : null),
        assignedTo: textOrNull("assignedTo" in row ? row.assignedTo : null),
        location: textOrNull("location" in row ? row.location : null),
        pocOutDate: textOrNull("pocOutDate" in row ? row.pocOutDate : null),
        returnDate: textOrNull("returnDate" in row ? row.returnDate : null),
        needs,
        current: parseItemState("current" in row ? row.current : null),
        after: softDelete ? null : parseItemState("after" in row ? row.after : null),
      }
    }),
  }
}

export function parseRestorePlan(data: unknown): RestorePlanPayload {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Restore plan was not an object")
  const root = data as Record<string, unknown>
  const kind = "kind" in root && typeof root.kind === "string" ? root.kind : ""
  const rows = "rows" in root && Array.isArray(root.rows) ? root.rows : []
  const batchAgeRaw = root.batchAgeDays
  return {
    batchId: typeof root.batchId === "string" ? root.batchId : "",
    kind,
    movementType: textOrNull(root.movementType),
    batchAgeDays: typeof batchAgeRaw === "number" && Number.isFinite(batchAgeRaw) ? batchAgeRaw : null,
    blockedBy: parseBlockedBy(root.blockedBy),
    rows: rows.map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Restore plan row is invalid")
      const transactionId = "transactionId" in row && typeof row.transactionId === "string" ? row.transactionId : ""
      const serial = "serial" in row && typeof row.serial === "string" ? row.serial : ""
      if (!transactionId || !serial) throw new Error("Restore plan row is missing its kit")
      return {
        transactionId,
        serial,
        status: textOrNull("status" in row ? row.status : null),
        client: textOrNull("client" in row ? row.client : null),
        assignedTo: textOrNull("assignedTo" in row ? row.assignedTo : null),
        location: textOrNull("location" in row ? row.location : null),
        pocOutDate: textOrNull("pocOutDate" in row ? row.pocOutDate : null),
        returnDate: textOrNull("returnDate" in row ? row.returnDate : null),
        current: parseItemState("current" in row ? row.current : null),
        after: parseItemState("after" in row ? row.after : null),
      }
    }),
  }
}

async function batchCurrentlyReversed(supabase: AppSupabaseClient, batchId: string): Promise<boolean | null> {
  const { data: rev, error } = await supabase
    .from("batch_reversals")
    .select("reversed_at")
    .eq("batch_id", batchId)
    .maybeSingle()
  if (error) return null
  if (!rev?.reversed_at) return false
  const { data: restores, error: restoreError } = await supabase
    .from("batch_restores")
    .select("restored_at")
    .eq("batch_id", batchId)
    .order("restored_at", { ascending: false })
    .limit(1)
  if (restoreError) return null
  const restoredAt = restores?.[0]?.restored_at
  if (!restoredAt) return true
  return restoredAt < rev.reversed_at
}

export async function fetchActiveBatchTransactions(
  supabase: AppSupabaseClient,
  batchId: string
): Promise<QuickScanBatchTxn[] | null> {
  const reversed = await batchCurrentlyReversed(supabase, batchId)
  if (reversed === null) return null
  if (reversed) return []

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
    returnLocation?: InternalLocation | null
    reversalReason: string
    createdBy: string | null
    confirmed?: { transactionId: string; status: string }[]
    entered?: { transactionId: string; location?: string; returnDate?: string }[]
  }
): Promise<RevertInventoryResult> {
  const { batchId, returnLocation, reversalReason, confirmed, entered } = options
  const { data, error } = await supabase.rpc("reverse_quick_scan_batch", {
    p_batch_id: batchId,
    p_reason: reversalReason,
    p_return_location: returnLocation ?? undefined,
    p_confirmed: (confirmed ?? []).map((row) => ({
      transaction_id: row.transactionId,
      status: row.status,
    })),
    p_entered: (entered ?? []).map((row) => ({
      transaction_id: row.transactionId,
      location: row.location ?? null,
      return_date: row.returnDate ?? null,
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
    if (/unknown previous status|legal predecessor|changed stock|entered at reversal/i.test(msg)) {
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
  const reversed = await batchCurrentlyReversed(supabase, batchId)
  if (reversed === null) {
    console.error("getQuickScanBatchReversalCompleteness batch_reversals")
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
    batchReversalExists: reversed,
    remainingTransactions: reversed ? 0 : txRows.length,
    nonRevertedSerials: [],
  }
}
