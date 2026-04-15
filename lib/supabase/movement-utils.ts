import type { InventoryItem, ItemStatus, Transaction, TransactionType } from "@/lib/data"

/**
 * Given current inventory and movement params, compute the updated items and new transactions.
 * Pure function for use with Supabase persist + state update.
 */
/** Default rental period (days from out date) when returnDate not provided */
const DEFAULT_RENTAL_DAYS = 30

/** YYYY-MM-DD or parseable ISO → transaction `date` string; missing/invalid → fallback */
function resolveSaleTransactionDate(input: string | undefined, fallbackIso: string): string {
  const raw = input?.trim()
  if (!raw) return fallbackIso
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(`${raw}T00:00:00.000Z`)
    return Number.isNaN(d.getTime()) ? fallbackIso : d.toISOString()
  }
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? fallbackIso : d.toISOString()
}

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
  vendor: string
  location: string
}

export type MovementRejection = { serial: string; reason: string }

export type MovementValidationContext = {
  fromLocation?: string
  /** When set, existing row must match this product name (case-insensitive). */
  expectedProductName?: string
  /** When set, normalized vendor (empty → General) must match. */
  expectedVendor?: string
}

function normalizeInventoryVendor(value: string | undefined | null): string {
  const t = (value ?? "").trim()
  return t || "General"
}

function stringsMatchCi(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** When any expectation is set, existing inventory rows must match (after trash check). */
function validateProductExpectations(item: InventoryItem, ctx: MovementValidationContext): string | null {
  const expName = ctx.expectedProductName?.trim()
  if (expName && !stringsMatchCi(item.name, expName)) {
    return `Serial is registered as "${item.name}", not the selected product`
  }
  const expVendor = ctx.expectedVendor?.trim()
  if (expVendor) {
    const got = normalizeInventoryVendor(item.vendor)
    const want = normalizeInventoryVendor(expVendor)
    if (got.toLowerCase() !== want.toLowerCase()) {
      return `Vendor mismatch (item is ${got}, expected ${want})`
    }
  }
  return null
}

/**
 * State machine for stock movements (see plan: movement integrity).
 * Returns a short reason when the movement is not allowed, or null when allowed.
 */
export function validateMovementForItem(
  type: TransactionType,
  item: InventoryItem,
  ctx: MovementValidationContext
): string | null {
  if (item.deletedAt) return "Item is in Trash and cannot be moved"

  const productReason = validateProductExpectations(item, ctx)
  if (productReason) return productReason

  const st = item.status as ItemStatus

  switch (type) {
    case "Sale":
    case "POC Out":
    case "Rentals":
      if (st !== "In Stock") return `Not available for ${type} (status is ${st}, need In Stock)`
      return null
    case "Dispose":
      if (st !== "In Stock" && st !== "Maintenance" && st !== "RMA Hold") {
        return `Cannot dispose (status is ${st})`
      }
      return null
    case "Transfer":
      if (st !== "In Stock" && st !== "Maintenance" && st !== "RMA Hold") {
        return `Cannot transfer (status is ${st})`
      }
      if (ctx.fromLocation?.trim() && item.location !== ctx.fromLocation.trim()) {
        return `Item is at ${item.location}, not ${ctx.fromLocation.trim()}`
      }
      return null
    case "Inbound":
      if (st === "In Stock") return "Already in stock — cannot receive again"
      if (st === "Sold" || st === "POC" || st === "Rented" || st === "Disposed") {
        return `Use POC Return, Rental Return, Sale Return, or undo — not Inbound (status is ${st})`
      }
      if (st === "Maintenance" || st === "RMA Hold") return null
      return `Inbound not allowed (status is ${st})`
    case "POC Return":
      if (st !== "POC") return `POC Return requires status POC (current: ${st})`
      return null
    case "Rental Return":
      if (st !== "Rented") return `Rental Return requires status Rented (current: ${st})`
      return null
    case "Sale Return":
      if (st !== "Sold") return `Sale Return requires status Sold (current: ${st})`
      return null
    default:
      return null
  }
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
    /**
     * TEMPORARY (admin UI only): Sale ledger date for catch-up entry; ignored unless type === "Sale".
     */
    saleTransactionDateIso?: string
    expectedProductName?: string
    expectedVendor?: string
  }
): {
  success: string[]
  notFound: string[]
  rejected: MovementRejection[]
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
    saleTransactionDateIso,
    expectedProductName,
    expectedVendor,
  } = params
  const nowIso = new Date().toISOString()
  const date = type === "Sale" ? resolveSaleTransactionDate(saleTransactionDateIso, nowIso) : nowIso
  const defaultReturnDate = (() => {
    const d = new Date()
    d.setDate(d.getDate() + DEFAULT_RENTAL_DAYS)
    return d.toISOString().slice(0, 10)
  })()
  const success: string[] = []
  const rejected: MovementRejection[] = []
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
        const v = d.vendor?.trim() ? d.vendor.trim() : "General"
        const newItem: InventoryItem = {
          id: `INV-${idBase}-${success.length}-${Math.random().toString(36).slice(2, 9)}`,
          serialNumber: trimmed,
          name: d.name,
          vendor: v,
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

    const it = next[idx]!
    const reason = validateMovementForItem(type, it, {
      fromLocation,
      expectedProductName,
      expectedVendor,
    })
    if (reason) {
      rejected.push({ serial: trimmed, reason })
      continue
    }

    success.push(trimmed)
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
      case "Sale Return":
        it.status = "RMA Hold"
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
      toLocation:
        type === "Transfer" || type === "POC Return" || type === "Rental Return" || type === "Sale Return"
          ? toLocation
          : undefined,
      disposalReason: type === "Dispose" ? disposalReason : undefined,
      authorisedBy: type === "Dispose" ? authorisedBy : undefined,
      batchId: batchId ?? undefined,
      deliveryNoteUrl: type === "Inbound" ? deliveryNoteUrl : undefined,
    })
  }

  const rejectedSerials = new Set(rejected.map((r) => r.serial))
  const notFound = serialNumbers.filter(
    (s) => {
      const t = s.trim()
      return Boolean(t) && !success.includes(t) && !rejectedSerials.has(t)
    }
  )
  return { success, notFound, rejected, updatedItems, newTransactions }
}
