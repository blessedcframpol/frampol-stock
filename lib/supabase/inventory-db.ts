import type { InventoryItem, Transaction } from "@/lib/data"
import type { Database } from "./database.types"

type InventoryRow = Database["public"]["Tables"]["inventory_items"]["Row"]
type TransactionRow = Database["public"]["Tables"]["transactions"]["Row"]

/** Embed from PostgREST when selecting inventory with FK to product_lines. */
export type ProductLineEmbed = { product_name: string; vendor: string }

export type InventoryItemQueryRow = InventoryRow & {
  product_lines: ProductLineEmbed | null
}

/** Use on all inventory_items reads that must populate name/vendor for the app. */
export const INVENTORY_ITEM_SELECT = "*, product_lines(product_name, vendor)"

export function rowToInventoryItem(row: InventoryItemQueryRow | InventoryRow): InventoryItem {
  const pl = "product_lines" in row ? row.product_lines : null
  const name = pl?.product_name ?? (row as InventoryRow & { name?: string }).name ?? ""
  const vendorRaw = pl?.vendor ?? (row as InventoryRow & { vendor?: string | null }).vendor
  const raw = row.assignment_history as { date: string; assignedTo?: string; assigned_to?: string; notes?: string }[] | null
  const assignmentHistory = raw?.map((h) => ({
    date: h.date,
    assignedTo: h.assignedTo ?? h.assigned_to ?? "",
    notes: h.notes,
  }))
  return {
    id: row.id,
    productId: row.product_id,
    serialNumber: row.serial_number,
    name,
    vendor: vendorRaw?.trim() ? vendorRaw : "General",
    status: row.status as InventoryItem["status"],
    stockPool: row.stock_pool === "rental" || row.stock_pool === "demo" ? row.stock_pool : "sale",
    dateAdded: row.date_added,
    location: row.location,
    client: row.client ?? undefined,
    notes: row.notes ?? undefined,
    assignedTo: row.assigned_to ?? undefined,
    purchaseDate: row.purchase_date ?? undefined,
    warrantyEndDate: row.warranty_end_date ?? undefined,
    pocOutDate: row.poc_out_date ?? undefined,
    returnDate: row.return_date ?? undefined,
    assignmentHistory: assignmentHistory ?? undefined,
    reservedForRequestLineId: row.reserved_for_request_line_id ?? undefined,
    cloudKey: row.cloud_key ?? undefined,
    deletedAt: row.deleted_at ? String(row.deleted_at) : undefined,
  }
}

export function inventoryItemToRow(item: InventoryItem): Database["public"]["Tables"]["inventory_items"]["Insert"] {
  const history = item.assignmentHistory?.map((h) => ({
    date: h.date,
    assignedTo: h.assignedTo,
    notes: h.notes,
  }))
  if (!item.productId) {
    throw new Error("inventoryItemToRow: productId is required for Supabase persistence")
  }
  return {
    id: item.id,
    product_id: item.productId,
    serial_number: item.serialNumber,
    status: item.status,
    date_added: item.dateAdded,
    location: item.location,
    client: item.client ?? null,
    notes: item.notes ?? null,
    assigned_to: item.assignedTo ?? null,
    purchase_date: item.purchaseDate ?? null,
    warranty_end_date: item.warrantyEndDate ?? null,
    poc_out_date: item.pocOutDate ?? null,
    return_date: item.returnDate ?? null,
    assignment_history: history ?? null,
    reserved_for_request_line_id: item.reservedForRequestLineId ?? null,
    cloud_key: item.cloudKey ?? null,
    deleted_at: item.deletedAt ?? null,
  }
}

export function rowToTransaction(
  row: Omit<
    TransactionRow,
    | "previous_status"
    | "previous_status_source"
    | "previous_location"
    | "previous_client"
    | "previous_assigned_to"
    | "previous_poc_out_date"
    | "previous_return_date"
    | "after_status"
    | "after_location"
    | "after_client"
    | "after_assigned_to"
    | "after_poc_out_date"
    | "after_return_date"
    | "previous_stock_pool"
    | "after_stock_pool"
    | "reverses_transaction_id"
  > & {
    previous_status?: string | null
    previous_status_source?: string | null
    reverses_transaction_id?: string | null
  }
): Transaction {
  const r = row as TransactionRow & {
    disposal_reason?: string | null
    authorised_by?: string | null
    batch_id?: string | null
    delivery_note_url?: string | null
    metadata?: unknown
    created_by?: string | null
    created_at?: string | null
  }
  return {
    id: row.id,
    type: row.type as Transaction["type"],
    serialNumber: row.serial_number,
    itemName: row.item_name,
    client: row.client,
    date: row.date,
    createdAt: r.created_at ?? undefined,
    clientId: row.client_id ?? undefined,
    invoiceNumber: row.invoice_number ?? undefined,
    notes: row.notes ?? undefined,
    fromLocation: row.from_location ?? undefined,
    toLocation: row.to_location ?? undefined,
    assignedTo: row.assigned_to ?? undefined,
    disposalReason: r.disposal_reason ?? undefined,
    authorisedBy: r.authorised_by ?? undefined,
    batchId: r.batch_id ?? undefined,
    deliveryNoteUrl: r.delivery_note_url ?? undefined,
    metadata: r.metadata != null ? (r.metadata as Transaction["metadata"]) : undefined,
    createdBy: r.created_by ?? undefined,
    previousStatus: row.previous_status,
    previousStatusSource:
      row.previous_status_source === "recorded" ||
      row.previous_status_source === "derived" ||
      row.previous_status_source === "unknown"
        ? row.previous_status_source
        : undefined,
    reversesTransactionId: row.reverses_transaction_id ?? undefined,
  }
}

export function transactionToRow(txn: Transaction): Database["public"]["Tables"]["transactions"]["Insert"] {
  return {
    id: txn.id,
    type: txn.type,
    serial_number: txn.serialNumber,
    item_name: txn.itemName,
    client: txn.client,
    date: txn.date,
    client_id: txn.clientId ?? null,
    invoice_number: txn.invoiceNumber ?? null,
    notes: txn.notes ?? null,
    from_location: txn.fromLocation ?? null,
    to_location: txn.toLocation ?? null,
    assigned_to: txn.assignedTo ?? null,
    disposal_reason: txn.disposalReason ?? null,
    authorised_by: txn.authorisedBy ?? null,
    batch_id: txn.batchId ?? null,
    delivery_note_url: txn.deliveryNoteUrl ?? null,
    metadata: txn.metadata != null ? (txn.metadata as Database["public"]["Tables"]["transactions"]["Row"]["metadata"]) : null,
    created_by: txn.createdBy ?? null,
  }
}
