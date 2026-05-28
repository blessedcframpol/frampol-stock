import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/supabase/database.types"
import type { InternalLocation, InventoryItem, ItemStatus } from "@/lib/data"
import {
  rowToInventoryItem,
  inventoryItemToRow,
  INVENTORY_ITEM_SELECT,
  type InventoryItemQueryRow,
} from "@/lib/supabase/inventory-db"

const SUPPORTED_STOCK_REVERSAL = ["Sale", "POC Out", "Rentals", "Dispose", "Transfer"] as const
export type QuickScanStockReversibleType = (typeof SUPPORTED_STOCK_REVERSAL)[number]

export function isQuickScanStockReversibleMovement(movementType: string | null | undefined): boolean {
  if (!movementType) return false
  return (SUPPORTED_STOCK_REVERSAL as readonly string[]).includes(movementType)
}

export type QuickScanBatchRow = {
  serial_number: string
  movement_type: string | null
}

/** Load serials + movement types for an active (not reversed) transaction batch. */
export async function fetchActiveMovementBatchRows(
  supabase: SupabaseClient<Database>,
  batchId: string
): Promise<QuickScanBatchRow[] | null> {
  const { data: rev } = await supabase.from("batch_reversals").select("batch_id").eq("batch_id", batchId).maybeSingle()
  if (rev?.batch_id) {
    return []
  }

  const { data, error } = await supabase
    .from("transactions")
    .select("serial_number, type")
    .eq("batch_id", batchId)
  if (error) {
    console.error("fetchActiveMovementBatchRows:", error)
    return null
  }
  return (data ?? []).map((r) => ({
    serial_number: r.serial_number,
    movement_type: r.type,
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
    }
  | { ok: false; status: number; error: string; detail?: string[] }

type PlanEntry =
  | {
      kind: "full"
      serial: string
      inventoryId: string
      next: InventoryItem
      transactionId: string | null
      expectedStatus: ItemStatus
    }
  | {
      kind: "transfer"
      serial: string
      inventoryId: string
      next: InventoryItem
      transactionId: string
      expectedLocation: string
    }

type ReverseQuickScanRpcEntry = {
  serial: string
  entry_kind: "full" | "transfer"
  inventory_id: string
  transaction_id: string | null
  reverted_row: Database["public"]["Tables"]["inventory_items"]["Insert"]
  expected_status: string | null
  expected_location: string | null
}

type ReverseQuickScanRpcResult = {
  ok: boolean
  batch_id?: string
  requested_count?: number
  reversed_count?: number
  already_reversed_count?: number
  failed_count?: number
  reversed_serials?: string[]
  already_reversed_serials?: string[]
  failed_serials?: string[]
  failed_details?: { serial: string; reason: string }[]
  error?: string
}

const REQUIRED_STATUS: Record<string, ItemStatus> = {
  Sale: "Sold",
  "POC Out": "POC",
  Rentals: "Rented",
  Dispose: "Disposed",
}

function patchOutboundRevert(movementType: string, returnLocation: InternalLocation): Partial<InventoryItem> {
  switch (movementType) {
    case "Sale":
      return {
        status: "In Stock",
        location: returnLocation,
        client: undefined,
        assignedTo: undefined,
      }
    case "POC Out":
      return {
        status: "In Stock",
        location: returnLocation,
        client: undefined,
        assignedTo: undefined,
        pocOutDate: undefined,
        returnDate: undefined,
      }
    case "Rentals":
      return {
        status: "In Stock",
        location: returnLocation,
        client: undefined,
        assignedTo: undefined,
        pocOutDate: undefined,
        returnDate: undefined,
      }
    case "Dispose":
      return {
        status: "In Stock",
        location: returnLocation,
        client: undefined,
        assignedTo: undefined,
      }
    default:
      return {}
  }
}

/**
 * Validates and applies inventory + removes matching movement transaction rows.
 * Two-phase: plan all changes first; apply only if every serial passes validation.
 */
export async function revertInventoryAndTransactionsForQuickScan(
  supabase: SupabaseClient<Database>,
  options: { batchId: string; rows: QuickScanBatchRow[]; returnLocation: InternalLocation }
): Promise<RevertInventoryResult> {
  const { batchId, rows, returnLocation } = options
  if (rows.length === 0) {
    return { ok: false, status: 404, error: "No active scan rows in batch" }
  }

  const movementType = rows[0]?.movement_type ?? null
  if (!movementType || !isQuickScanStockReversibleMovement(movementType)) {
    return {
      ok: false,
      status: 400,
      error: "This movement type cannot be reversed with automated stock updates.",
      detail: [
        "Supported: Sale, POC Out, Rentals, Dispose, Transfer.",
        "Inbound and POC/Rental returns are not supported here.",
      ],
    }
  }

  if (!rows.every((r) => r.movement_type === movementType)) {
    return { ok: false, status: 400, error: "Batch mixes movement types; cannot reverse automatically." }
  }

  const serials = [...new Set(rows.map((r) => r.serial_number.trim()).filter(Boolean))]
  if (serials.length === 0) {
    return { ok: false, status: 400, error: "Batch has no serial numbers to reverse." }
  }

  const plan: PlanEntry[] = []
  const errors: string[] = []

  if (movementType === "Transfer") {
    for (const serial of serials) {
      const { data: invRow, error: invErr } = await supabase
        .from("inventory_items")
        .select(INVENTORY_ITEM_SELECT)
        .eq("serial_number", serial)
        .maybeSingle()
      if (invErr || !invRow) {
        errors.push(`${serial}: not found in inventory`)
        continue
      }
      const item = rowToInventoryItem(invRow as InventoryItemQueryRow)
      const { data: txn, error: txnErr } = await supabase
        .from("transactions")
        .select("id, from_location, to_location")
        .eq("serial_number", serial)
        .eq("type", "Transfer")
        .order("date", { ascending: false })
        .limit(1)
        .maybeSingle()
      if (txnErr || !txn?.id) {
        errors.push(`${serial}: no transfer transaction found`)
        continue
      }
      const toLoc = txn.to_location?.trim() ?? ""
      if (toLoc && item.location !== toLoc) {
        errors.push(
          `${serial}: current location "${item.location}" does not match last transfer destination "${toLoc}"`
        )
        continue
      }
      const backTo = (txn.from_location?.trim() || returnLocation) as InternalLocation | string
      const next: InventoryItem = { ...item, location: backTo }
      plan.push({
        kind: "transfer",
        serial,
        inventoryId: item.id,
        next,
        transactionId: txn.id,
        expectedLocation: toLoc,
      })
    }
  } else {
    const required = REQUIRED_STATUS[movementType]
    if (!required) {
      return { ok: false, status: 400, error: "Unsupported movement for stock reversal" }
    }
    const patch = patchOutboundRevert(movementType, returnLocation)

    for (const serial of serials) {
      const { data: invRow, error: invErr } = await supabase
        .from("inventory_items")
        .select(INVENTORY_ITEM_SELECT)
        .eq("serial_number", serial)
        .maybeSingle()
      if (invErr || !invRow) {
        errors.push(`${serial}: not found in inventory`)
        continue
      }
      const item = rowToInventoryItem(invRow as InventoryItemQueryRow)
      if (item.status !== required) {
        errors.push(`${serial}: expected status "${required}", got "${item.status}"`)
        continue
      }

      const { data: txnRows } = await supabase
        .from("transactions")
        .select("id")
        .eq("serial_number", serial)
        .eq("type", movementType)
        .order("date", { ascending: false })
        .limit(1)
      const transactionId = txnRows?.[0]?.id ?? null

      const next: InventoryItem = { ...item, ...patch }
      plan.push({
        kind: "full",
        serial,
        inventoryId: item.id,
        next,
        transactionId,
        expectedStatus: required,
      })
    }
  }

  if (errors.length > 0) {
    return { ok: false, status: 409, error: "Cannot reverse batch — fix items or choose another approach.", detail: errors }
  }

  const rpcEntries: ReverseQuickScanRpcEntry[] = plan.map((entry) => ({
    serial: entry.serial,
    entry_kind: entry.kind,
    inventory_id: entry.inventoryId,
    transaction_id: entry.transactionId,
    reverted_row: inventoryItemToRow(entry.next),
    expected_status: entry.kind === "full" ? entry.expectedStatus : null,
    expected_location: entry.kind === "transfer" ? entry.expectedLocation : null,
  }))

  const { data, error } = await supabase.rpc("reverse_quick_scan_batch", {
    p_batch_id: batchId,
    p_entries: rpcEntries,
  })
  if (error) {
    return {
      ok: false,
      status: 500,
      error: "Failed to reverse batch atomically.",
      detail: [error.message],
    }
  }

  const rpc = (data ?? null) as ReverseQuickScanRpcResult | null
  if (!rpc || typeof rpc !== "object") {
    return {
      ok: false,
      status: 500,
      error: "Invalid reversal response from database.",
    }
  }

  if (!rpc.ok) {
    const failedDetails = (rpc.failed_details ?? [])
      .map((x) => `${x.serial}: ${x.reason}`)
      .filter(Boolean)
    const fallbackFailed = rpc.failed_serials?.length ? rpc.failed_serials.join(", ") : ""
    return {
      ok: false,
      status: 409,
      error: rpc.error?.trim() || "Cannot reverse batch — preconditions changed.",
      detail: failedDetails.length > 0 ? failedDetails : fallbackFailed ? [fallbackFailed] : undefined,
    }
  }

  const requestedCount = Number(rpc.requested_count ?? serials.length)
  const reversedCount = Number(rpc.reversed_count ?? 0)
  const alreadyReversedCount = Number(rpc.already_reversed_count ?? 0)
  const reversedSerials = Array.isArray(rpc.reversed_serials) ? rpc.reversed_serials : []
  const alreadyReversedSerials = Array.isArray(rpc.already_reversed_serials) ? rpc.already_reversed_serials : []

  if (reversedCount + alreadyReversedCount !== requestedCount) {
    const failed = Array.isArray(rpc.failed_serials) ? rpc.failed_serials : []
    return {
      ok: false,
      status: 409,
      error: "Cannot confirm complete reversal for this batch.",
      detail: failed.length > 0 ? [`Failed serial(s): ${failed.join(", ")}`] : undefined,
    }
  }

  return {
    ok: true,
    requestedCount,
    reversedCount,
    alreadyReversedCount,
    reversedSerials,
    alreadyReversedSerials,
  }
}

export type BatchReversalCompleteness = {
  batchId: string
  batchReversalExists: boolean
  remainingTransactions: number
  nonRevertedSerials: string[]
}

/**
 * Reconciliation check by batch id: reports whether any rows are still in non-reverted state.
 * This is independent of in-the-moment reverse request to verify completeness after the fact.
 */
export async function getQuickScanBatchReversalCompleteness(
  supabase: SupabaseClient<Database>,
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

  const { data: txRows, error: txErr } = await supabase
    .from("transactions")
    .select("serial_number, type, to_location")
    .eq("batch_id", batchId)
  if (txErr) {
    console.error("getQuickScanBatchReversalCompleteness transactions:", txErr)
    return null
  }

  const remainingTransactions = (txRows ?? []).length
  if (remainingTransactions === 0) {
    return {
      batchId,
      batchReversalExists: Boolean(rev?.batch_id),
      remainingTransactions: 0,
      nonRevertedSerials: [],
    }
  }

  const serials = [...new Set((txRows ?? []).map((t) => t.serial_number?.trim()).filter(Boolean) as string[])]
  const { data: invRows, error: invErr } = await supabase
    .from("inventory_items")
    .select("serial_number, status, location")
    .in("serial_number", serials)
  if (invErr) {
    console.error("getQuickScanBatchReversalCompleteness inventory_items:", invErr)
    return null
  }

  const invBySerial = new Map((invRows ?? []).map((r) => [r.serial_number, r]))
  const outgoingStatus: Record<string, string> = {
    Sale: "Sold",
    "POC Out": "POC",
    Rentals: "Rented",
    Dispose: "Disposed",
  }
  const nonRevertedSerials = new Set<string>()
  for (const tx of txRows ?? []) {
    const serial = tx.serial_number?.trim()
    if (!serial) continue
    const inv = invBySerial.get(serial)
    if (!inv) {
      nonRevertedSerials.add(serial)
      continue
    }
    if (tx.type === "Transfer") {
      const toLoc = tx.to_location?.trim() ?? ""
      if (toLoc && inv.location === toLoc) nonRevertedSerials.add(serial)
      continue
    }
    const outStatus = outgoingStatus[tx.type]
    if (outStatus && inv.status === outStatus) nonRevertedSerials.add(serial)
  }

  return {
    batchId,
    batchReversalExists: Boolean(rev?.batch_id),
    remainingTransactions,
    nonRevertedSerials: [...nonRevertedSerials].sort(),
  }
}
