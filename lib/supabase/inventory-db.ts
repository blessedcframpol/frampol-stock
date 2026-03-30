import type { InventoryItem, Transaction } from "@/lib/data"
import type { Database } from "./database.types"

type InventoryRow = Database["public"]["Tables"]["inventory_items"]["Row"]
type TransactionRow = Database["public"]["Tables"]["transactions"]["Row"]

export function rowToInventoryItem(row: InventoryRow): InventoryItem {
  const raw = row.assignment_history as { date: string; assignedTo?: string; assigned_to?: string; notes?: string }[] | null
  const assignmentHistory = raw?.map((h) => ({
    date: h.date,
    assignedTo: h.assignedTo ?? h.assigned_to ?? "",
    notes: h.notes,
  }))
  return {
    id: row.id,
    serialNumber: row.serial_number,
    itemType: row.item_type as InventoryItem["itemType"],
    productTypeId: row.product_type_id ?? undefined,
    name: row.name,
    category: row.category ?? undefined,
    status: row.status as InventoryItem["status"],
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
  }
}

export function inventoryItemToRow(item: InventoryItem): Database["public"]["Tables"]["inventory_items"]["Insert"] {
  const history = item.assignmentHistory?.map((h) => ({
    date: h.date,
    assignedTo: h.assignedTo,
    notes: h.notes,
  }))
  return {
    id: item.id,
    serial_number: item.serialNumber,
    item_type: item.itemType,
    product_type_id: item.productTypeId ?? "ptype-general",
    name: item.name,
    category: item.category ?? null,
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
  }
}

export function rowToTransaction(row: TransactionRow): Transaction {
  const r = row as TransactionRow & { disposal_reason?: string | null; authorised_by?: string | null; batch_id?: string | null; delivery_note_url?: string | null }
  return {
    id: row.id,
    type: row.type as Transaction["type"],
    serialNumber: row.serial_number,
    itemName: row.item_name,
    client: row.client,
    date: row.date,
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
  }
}
