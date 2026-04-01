import type { InventoryItem, ItemType, Transaction, TransactionType } from "@/lib/data"

/**
 * Given current inventory and movement params, compute the updated items and new transactions.
 * Pure function for use with Supabase persist + state update.
 */
/** Default rental period (days from out date) when returnDate not provided */
const DEFAULT_RENTAL_DAYS = 30

/** Outbound types where FortiGate cloud keys are applied to inventory rows */
const OUTBOUND_CLOUD_KEY_TYPES: ReadonlySet<TransactionType> = new Set([
  "Sale",
  "POC Out",
  "Rentals",
  "Transfer",
  "Dispose",
])

export type InboundCreateDefaults = {
  name: string
  itemType: ItemType
  category: string
  location: string
  productTypeId?: string
}

export function computeMovementResult(
  inventory: InventoryItem[],
  params: {
    type: TransactionType
    serialNumbers: string[]
    clientDisplay: string
    /** When client selected from directory */
    clientId?: string
    fromLocation?: string
    toLocation?: string
    assignedTo?: string
    invoiceNumber?: string
    notes?: string
    /** For Rentals: due date (ISO date). Defaults to DEFAULT_RENTAL_DAYS from today. */
    returnDate?: string
    /** For Dispose: reason and who authorised */
    disposalReason?: string
    authorisedBy?: string
    /** When type is POC Out or Rentals: batch to associate these transactions with */
    batchId?: string
    /** For Inbound: public URL of uploaded delivery note */
    deliveryNoteUrl?: string
    /** When Inbound: create new inventory rows for unknown serials */
    inboundCreateDefaults?: InboundCreateDefaults
    /** When moving FortiGate units out: serial → cloud key (not used on inbound) */
    cloudKeysBySerial?: Record<string, string>
  }
): {
  success: string[]
  notFound: string[]
  updatedItems: InventoryItem[]
  newTransactions: Transaction[]
} {
  const {
    type,
    serialNumbers,
    clientDisplay,
    clientId,
    fromLocation,
    toLocation,
    assignedTo,
    invoiceNumber,
    notes,
    returnDate,
    disposalReason,
    authorisedBy,
    batchId,
    deliveryNoteUrl,
    inboundCreateDefaults,
    cloudKeysBySerial,
  } = params
  const date = new Date().toISOString()
  const defaultReturnDate = (() => {
    const d = new Date()
    d.setDate(d.getDate() + DEFAULT_RENTAL_DAYS)
    return d.toISOString().slice(0, 10)
  })()
  const success: string[] = []
  const updatedItems: InventoryItem[] = []
  const newTransactions: Transaction[] = []

  const next = inventory.map((item) => ({ ...item }))
  const idBase = Date.now()

  for (const serial of serialNumbers) {
    const trimmed = serial.trim()
    if (!trimmed) continue
    const idx = next.findIndex((i) => i.serialNumber === trimmed)

    if (idx === -1) {
      if (type === "Inbound" && inboundCreateDefaults) {
        const d = inboundCreateDefaults
        const cat = d.category?.trim() ? d.category.trim() : "General"
        const newItem: InventoryItem = {
          id: `INV-${idBase}-${success.length}-${Math.random().toString(36).slice(2, 9)}`,
          serialNumber: trimmed,
          itemType: d.itemType,
          productTypeId: d.productTypeId,
          name: d.name,
          category: cat,
          status: "In Stock",
          dateAdded: date.slice(0, 10),
          location: d.location,
        }
        next.push(newItem)
        success.push(trimmed)
        updatedItems.push(newItem)
        newTransactions.push({
          id: `TXN-${Date.now()}-${success.length}-${Math.random().toString(36).slice(2, 9)}`,
          type,
          serialNumber: trimmed,
          itemName: newItem.name,
          client: clientDisplay,
          date,
          clientId,
          invoiceNumber,
          notes,
          assignedTo: undefined,
          fromLocation: undefined,
          toLocation: undefined,
          disposalReason: undefined,
          authorisedBy: undefined,
          batchId: batchId ?? undefined,
          deliveryNoteUrl: deliveryNoteUrl ?? undefined,
        })
      }
      continue
    }

    success.push(trimmed)
    const it = next[idx]!
    const history = [...(it.assignmentHistory ?? [])]

    switch (type) {
      case "Inbound":
        it.status = "In Stock"
        it.location = toLocation ?? it.location
        it.client = undefined
        it.assignedTo = undefined
        break
      case "Sale":
        it.status = "Sold"
        it.location = "Delivered"
        it.client = clientDisplay
        it.assignedTo = assignedTo ?? clientDisplay
        if (assignedTo) history.push({ date: date.slice(0, 10), assignedTo, notes })
        break
      case "POC Out":
        it.status = "POC"
        it.location = "Client Site"
        it.client = clientDisplay
        it.assignedTo = assignedTo ?? clientDisplay
        it.pocOutDate = date.slice(0, 10)
        if (returnDate) it.returnDate = returnDate
        if (assignedTo) history.push({ date: date.slice(0, 10), assignedTo, notes: "POC Out" })
        break
      case "POC Return":
        it.status = "In Stock"
        it.location = toLocation ?? "Warehouse A"
        it.client = undefined
        it.assignedTo = undefined
        it.pocOutDate = undefined
        it.returnDate = undefined
        break
      case "Rental Return":
        it.status = "In Stock"
        it.location = toLocation ?? "Warehouse A"
        it.client = undefined
        it.assignedTo = undefined
        it.pocOutDate = undefined
        it.returnDate = undefined
        break
      case "Rentals":
        it.status = "Rented"
        it.location = "Client Site"
        it.client = clientDisplay
        it.assignedTo = assignedTo ?? clientDisplay
        it.pocOutDate = date.slice(0, 10)
        it.returnDate = returnDate ?? defaultReturnDate
        if (assignedTo) history.push({ date: date.slice(0, 10), assignedTo, notes: "Rental" })
        break
      case "Transfer":
        it.location = toLocation ?? it.location
        break
      case "Dispose":
        it.status = "Disposed"
        it.client = undefined
        it.assignedTo = undefined
        break
    }
    if (cloudKeysBySerial && OUTBOUND_CLOUD_KEY_TYPES.has(type)) {
      const k = cloudKeysBySerial[trimmed]
      if (k !== undefined) it.cloudKey = k.trim() || undefined
    }
    it.assignmentHistory = history.length ? history : it.assignmentHistory
    next[idx] = it
    updatedItems.push(it)
    newTransactions.push({
      id: `TXN-${Date.now()}-${success.length}-${Math.random().toString(36).slice(2, 9)}`,
      type,
      serialNumber: trimmed,
      itemName: it.name,
      client: clientDisplay,
      date,
      clientId,
      invoiceNumber,
      notes,
      assignedTo: assignedTo ?? (type === "Sale" || type === "POC Out" || type === "Rentals" ? clientDisplay : undefined),
      fromLocation: type === "Transfer" ? fromLocation : undefined,
      toLocation: type === "Transfer" || type === "POC Return" || type === "Rental Return" ? toLocation : undefined,
      disposalReason: type === "Dispose" ? disposalReason : undefined,
      authorisedBy: type === "Dispose" ? authorisedBy : undefined,
      batchId: batchId ?? undefined,
      deliveryNoteUrl: type === "Inbound" ? deliveryNoteUrl : undefined,
    })
  }

  const notFound = serialNumbers.filter((s) => s.trim() && !success.includes(s.trim()))
  return { success, notFound, updatedItems, newTransactions }
}
