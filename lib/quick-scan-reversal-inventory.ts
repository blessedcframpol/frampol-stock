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
  | { ok: true }
  | { ok: false; status: number; error: string; detail?: string[] }

type PlanEntry =
  | {
      kind: "full"
      serial: string
      inventoryId: string
      next: InventoryItem
      transactionId: string | null
    }
  | {
      kind: "transfer"
      serial: string
      inventoryId: string
      next: InventoryItem
      transactionId: string
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
  options: { rows: QuickScanBatchRow[]; returnLocation: InternalLocation }
): Promise<RevertInventoryResult> {
  const { rows, returnLocation } = options
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
      plan.push({ kind: "transfer", serial, inventoryId: item.id, next, transactionId: txn.id })
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
      plan.push({ kind: "full", serial, inventoryId: item.id, next, transactionId })
    }
  }

  if (errors.length > 0) {
    return { ok: false, status: 409, error: "Cannot reverse batch — fix items or choose another approach.", detail: errors }
  }

  for (const entry of plan) {
    const { error: upErr } = await supabase
      .from("inventory_items")
      .update(inventoryItemToRow(entry.next))
      .eq("id", entry.inventoryId)
    if (upErr) {
      return {
        ok: false,
        status: 500,
        error: `Failed to update inventory for ${entry.serial}`,
        detail: [upErr.message],
      }
    }
  }

  for (const entry of plan) {
    if (entry.kind === "transfer") {
      const { error: delErr } = await supabase.from("transactions").delete().eq("id", entry.transactionId)
      if (delErr) {
        return {
          ok: false,
          status: 500,
          error: `Inventory updated but failed to remove transaction for ${entry.serial}`,
          detail: [delErr.message],
        }
      }
    } else if (entry.transactionId) {
      const { error: delErr } = await supabase.from("transactions").delete().eq("id", entry.transactionId)
      if (delErr) {
        return {
          ok: false,
          status: 500,
          error: `Inventory updated but failed to remove transaction for ${entry.serial}`,
          detail: [delErr.message],
        }
      }
    }
  }

  return { ok: true }
}
