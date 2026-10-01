import type { InventoryItem } from "@/lib/data"
import type { AppRole } from "@/lib/permissions"
import type { LowStockProduct, ProductLineSetting } from "@/lib/settings"

/** One product line on the inventory products table. */
export type InventoryProductRow = {
  productId: string
  productName: string
  vendor: string
  inStockCount: number
  pocCount: number
  rentalCount: number
  /** Null means the product uses the organisation default. */
  reorderLevel: number | null
  effectiveReorderLevel: number
  isLow: boolean
  isActive: boolean
}

export type ProductSortKey = "default" | "product" | "vendor" | "inStock" | "out" | "reorder" | "status"

export type VendorChip = {
  id: string
  label: string
  count: number
}

/**
 * Reorder level and is_active match product_lines RLS: admin FOR ALL,
 * every other role SELECT only. The UI hides the control; the database rejects the write.
 */
export function canEditReorderLevel(role: AppRole | null | undefined): boolean {
  return role === "admin"
}

/** CSV download is a read. Viewers do not get it. */
export function canExportInventory(role: AppRole | null | undefined): boolean {
  return role != null && role !== "viewer"
}

/** Stock take writes are admin-only. stock_takes RLS is admin FOR ALL; other roles may only select. */
export function canLaunchStockTake(role: AppRole | null | undefined): boolean {
  return role === "admin"
}

/** Move group was admin-only. */
export function canMoveProductGroup(role: AppRole | null | undefined): boolean {
  return role === "admin"
}

export function productRowActions(role: AppRole | null | undefined): {
  move: boolean
  stockTake: boolean
  exportProduct: boolean
  toggleActive: boolean
} {
  return {
    move: canMoveProductGroup(role),
    stockTake: canLaunchStockTake(role),
    exportProduct: canExportInventory(role),
    toggleActive: canEditReorderLevel(role),
  }
}

export function hasProductRowMenu(role: AppRole | null | undefined): boolean {
  const actions = productRowActions(role)
  return actions.move || actions.stockTake || actions.exportProduct || actions.toggleActive
}

/**
 * Serial checkboxes stay only when a bulk action exists for the role.
 * Record movement is admin and technicians. Move group and stock take are admin-only.
 */
export function showSerialCheckboxes(role: AppRole | null | undefined): boolean {
  if (role == null || role === "viewer") return false
  return role === "admin" || role === "technicians"
}

/** "All" is the unfiltered chip. It is not selected while Low stock is narrowing the table. */
export function vendorChipSelected(chipId: string, vendor: string, lowOnly: boolean): boolean {
  if (chipId === "all") return vendor === "all" && !lowOnly
  return vendor === chipId
}

export function dispatchCounts(
  productId: string,
  items: readonly InventoryItem[],
): { pocCount: number; rentalCount: number } {
  let pocCount = 0
  let rentalCount = 0
  for (const item of items) {
    if (item.productId !== productId || item.deletedAt) continue
    if (item.status === "POC") pocCount += 1
    else if (item.status === "Rented") rentalCount += 1
  }
  return { pocCount, rentalCount }
}

export function formatPocRental(pocCount: number, rentalCount: number): string {
  const parts: string[] = []
  if (pocCount > 0) parts.push(`${pocCount} POC`)
  if (rentalCount > 0) parts.push(`${rentalCount} rental`)
  return parts.join(" · ")
}

/**
 * The row set is product_lines. low_stock_products only supplies in-stock counts
 * and the Low flag. A line the view omits (no live inventory, or inactive) stays
 * in the table: In stock 0 when it is active, no Low flag. The view cannot add
 * or remove a row. POC and rental counts come from the loaded ledger.
 */
function inStockFromItems(productId: string, items: readonly InventoryItem[]): number {
  let count = 0
  for (const item of items) {
    if (item.productId === productId && !item.deletedAt && item.status === "In Stock") count += 1
  }
  return count
}

function rowFromLine(
  line: ProductLineSetting,
  product: LowStockProduct | undefined,
  items: readonly InventoryItem[],
  defaultReorderLevel: number,
): InventoryProductRow {
  const out = dispatchCounts(line.productId, items)
  if (product) {
    return {
      productId: line.productId,
      productName: line.productName,
      vendor: line.vendor,
      inStockCount: product.inStockCount,
      pocCount: out.pocCount,
      rentalCount: out.rentalCount,
      reorderLevel: line.reorderLevel,
      effectiveReorderLevel: product.effectiveReorderLevel,
      isLow: product.isLow,
      isActive: line.isActive,
    }
  }
  return {
    productId: line.productId,
    productName: line.productName,
    vendor: line.vendor,
    inStockCount: line.isActive ? 0 : inStockFromItems(line.productId, items),
    pocCount: out.pocCount,
    rentalCount: out.rentalCount,
    reorderLevel: line.reorderLevel,
    effectiveReorderLevel: line.reorderLevel ?? defaultReorderLevel,
    isLow: false,
    isActive: line.isActive,
  }
}

export function buildInventoryProducts(
  lowStock: readonly LowStockProduct[],
  lines: readonly ProductLineSetting[],
  items: readonly InventoryItem[],
  defaultReorderLevel: number,
): InventoryProductRow[] {
  const viewById = new Map(lowStock.map((product) => [product.productId, product]))
  return lines.map((line) => rowFromLine(line, viewById.get(line.productId), items, defaultReorderLevel))
}

/** In-stock sums for active products. These are the vendor chip counts. */
export function vendorChips(rows: readonly InventoryProductRow[]): VendorChip[] {
  const totals = new Map<string, number>()
  let all = 0
  for (const row of rows) {
    if (!row.isActive) continue
    all += row.inStockCount
    totals.set(row.vendor, (totals.get(row.vendor) ?? 0) + row.inStockCount)
  }
  const vendors = [...totals.keys()].sort((a, b) => a.localeCompare(b))
  return [
    { id: "all", label: "All", count: all },
    ...vendors.map((vendor) => ({ id: vendor, label: vendor, count: totals.get(vendor) ?? 0 })),
  ]
}

/** Product count, not item count. Matches low_stock_products.is_low. */
export function lowStockChipCount(rows: readonly InventoryProductRow[]): number {
  return rows.filter((row) => row.isActive && row.isLow).length
}

export function activeInStockTotal(rows: readonly InventoryProductRow[]): number {
  return rows.reduce((sum, row) => (row.isActive ? sum + row.inStockCount : sum), 0)
}

export function filterInventoryProducts(
  rows: readonly InventoryProductRow[],
  filters: { query: string; vendor: string; lowOnly: boolean; showInactive: boolean },
): InventoryProductRow[] {
  const query = filters.query.trim().toLowerCase()
  return rows.filter((row) => {
    if (!filters.showInactive && !row.isActive) return false
    if (filters.lowOnly && !row.isLow) return false
    if (filters.vendor !== "all" && row.vendor !== filters.vendor) return false
    if (!query) return true
    return (
      row.productName.toLowerCase().includes(query) || row.vendor.toLowerCase().includes(query)
    )
  })
}

function statusRank(row: InventoryProductRow): number {
  if (row.isLow) return 0
  if (!row.isActive) return 1
  return 2
}

export function sortInventoryProducts(
  rows: readonly InventoryProductRow[],
  key: ProductSortKey,
  direction: "asc" | "desc",
): InventoryProductRow[] {
  const factor = direction === "asc" ? 1 : -1
  const copy = [...rows]
  copy.sort((a, b) => {
    let compared = 0
    if (key === "default") {
      compared = Number(b.isLow) - Number(a.isLow) || a.vendor.localeCompare(b.vendor) || a.productName.localeCompare(b.productName)
      return compared
    }
    if (key === "product") compared = a.productName.localeCompare(b.productName)
    else if (key === "vendor") compared = a.vendor.localeCompare(b.vendor)
    else if (key === "inStock") compared = a.inStockCount - b.inStockCount
    else if (key === "out") compared = a.pocCount + a.rentalCount - (b.pocCount + b.rentalCount)
    else if (key === "reorder") compared = a.effectiveReorderLevel - b.effectiveReorderLevel
    else compared = statusRank(a) - statusRank(b)
    if (compared === 0) compared = a.productName.localeCompare(b.productName)
    return compared * factor
  })
  return copy
}

export function serialColumnsVisible(items: readonly Pick<InventoryItem, "assignedTo" | "purchaseDate" | "warrantyEndDate">[]): {
  assignedTo: boolean
  purchaseWarranty: boolean
} {
  return {
    assignedTo: items.some((item) => Boolean(item.assignedTo?.trim())),
    purchaseWarranty: items.some((item) => Boolean(item.purchaseDate) || Boolean(item.warrantyEndDate)),
  }
}

export function parseReorderDraft(draft: string): { ok: true; value: number | null } | { ok: false } {
  const trimmed = draft.trim()
  if (trimmed === "") return { ok: true, value: null }
  if (!/^\d+$/.test(trimmed)) return { ok: false }
  return { ok: true, value: Number(trimmed) }
}
