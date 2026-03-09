import type { InventoryItem, Transaction, TransactionType } from "@/lib/data"

/**
 * Given current inventory and movement params, compute the updated items and new transactions.
 * Pure function for use with Supabase persist + state update.
 */
export function computeMovementResult(
  inventory: InventoryItem[],
  params: {
    type: TransactionType
    serialNumbers: string[]
    clientDisplay: string
    fromLocation?: string
    toLocation?: string
    assignedTo?: string
    invoiceNumber?: string
    notes?: string
  }
): {
  success: string[]
  notFound: string[]
  updatedItems: InventoryItem[]
  newTransactions: Transaction[]
} {
  const { type, serialNumbers, clientDisplay, fromLocation, toLocation, assignedTo, invoiceNumber, notes } = params
  const date = new Date().toISOString().slice(0, 10)
  const success: string[] = []
  const updatedItems: InventoryItem[] = []
  const newTransactions: Transaction[] = []

  const next = inventory.map((item) => ({ ...item }))
  for (const serial of serialNumbers) {
    const trimmed = serial.trim()
    if (!trimmed) continue
    const idx = next.findIndex((i) => i.serialNumber === trimmed)
    if (idx === -1) continue
    success.push(trimmed)
    const it = next[idx]
    const history = [...(it.assignmentHistory ?? [])]

    switch (type) {
      case "Inbound":
        it.status = "In Stock"
        it.location = toLocation ?? it.location
        it.client = undefined
        it.assignedTo = undefined
        break
      case "Outbound":
        it.status = "Sold"
        it.location = "Delivered"
        it.client = clientDisplay
        it.assignedTo = assignedTo ?? clientDisplay
        if (assignedTo) history.push({ date, assignedTo, notes })
        break
      case "POC Out":
        it.status = "POC"
        it.location = "Client Site"
        it.client = clientDisplay
        it.assignedTo = assignedTo ?? clientDisplay
        it.pocOutDate = date
        if (assignedTo) history.push({ date, assignedTo, notes: "POC Out" })
        break
      case "POC Return":
        it.status = "In Stock"
        it.location = toLocation ?? "Warehouse A"
        it.client = undefined
        it.assignedTo = undefined
        it.pocOutDate = undefined
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
      invoiceNumber,
      notes,
      assignedTo: assignedTo ?? (type === "Outbound" || type === "POC Out" ? clientDisplay : undefined),
      fromLocation: type === "Transfer" ? fromLocation : undefined,
      toLocation: type === "Transfer" || type === "POC Return" ? toLocation : undefined,
    })
  }

  const notFound = serialNumbers.filter((s) => s.trim() && !success.includes(s.trim()))
  return { success, notFound, updatedItems, newTransactions }
}
