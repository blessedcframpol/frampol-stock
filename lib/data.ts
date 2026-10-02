export type ItemStatus =
  | "In Stock"
  | "Sold"
  | "POC"
  | "Rented"
  | "Maintenance"
  | "RMA Hold"
  | "Disposed"
  | "Pending Inspection"

export type JsonValue = string | number | boolean | null | { [key: string]: JsonValue | undefined } | JsonValue[]

export type TransactionType =
  | "Inbound"
  | "Sale"
  | "POC Out"
  | "POC Return"
  | "Rental Return"
  | "Sale Return"
  | "Transfer"
  | "Dispose"
  | "Rentals"
  | "Decommissioned"
  | "Inspection Pass"
  | "Inspection Fail"
  | "Remediation Loaner Issue"
  | "Reversal"

export const LOCATIONS = ["Warehouse A", "Warehouse B", "Service Center", "Client Site", "Delivered"] as const
export type Location = (typeof LOCATIONS)[number]

/** Warehouses / service only — used when returning stock from outbound quick scans. */
export const INTERNAL_LOCATIONS = ["Warehouse A", "Warehouse B", "Service Center"] as const
export type InternalLocation = (typeof INTERNAL_LOCATIONS)[number]

export function isInternalLocation(value: string): value is InternalLocation {
  return (INTERNAL_LOCATIONS as readonly string[]).includes(value)
}

/** One site/address for a client (e.g. delivery or POC location). */
export interface ClientSite {
  name?: string
  address: string
}

export interface QuickScanRecord {
  id: string
  serialNumber: string
  /** Product name (or label used when scanning) */
  scanType: string
  scannedAt: string
  /** Stock movement type (e.g. Inbound, Transfer) when the scan was recorded */
  movementType?: TransactionType
  /** Batch ID: same for all records in one bulk/single submission; used to group history */
  batchId?: string
  /** For Sale, POC Out, Rentals, Transfer, Dispose: client and delivery/site details */
  clientId?: string
  clientName?: string
  clientCompany?: string
  clientEmail?: string
  clientPhone?: string
  sites?: ClientSite[]
  /** Set when an admin reverses the batch (row kept for audit). */
  reversedAt?: string
  reversalReason?: string
  reversedBy?: string
}

export interface AssignmentEntry {
  date: string
  assignedTo: string
  notes?: string
}

export interface InventoryItem {
  id: string
  /** FK to public.product_lines when using Supabase; optional for local seed-only mode. */
  productId?: string
  serialNumber: string
  name: string
  /** Vendor or product line for grouping (e.g. Starlink, Fortinet); empty → General in app. */
  vendor?: string
  status: ItemStatus
  dateAdded: string
  location: string
  client?: string
  /** FortiGate / vendor cloud key; set on outbound scan, optional on inbound */
  cloudKey?: string
  notes?: string
  /** Person, client, or project this item is assigned to */
  assignedTo?: string
  /** When the item was purchased/received (ISO date) */
  purchaseDate?: string
  /** Warranty or support end date (ISO date) */
  warrantyEndDate?: string
  /** When this item went out for POC (for overdue alerts) */
  pocOutDate?: string
  /** When this item is due to be returned (for rental alerts; past = overdue) */
  returnDate?: string
  assignmentHistory?: AssignmentEntry[]
  /** Set when allocated to a stock request line (Supabase). */
  reservedForRequestLineId?: string
  /** When set (ISO), item is in trash; omitted from normal inventory lists. */
  deletedAt?: string
}

export interface Transaction {
  id: string
  type: TransactionType
  serialNumber: string
  itemName: string
  client: string
  date: string
  /** When the row was recorded. Absent for legacy business dates with no batch timestamp. */
  createdAt?: string
  /** Reference to clients.id when client selected from directory */
  clientId?: string
  invoiceNumber?: string
  notes?: string
  /** For Transfer: origin location */
  fromLocation?: string
  /** For Transfer: destination location */
  toLocation?: string
  /** Who the item is assigned to (for POC Out, Sale, etc.) */
  assignedTo?: string
  /** For Dispose: reason (e.g. beyond repair, lost, end of life) */
  disposalReason?: string
  /** For Dispose: who authorised the disposal */
  authorisedBy?: string
  /** When part of a POC Out or Rentals batch */
  batchId?: string
  /** For Inbound: private uploads bucket object path for the delivery note. */
  deliveryNoteUrl?: string
  /** Structured fields (decommission, inspection, remediation); persisted when using Supabase */
  metadata?: JsonValue
  /** User who recorded the transaction (Supabase auth user id) */
  createdBy?: string
  /** Status before this movement. Null means the movement created the row. */
  previousStatus?: string | null
  previousStatusSource?: "recorded" | "derived" | "unknown"
  reversesTransactionId?: string
}

export interface Client {
  id: string
  name: string
  company: string
  email: string
  phone: string
  /** First site address; mirrors sites[0] when sites are stored */
  address?: string
  /** Office / branch / delivery locations */
  sites?: ClientSite[]
  totalOrders: number
  totalSpent: number
  lastOrder: string
}

/** App/team user (searchable; can be extended with auth later) */
export interface AppUser {
  id: string
  name: string
  email: string
  role?: string
}

/** One row in stock take snapshot (matched or not scanned item) for persistence */
export interface StockTakeSnapshotItem {
  serialNumber: string
  name: string
  status: string
  location: string
  vendor?: string
}

export type StockTakeScopePreset = "full" | "vendor" | "vendor_product" | "selected" | "custom"

/** Filters defining which inventory rows are expected during a stock take. */
export interface StockTakeScope {
  preset?: StockTakeScopePreset
  label?: string
  vendors?: string[]
  productNames?: string[]
  locations?: string[]
  statuses?: ItemStatus[]
  serialAllowList?: string[]
}

/** Snapshot of a completed stock take (stored in DB for read-only history) */
export interface StockTakeSnapshot {
  scannedSerials: string[]
  /** Scope at time of completion (optional on older records). */
  scope?: StockTakeScope
  expectedCount?: number
  matched: StockTakeSnapshotItem[]
  notInSystem: string[]
  notScanned: StockTakeSnapshotItem[]
  /** Scanned serials in system but outside scope (optional on older records). */
  outOfScope?: StockTakeSnapshotItem[]
}

/** Persisted stock take record (from API/DB) */
export interface StockTakeRecord {
  id: string
  completedAt: string
  resultSnapshot: StockTakeSnapshot
}
