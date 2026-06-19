import type { InventoryItem, ItemStatus, StockTakeScope, StockTakeSnapshot, StockTakeSnapshotItem } from "./data"

export interface StockTakeResult {
  matched: InventoryItem[]
  notInSystem: string[]
  notScanned: InventoryItem[]
  outOfScope: InventoryItem[]
  expectedCount: number
}

export const DEFAULT_STOCK_TAKE_STATUSES: ItemStatus[] = ["In Stock"]

export const DEFAULT_STOCK_TAKE_SCOPE: StockTakeScope = {
  preset: "full",
  label: "Full warehouse (In Stock)",
  statuses: DEFAULT_STOCK_TAKE_STATUSES,
}

function normalizeVendor(v?: string | null): string {
  return v?.trim() ? v.trim() : "General"
}

/** Human-readable label for scope filters (history list, page summary). */
export function buildStockTakeScopeLabel(scope: StockTakeScope): string {
  if (scope.label?.trim()) return scope.label.trim()
  const parts: string[] = []
  if (scope.vendors?.length === 1) parts.push(scope.vendors[0]!)
  else if (scope.vendors?.length) parts.push(`${scope.vendors.length} vendors`)
  if (scope.productNames?.length === 1) parts.push(scope.productNames[0]!)
  else if (scope.productNames?.length) parts.push(`${scope.productNames.length} products`)
  if (scope.locations?.length === 1) parts.push(scope.locations[0]!)
  else if (scope.locations?.length) parts.push(`${scope.locations.length} locations`)
  if (scope.serialAllowList?.length) {
    parts.push(`${scope.serialAllowList.length} selected serial${scope.serialAllowList.length !== 1 ? "s" : ""}`)
  }
  if (parts.length === 0) return "Full warehouse (In Stock)"
  return parts.join(" · ")
}

/** Inventory rows expected to be counted for this stock take. */
export function filterInventoryForStockTake(inventory: InventoryItem[], scope: StockTakeScope): InventoryItem[] {
  const statuses = scope.statuses?.length ? scope.statuses : DEFAULT_STOCK_TAKE_STATUSES
  let items = inventory.filter((i) => !i.deletedAt && statuses.includes(i.status))

  if (scope.vendors?.length) {
    const vendorSet = new Set(scope.vendors.map(normalizeVendor))
    items = items.filter((i) => vendorSet.has(normalizeVendor(i.vendor)))
  }
  if (scope.productNames?.length) {
    const productSet = new Set(scope.productNames)
    items = items.filter((i) => productSet.has(i.name))
  }
  if (scope.locations?.length) {
    const locSet = new Set(scope.locations)
    items = items.filter((i) => locSet.has(i.location))
  }
  if (scope.serialAllowList?.length) {
    const allow = new Set(scope.serialAllowList.map((s) => s.trim()).filter(Boolean))
    items = items.filter((i) => allow.has(i.serialNumber))
  }
  return items
}

function toSnapshotItem(item: InventoryItem): StockTakeSnapshotItem {
  return {
    serialNumber: item.serialNumber,
    name: item.name,
    status: item.status,
    location: item.location,
    vendor: normalizeVendor(item.vendor),
  }
}

/** Build a snapshot for persisting a completed stock take (read-only history). */
export function buildStockTakeSnapshot(
  scannedSerials: string[],
  result: StockTakeResult,
  scope: StockTakeScope
): StockTakeSnapshot {
  return {
    scannedSerials,
    scope: { ...scope, label: buildStockTakeScopeLabel(scope) },
    expectedCount: result.expectedCount,
    matched: result.matched.map(toSnapshotItem),
    notInSystem: result.notInSystem,
    notScanned: result.notScanned.map(toSnapshotItem),
    outOfScope: result.outOfScope.map(toSnapshotItem),
  }
}

/**
 * Compare scanned serials against inventory with an optional scope.
 * - matched: scanned, in system, within scope
 * - notInSystem: scanned serials that don't exist in inventory
 * - notScanned: in-scope inventory items not scanned
 * - outOfScope: scanned, in system, but outside scope
 */
export function compareStockTake(
  scannedSerials: string[],
  inventory: InventoryItem[],
  scope: StockTakeScope = DEFAULT_STOCK_TAKE_SCOPE
): StockTakeResult {
  const scannedSet = new Set(scannedSerials.map((s) => s.trim()).filter(Boolean))
  const liveInventory = inventory.filter((i) => !i.deletedAt)
  const systemBySerial = new Map(liveInventory.map((i) => [i.serialNumber, i]))
  const inScope = filterInventoryForStockTake(liveInventory, scope)
  const inScopeSerials = new Set(inScope.map((i) => i.serialNumber))

  const matched: InventoryItem[] = []
  const notInSystem: string[] = []
  const outOfScope: InventoryItem[] = []

  for (const serial of scannedSet) {
    const item = systemBySerial.get(serial)
    if (!item) {
      notInSystem.push(serial)
    } else if (!inScopeSerials.has(serial)) {
      outOfScope.push(item)
    } else {
      matched.push(item)
    }
  }

  const notScanned = inScope.filter((item) => !scannedSet.has(item.serialNumber))

  return {
    matched,
    notInSystem,
    notScanned,
    outOfScope,
    expectedCount: inScope.length,
  }
}

/** Build a link to stock take with scope pre-filled from inventory navigation. */
export function buildStockTakeUrl(params: {
  vendor?: string
  product?: string
  serials?: string[]
}): string {
  const q = new URLSearchParams()
  if (params.vendor?.trim()) q.set("vendor", params.vendor.trim())
  if (params.product?.trim()) q.set("product", params.product.trim())
  if (params.serials?.length) {
    q.set("serials", params.serials.map((s) => s.trim()).filter(Boolean).join(","))
  }
  const qs = q.toString()
  return qs ? `/inventory/stock-take?${qs}` : "/inventory/stock-take"
}
