import type { AppSupabaseClient } from "@/lib/supabase/app-client"
import type { Database } from "@/lib/supabase/database.types"
import type { InternalLocation, InventoryItem, ItemStatus, JsonValue } from "@/lib/data"
import {
  rowToInventoryItem,
  inventoryItemToRow,
  INVENTORY_ITEM_SELECT,
  type InventoryItemQueryRow,
} from "@/lib/supabase/inventory-db"

const SUPPORTED_STOCK_REVERSAL = ["Inbound", "Sale", "POC Out", "Rentals", "Dispose", "Transfer"] as const
export type QuickScanStockReversibleType = (typeof SUPPORTED_STOCK_REVERSAL)[number]

export function isQuickScanStockReversibleMovement(movementType: string | null | undefined): boolean {
  if (!movementType) return false
  return (SUPPORTED_STOCK_REVERSAL as readonly string[]).includes(movementType)
}

/** @deprecated Use QuickScanBatchTxn */
export type QuickScanBatchRow = {
  serial_number: string
  movement_type: string | null
}

export type QuickScanBatchTxn = {
  id: string
  serial_number: string
  movement_type: string | null
  date: string
  metadata: JsonValue | null
  from_location: string | null
  to_location: string | null
  item_name: string
  client: string
  client_id: string | null
}

/** Load every active transaction row for a batch (not reversed). */
export async function fetchActiveBatchTransactions(
  supabase: AppSupabaseClient,
  batchId: string
): Promise<QuickScanBatchTxn[] | null> {
  const { data: rev } = await supabase.from("batch_reversals").select("batch_id").eq("batch_id", batchId).maybeSingle()
  if (rev?.batch_id) {
    return []
  }

  const { data, error } = await supabase
    .from("transactions")
    .select("id, serial_number, type, date, metadata, from_location, to_location, item_name, client, client_id")
    .eq("batch_id", batchId)
    .order("serial_number")
  if (error) {
    console.error("fetchActiveBatchTransactions:", error)
    return null
  }
  return (data ?? []).map((r) => ({
    id: r.id,
    serial_number: r.serial_number,
    movement_type: r.type,
    date: r.date,
    metadata: (r.metadata ?? null) as JsonValue | null,
    from_location: r.from_location ?? null,
    to_location: r.to_location ?? null,
    item_name: r.item_name,
    client: r.client,
    client_id: r.client_id ?? null,
  }))
}

/** @deprecated Use fetchActiveBatchTransactions */
export async function fetchActiveMovementBatchRows(
  supabase: AppSupabaseClient,
  batchId: string
): Promise<QuickScanBatchRow[] | null> {
  const txns = await fetchActiveBatchTransactions(supabase, batchId)
  if (txns === null) return null
  return txns.map((t) => ({ serial_number: t.serial_number, movement_type: t.movement_type }))
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

type PlanEntry =
  | {
      kind: "full"
      serial: string
      inventoryId: string
      next: InventoryItem
      transactionId: string
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
  | {
      kind: "delete"
      serial: string
      inventoryId: string
      transactionId: string
      expectedStatus: ItemStatus
    }

type ReverseQuickScanRpcEntry = {
  serial: string
  entry_kind: "full" | "transfer" | "delete"
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
  batch_txn_count?: number
  reversed_count?: number
  already_reversed_count?: number
  remaining_batch_txns?: number
  failed_count?: number
  reversed_serials?: string[]
  already_reversed_serials?: string[]
  failed_serials?: string[]
  failed_details?: { serial: string; reason: string }[]
  error?: string
}

const REQUIRED_STATUS: Record<string, ItemStatus> = {
  Inbound: "In Stock",
  Sale: "Sold",
  "POC Out": "POC",
  Rentals: "Rented",
  Dispose: "Disposed",
}

type InboundTxnMeta = {
  inboundCreated?: boolean
  previousStatus?: string
  previousLocation?: string
  previousClient?: string | null
  previousAssignedTo?: string | null
}

function parseInboundTxnMeta(metadata: JsonValue | null | undefined): InboundTxnMeta {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {}
  const m = metadata as Record<string, unknown>
  return {
    inboundCreated: m.inboundCreated === true,
    previousStatus: typeof m.previousStatus === "string" ? m.previousStatus : undefined,
    previousLocation: typeof m.previousLocation === "string" ? m.previousLocation : undefined,
    previousClient: typeof m.previousClient === "string" ? m.previousClient : m.previousClient === null ? null : undefined,
    previousAssignedTo:
      typeof m.previousAssignedTo === "string"
        ? m.previousAssignedTo
        : m.previousAssignedTo === null
          ? null
          : undefined,
  }
}

function inferPriorStateFromTxn(
  priorType: string,
  priorToLocation: string | null | undefined,
  fallbackLocation: InternalLocation
): Pick<InventoryItem, "status" | "location"> {
  if (priorType === "Sale Return" || priorType === "Inspection Fail") {
    return {
      status: "RMA Hold",
      location: priorToLocation?.trim() || fallbackLocation,
    }
  }
  return {
    status: "Maintenance",
    location: priorToLocation?.trim() || "Service Center",
  }
}

async function hasSubsequentMovement(
  supabase: AppSupabaseClient,
  serial: string,
  inboundTxnId: string,
  inboundDate: string,
  batchId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("transactions")
    .select("id, batch_id, date")
    .eq("serial_number", serial)
    .neq("id", inboundTxnId)
  if (error) {
    console.error("hasSubsequentMovement:", error)
    return true
  }
  return (data ?? []).some((row) => {
    if (row.batch_id === batchId) return false
    const rowDate = row.date?.trim() ?? ""
    if (!rowDate) return true
    return rowDate > inboundDate
  })
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

function duplicateSerialsInBatch(batchTxns: QuickScanBatchTxn[]): string[] {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const txn of batchTxns) {
    const serial = txn.serial_number.trim()
    if (!serial) continue
    if (seen.has(serial)) dupes.add(serial)
    seen.add(serial)
  }
  return [...dupes].sort()
}

async function planInboundEntry(
  supabase: AppSupabaseClient,
  txn: QuickScanBatchTxn,
  batchId: string,
  returnLocation: InternalLocation,
  errors: string[]
): Promise<PlanEntry | null> {
  const serial = txn.serial_number.trim()
  if (!serial) {
    errors.push(`Missing serial on transaction ${txn.id}`)
    return null
  }

  const { data: invRow, error: invErr } = await supabase
    .from("inventory_items")
    .select(INVENTORY_ITEM_SELECT)
    .eq("serial_number", serial)
    .is("deleted_at", null)
    .maybeSingle()
  if (invErr || !invRow) {
    errors.push(`${serial}: not found in inventory`)
    return null
  }
  const item = rowToInventoryItem(invRow as InventoryItemQueryRow)
  if (item.status !== "In Stock") {
    errors.push(`${serial}: expected status "In Stock", got "${item.status}"`)
    return null
  }

  if (await hasSubsequentMovement(supabase, serial, txn.id, txn.date, batchId)) {
    errors.push(`${serial}: has later movements — reverse those first or correct manually`)
    return null
  }

  const meta = parseInboundTxnMeta(txn.metadata)
  const inboundDateOnly = txn.date.slice(0, 10)
  const createdByInbound =
    meta.inboundCreated === true || (meta.inboundCreated !== false && item.dateAdded === inboundDateOnly)

  if (createdByInbound) {
    const { count: priorCount } = await supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("serial_number", serial)
      .neq("id", txn.id)
      .lt("date", txn.date)
    if ((priorCount ?? 0) > 0) {
      errors.push(`${serial}: cannot delete — prior transaction history exists`)
      return null
    }
    return {
      kind: "delete",
      serial,
      inventoryId: item.id,
      transactionId: txn.id,
      expectedStatus: "In Stock",
    }
  }

  let priorStatus: ItemStatus = "Maintenance"
  let priorLocation = "Service Center"
  let priorClient: string | undefined
  let priorAssignedTo: string | undefined

  if (meta.previousStatus === "Maintenance" || meta.previousStatus === "RMA Hold") {
    priorStatus = meta.previousStatus
    priorLocation = meta.previousLocation?.trim() || priorLocation
    priorClient = meta.previousClient ?? undefined
    priorAssignedTo = meta.previousAssignedTo ?? undefined
  } else {
    const { data: priorTxn } = await supabase
      .from("transactions")
      .select("type, to_location")
      .eq("serial_number", serial)
      .neq("id", txn.id)
      .lt("date", txn.date)
      .order("date", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (priorTxn?.type) {
      const inferred = inferPriorStateFromTxn(priorTxn.type, priorTxn.to_location, returnLocation)
      priorStatus = inferred.status
      priorLocation = inferred.location
    }
  }

  return {
    kind: "full",
    serial,
    inventoryId: item.id,
    next: {
      ...item,
      status: priorStatus,
      location: priorLocation,
      client: priorClient,
      assignedTo: priorAssignedTo,
    },
    transactionId: txn.id,
    expectedStatus: "In Stock",
  }
}

function buildReversalLedgerRow(options: {
  batchId: string
  batchTxns: QuickScanBatchTxn[]
  reversalBatchId: string
  reversalReason: string
  returnLocation: InternalLocation
  originalMovementType: string
  createdBy?: string
  nowIso?: string
}): Database["public"]["Tables"]["transactions"]["Insert"] {
  const nowIso = options.nowIso ?? new Date().toISOString()
  const serials = [...new Set(options.batchTxns.map((t) => t.serial_number.trim()).filter(Boolean))].sort()
  const productNames = [...new Set(options.batchTxns.map((t) => t.item_name.trim()).filter(Boolean))].sort()
  let itemName = "Batch reversal"
  if (productNames.length === 1) itemName = productNames[0]!
  else if (productNames.length === 2) itemName = `${productNames[0]!}, ${productNames[1]!}`
  else if (productNames.length > 2) itemName = `${productNames[0]!} +${productNames.length - 1} more`

  const clients = [...new Set(options.batchTxns.map((t) => t.client?.trim()).filter(Boolean) as string[])]
  const client = clients.length === 1 ? clients[0]! : "Internal"
  const clientIds = [...new Set(options.batchTxns.map((t) => t.client_id).filter(Boolean) as string[])]
  const clientId = clientIds.length === 1 ? clientIds[0]! : null

  return {
    id: `TXN-REV-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    type: "Reversal",
    serial_number: "(batch)",
    item_name: itemName,
    client,
    date: nowIso,
    client_id: clientId,
    notes: options.reversalReason,
    batch_id: options.reversalBatchId,
    metadata: {
      reversedBatchId: options.batchId,
      originalMovementType: options.originalMovementType,
      returnLocation: options.returnLocation,
      serialNumbers: serials,
      itemCount: serials.length,
    } as Database["public"]["Tables"]["transactions"]["Insert"]["metadata"],
    created_by: options.createdBy ?? null,
  }
}

/**
 * Validates and applies inventory + removes matching movement transaction rows.
 * Two-phase: plan all changes first; apply only if every serial passes validation.
 */
export async function revertInventoryAndTransactionsForQuickScan(
  supabase: AppSupabaseClient,
  options: {
    batchId: string
    batchTxns: QuickScanBatchTxn[]
    returnLocation: InternalLocation
    reversalReason: string
    createdBy?: string
  }
): Promise<RevertInventoryResult> {
  const { batchId, batchTxns, returnLocation, reversalReason, createdBy } = options
  if (batchTxns.length === 0) {
    return { ok: false, status: 404, error: "No active scan rows in batch" }
  }

  const movementType = batchTxns[0]?.movement_type ?? null
  if (!movementType || !isQuickScanStockReversibleMovement(movementType)) {
    return {
      ok: false,
      status: 400,
      error: "This movement type cannot be reversed with automated stock updates.",
      detail: [
        "Supported: Inbound, Sale, POC Out, Rentals, Dispose, Transfer.",
        "POC/Rental returns are not supported here.",
      ],
    }
  }

  if (!batchTxns.every((r) => r.movement_type === movementType)) {
    return { ok: false, status: 400, error: "Batch mixes movement types; cannot reverse automatically." }
  }

  const dupes = duplicateSerialsInBatch(batchTxns)
  if (dupes.length > 0) {
    return {
      ok: false,
      status: 409,
      error: "Batch has duplicate serial rows; cannot reverse automatically.",
      detail: dupes.map((s) => `${s}: appears more than once in this batch`),
    }
  }

  const plan: PlanEntry[] = []
  const errors: string[] = []

  if (movementType === "Transfer") {
    for (const txn of batchTxns) {
      const serial = txn.serial_number.trim()
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
      const toLoc = txn.to_location?.trim() ?? ""
      if (toLoc && item.location !== toLoc) {
        errors.push(
          `${serial}: current location "${item.location}" does not match transfer destination "${toLoc}"`
        )
        continue
      }
      const backTo = (txn.from_location?.trim() || returnLocation) as InternalLocation | string
      plan.push({
        kind: "transfer",
        serial,
        inventoryId: item.id,
        next: { ...item, location: backTo },
        transactionId: txn.id,
        expectedLocation: toLoc,
      })
    }
  } else if (movementType === "Inbound") {
    for (const txn of batchTxns) {
      const entry = await planInboundEntry(supabase, txn, batchId, returnLocation, errors)
      if (entry) plan.push(entry)
    }
  } else {
    const required = REQUIRED_STATUS[movementType]
    if (!required) {
      return { ok: false, status: 400, error: "Unsupported movement for stock reversal" }
    }
    const patch = patchOutboundRevert(movementType, returnLocation)

    for (const txn of batchTxns) {
      const serial = txn.serial_number.trim()
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
      plan.push({
        kind: "full",
        serial,
        inventoryId: item.id,
        next: { ...item, ...patch },
        transactionId: txn.id,
        expectedStatus: required,
      })
    }
  }

  if (errors.length > 0) {
    return { ok: false, status: 409, error: "Cannot reverse batch — fix items or choose another approach.", detail: errors }
  }

  if (plan.length !== batchTxns.length) {
    return {
      ok: false,
      status: 409,
      error: "Reversal plan does not cover every transaction in the batch.",
      detail: [`Planned ${plan.length} of ${batchTxns.length} transaction row(s).`],
    }
  }

  const rpcEntries: ReverseQuickScanRpcEntry[] = plan.map((entry) => ({
    serial: entry.serial,
    entry_kind: entry.kind,
    inventory_id: entry.inventoryId,
    transaction_id: entry.transactionId,
    reverted_row:
      entry.kind === "delete"
        ? ({} as Database["public"]["Tables"]["inventory_items"]["Insert"])
        : inventoryItemToRow(entry.next),
    expected_status: entry.kind === "transfer" ? null : entry.expectedStatus,
    expected_location: entry.kind === "transfer" ? entry.expectedLocation : null,
  }))

  const reversalBatchId = `BATCH-REV-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const reversalLedgerRow = buildReversalLedgerRow({
    batchId,
    batchTxns,
    reversalBatchId,
    reversalReason,
    returnLocation,
    originalMovementType: movementType,
    createdBy,
  })

  const { data, error } = await supabase.rpc("reverse_quick_scan_batch", {
    p_batch_id: batchId,
    p_entries: rpcEntries,
    p_reversal_transactions: [reversalLedgerRow],
    p_reason: reversalReason,
  })
  if (error) {
    const msg = error.message ?? ""
    if (/reverse_quick_scan_batch:\s*forbidden/i.test(msg)) {
      return {
        ok: false,
        status: 403,
        error: "Only admins can reverse scan batches",
        detail: [msg],
      }
    }
    if (/reason must be at least/i.test(msg)) {
      return {
        ok: false,
        status: 400,
        error: "Reason must be at least 15 characters",
        detail: [msg],
      }
    }
    return {
      ok: false,
      status: 500,
      error: "Failed to reverse batch atomically.",
      detail: [msg],
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

  const requestedCount = Number(rpc.requested_count ?? batchTxns.length)
  const batchTxnCount = Number(rpc.batch_txn_count ?? batchTxns.length)
  const reversedCount = Number(rpc.reversed_count ?? 0)
  const alreadyReversedCount = Number(rpc.already_reversed_count ?? 0)
  const remainingBatchTxns = Number(rpc.remaining_batch_txns ?? 0)
  const reversedSerials = Array.isArray(rpc.reversed_serials) ? rpc.reversed_serials : []
  const alreadyReversedSerials = Array.isArray(rpc.already_reversed_serials) ? rpc.already_reversed_serials : []

  if (requestedCount !== batchTxnCount || plan.length !== batchTxnCount) {
    return {
      ok: false,
      status: 409,
      error: "Batch reversal did not cover every transaction row.",
      detail: [`Expected ${batchTxnCount} row(s); plan had ${plan.length}.`],
    }
  }

  if (remainingBatchTxns > 0) {
    return {
      ok: false,
      status: 409,
      error: "Batch reversal left trailing transaction rows.",
      detail: [`${remainingBatchTxns} transaction row(s) still reference this batch.`],
    }
  }

  const completeness = await getQuickScanBatchReversalCompleteness(supabase, batchId)
  if (!completeness) {
    return {
      ok: false,
      status: 500,
      error: "Reversal applied but completeness could not be verified.",
    }
  }
  if (completeness.remainingTransactions > 0) {
    return {
      ok: false,
      status: 409,
      error: "Batch reversal left trailing transaction rows.",
      detail: [
        `${completeness.remainingTransactions} transaction row(s) still in batch.`,
        ...(completeness.nonRevertedSerials.length > 0
          ? [`Non-reverted serial(s): ${completeness.nonRevertedSerials.join(", ")}`]
          : []),
      ],
    }
  }
  if (completeness.nonRevertedSerials.length > 0) {
    return {
      ok: false,
      status: 409,
      error: "Batch reversal did not revert all inventory rows.",
      detail: [`Non-reverted serial(s): ${completeness.nonRevertedSerials.join(", ")}`],
    }
  }

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
    reversalBatchId,
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
    .select("serial_number, status, location, deleted_at")
    .in("serial_number", serials)
  if (invErr) {
    console.error("getQuickScanBatchReversalCompleteness inventory_items:", invErr)
    return null
  }

  const invBySerial = new Map((invRows ?? []).map((r) => [r.serial_number, r]))
  const outgoingStatus: Record<string, string> = {
    Inbound: "In Stock",
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
    if (tx.type === "Inbound") {
      if (inv.deleted_at == null && inv.status === "In Stock") nonRevertedSerials.add(serial)
      continue
    }
    const outStatus = outgoingStatus[tx.type]
    if (outStatus && inv.deleted_at == null && inv.status === outStatus) nonRevertedSerials.add(serial)
  }

  return {
    batchId,
    batchReversalExists: Boolean(rev?.batch_id),
    remainingTransactions,
    nonRevertedSerials: [...nonRevertedSerials].sort(),
  }
}
