export type ItemType = "Starlink Kit" | "Laptop" | "Desktop" | "Router" | "Switch" | "Access Point" | "UPS" | "Monitor"
export type ItemStatus = "In Stock" | "Sold" | "POC" | "Maintenance" | "Disposed"
export type TransactionType = "Inbound" | "Sale" | "POC Out" | "POC Return" | "Transfer" | "Dispose" | "Rentals"

export const LOCATIONS = ["Warehouse A", "Warehouse B", "Service Center", "Client Site", "Delivered"] as const
export type Location = (typeof LOCATIONS)[number]

/** One site/address for a client (e.g. delivery or POC location). */
export interface ClientSite {
  name?: string
  address: string
}

export interface QuickScanRecord {
  id: string
  serialNumber: string
  /** Product name or item type (e.g. "Cisco Catalyst 9200L-24P" or "Starlink Kit") */
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
}

export interface AssignmentEntry {
  date: string
  assignedTo: string
  notes?: string
}

/** Category/family for drill-down (e.g. Starlink, Fortinet) */
export type InventoryCategory = "Starlink" | "Fortinet"

export interface InventoryItem {
  id: string
  serialNumber: string
  itemType: ItemType
  name: string
  /** Family/category for hierarchy (e.g. Starlink, Fortinet). Optional for backward compat. */
  category?: InventoryCategory | string
  status: ItemStatus
  dateAdded: string
  location: string
  client?: string
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
}

export interface Transaction {
  id: string
  type: TransactionType
  serialNumber: string
  itemName: string
  client: string
  date: string
  invoiceNumber?: string
  notes?: string
  /** For Transfer: origin location */
  fromLocation?: string
  /** For Transfer: destination location */
  toLocation?: string
  /** Who the item is assigned to (for POC Out, Sale, etc.) */
  assignedTo?: string
}

export interface Client {
  id: string
  name: string
  company: string
  email: string
  phone: string
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

export const inventoryItems: InventoryItem[] = [
  { id: "INV001", serialNumber: "SL-2024-00142", itemType: "Starlink Kit", name: "Starlink Standard Kit v3", status: "In Stock", dateAdded: "2024-11-15", location: "Warehouse A", purchaseDate: "2024-11-01", warrantyEndDate: "2027-11-01" },
  { id: "INV002", serialNumber: "SL-2024-00143", itemType: "Starlink Kit", name: "Starlink Business Kit", status: "POC", dateAdded: "2024-11-10", location: "Client Site", client: "Kigali Mining Co.", assignedTo: "Kigali Mining Co.", purchaseDate: "2024-10-15", warrantyEndDate: "2027-10-15", pocOutDate: "2024-11-10" },
  { id: "INV003", serialNumber: "DL-XPS-99821", itemType: "Laptop", name: "Dell XPS 15 9530", status: "Sold", dateAdded: "2024-10-22", location: "Delivered", client: "BK TechHub", assignedTo: "BK TechHub", purchaseDate: "2024-09-01", warrantyEndDate: "2025-09-01" },
  { id: "INV004", serialNumber: "HP-ELT-44521", itemType: "Laptop", name: "HP EliteBook 840 G10", status: "In Stock", dateAdded: "2024-11-18", location: "Warehouse B", purchaseDate: "2024-11-01", warrantyEndDate: "2027-11-01" },
  { id: "INV005", serialNumber: "LNV-THK-78432", itemType: "Laptop", name: "Lenovo ThinkPad X1 Carbon", status: "Maintenance", dateAdded: "2024-09-05", location: "Service Center", purchaseDate: "2024-06-01", warrantyEndDate: "2025-06-01" },
  { id: "INV006", serialNumber: "CSC-MRK-10234", itemType: "Router", name: "Cisco Meraki MX68", status: "In Stock", dateAdded: "2024-11-20", location: "Warehouse A", purchaseDate: "2024-11-10", warrantyEndDate: "2026-11-10" },
  { id: "INV007", serialNumber: "CSC-SW-29183", itemType: "Switch", name: "Cisco Catalyst 9200L-24P", status: "Sold", dateAdded: "2024-10-01", location: "Delivered", client: "RDB", assignedTo: "RDB", purchaseDate: "2024-09-15", warrantyEndDate: "2027-09-15" },
  { id: "INV008", serialNumber: "UBQ-AP-55123", itemType: "Access Point", name: "Ubiquiti UniFi U6 Pro", status: "In Stock", dateAdded: "2024-11-12", location: "Warehouse A", purchaseDate: "2024-10-20", warrantyEndDate: "2025-10-20" },
  { id: "INV009", serialNumber: "APC-UPS-88234", itemType: "UPS", name: "APC Smart-UPS 1500VA", status: "In Stock", dateAdded: "2024-11-08", location: "Warehouse B", purchaseDate: "2024-10-01", warrantyEndDate: "2025-04-01" },
  { id: "INV010", serialNumber: "SL-2024-00144", itemType: "Starlink Kit", name: "Starlink Standard Kit v3", status: "In Stock", dateAdded: "2024-11-22", location: "Warehouse A", purchaseDate: "2024-11-15", warrantyEndDate: "2027-11-15" },
  { id: "INV011", serialNumber: "DL-OPT-33214", itemType: "Desktop", name: "Dell OptiPlex 7010 SFF", status: "Sold", dateAdded: "2024-10-15", location: "Delivered", client: "MTN Rwanda", assignedTo: "MTN Rwanda", purchaseDate: "2024-09-20", warrantyEndDate: "2027-09-20" },
  { id: "INV012", serialNumber: "LG-MON-77432", itemType: "Monitor", name: 'LG UltraWide 34"', status: "In Stock", dateAdded: "2024-11-19", location: "Warehouse A", purchaseDate: "2024-11-01", warrantyEndDate: "2026-11-01" },
  { id: "INV013", serialNumber: "CSC-MRK-10235", itemType: "Router", name: "Cisco Meraki MX68", status: "POC", dateAdded: "2024-10-28", location: "Client Site", client: "I&M Bank", assignedTo: "I&M Bank", purchaseDate: "2024-10-01", warrantyEndDate: "2026-10-01", pocOutDate: "2024-10-28" },
  { id: "INV014", serialNumber: "SL-2024-00145", itemType: "Starlink Kit", name: "Starlink High Performance", status: "In Stock", dateAdded: "2024-11-25", location: "Warehouse A", purchaseDate: "2024-11-20", warrantyEndDate: "2027-11-20" },
  { id: "INV015", serialNumber: "HP-PRO-22134", itemType: "Desktop", name: "HP ProDesk 400 G9", status: "In Stock", dateAdded: "2024-11-21", location: "Warehouse B", purchaseDate: "2024-11-10", warrantyEndDate: "2027-11-10" },
]

export const recentTransactions: Transaction[] = [
  { id: "TXN001", type: "Inbound", serialNumber: "SL-2024-00145", itemName: "Starlink High Performance", client: "Supplier - SpaceX", date: "2024-11-25", invoiceNumber: "INV-2024-0891" },
  { id: "TXN002", type: "Sale", serialNumber: "DL-OPT-33214", itemName: "Dell OptiPlex 7010 SFF", client: "MTN Rwanda", date: "2024-11-24", invoiceNumber: "INV-2024-0890", assignedTo: "MTN Rwanda" },
  { id: "TXN003", type: "POC Out", serialNumber: "CSC-MRK-10235", itemName: "Cisco Meraki MX68", client: "I&M Bank", date: "2024-11-23", notes: "30-day trial", assignedTo: "I&M Bank" },
  { id: "TXN004", type: "Inbound", serialNumber: "HP-PRO-22134", itemName: "HP ProDesk 400 G9", client: "Supplier - HP Inc.", date: "2024-11-21", invoiceNumber: "INV-2024-0887" },
  { id: "TXN005", type: "Sale", serialNumber: "CSC-SW-29183", itemName: "Cisco Catalyst 9200L-24P", client: "RDB", date: "2024-11-20", invoiceNumber: "INV-2024-0885", assignedTo: "RDB" },
  { id: "TXN006", type: "POC Return", serialNumber: "UBQ-AP-55123", itemName: "Ubiquiti UniFi U6 Pro", client: "Bank of Kigali", date: "2024-11-19" },
  { id: "TXN007", type: "Sale", serialNumber: "DL-XPS-99821", itemName: "Dell XPS 15 9530", client: "BK TechHub", date: "2024-11-18", invoiceNumber: "INV-2024-0882", assignedTo: "BK TechHub" },
  { id: "TXN008", type: "Transfer", serialNumber: "LG-MON-77432", itemName: 'LG UltraWide 34"', client: "Internal", date: "2024-11-17", fromLocation: "Warehouse B", toLocation: "Warehouse A" },
]

export const clients: Client[] = [
  { id: "CLT001", name: "Jean-Pierre Habimana", company: "MTN Rwanda", email: "jp.habimana@mtn.rw", phone: "+250 788 123 456", totalOrders: 24, totalSpent: 45200, lastOrder: "2024-11-24" },
  { id: "CLT002", name: "Diane Uwimana", company: "BK TechHub", email: "d.uwimana@bktechhub.rw", phone: "+250 788 234 567", totalOrders: 18, totalSpent: 32800, lastOrder: "2024-11-18" },
  { id: "CLT003", name: "Patrick Niyonzima", company: "I&M Bank", email: "p.niyonzima@imbank.co.rw", phone: "+250 788 345 678", totalOrders: 15, totalSpent: 28500, lastOrder: "2024-11-23" },
  { id: "CLT004", name: "Grace Mukamana", company: "RDB", email: "g.mukamana@rdb.rw", phone: "+250 788 456 789", totalOrders: 12, totalSpent: 22100, lastOrder: "2024-11-20" },
  { id: "CLT005", name: "Emmanuel Ndayisaba", company: "Kigali Mining Co.", email: "e.ndayisaba@kmc.rw", phone: "+250 788 567 890", totalOrders: 9, totalSpent: 18700, lastOrder: "2024-11-10" },
  { id: "CLT006", name: "Alice Ingabire", company: "Bank of Kigali", email: "a.ingabire@bk.rw", phone: "+250 788 678 901", totalOrders: 21, totalSpent: 38900, lastOrder: "2024-11-19" },
]

export const stockByCategory = [
  { category: "Starlink", inStock: 3, sold: 0, poc: 1, maintenance: 0 },
  { category: "Laptops", inStock: 1, sold: 1, poc: 0, maintenance: 1 },
  { category: "Desktops", inStock: 1, sold: 1, poc: 0, maintenance: 0 },
  { category: "Routers", inStock: 1, sold: 0, poc: 1, maintenance: 0 },
  { category: "Switches", inStock: 0, sold: 1, poc: 0, maintenance: 0 },
  { category: "Access Points", inStock: 1, sold: 0, poc: 0, maintenance: 0 },
  { category: "UPS", inStock: 1, sold: 0, poc: 0, maintenance: 0 },
  { category: "Monitors", inStock: 1, sold: 0, poc: 0, maintenance: 0 },
]

export const monthlySales = [
  { month: "Jun", sales: 8, revenue: 12400 },
  { month: "Jul", sales: 12, revenue: 18600 },
  { month: "Aug", sales: 10, revenue: 15200 },
  { month: "Sep", sales: 15, revenue: 22800 },
  { month: "Oct", sales: 18, revenue: 27400 },
  { month: "Nov", sales: 14, revenue: 21200 },
]

export const salesByEmployee = [
  { name: "Eric M.", sales: 32, revenue: 48200 },
  { name: "Sarah K.", sales: 28, revenue: 42100 },
  { name: "David N.", sales: 24, revenue: 36800 },
  { name: "Marie C.", sales: 19, revenue: 28500 },
]

export const appUsers: AppUser[] = [
  { id: "USR001", name: "Eric Mugabo", email: "eric@fram-stock.example", role: "Admin" },
  { id: "USR002", name: "Sarah K.", email: "sarah@fram-stock.example", role: "Sales" },
  { id: "USR003", name: "David N.", email: "david@fram-stock.example", role: "Warehouse" },
  { id: "USR004", name: "Marie C.", email: "marie@fram-stock.example", role: "Sales" },
]
