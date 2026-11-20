/** PL1 — product lines admin helpers (picker filter + list filters). */

export type ProductLineAdminRow = {
  id: string
  productName: string
  vendor: string
  requiresSerial: boolean
  requiresCloudKey: boolean
  isActive: boolean
  retiredAt: string | null
  retiredBy: string | null
  mergedIntoId: string | null
  reorderLevel: number | null
  createdAt: string
  inStockCount: number
  totalItems: number
  requestLinesCount: number
}

export type ProductLineAdminFilters = {
  search?: string
  vendor?: string | null
  /** `active` | `retired` | `all` */
  status?: "active" | "retired" | "all"
}

/** Rows shown in new-request / movement pickers (is_active, not a merge alias). */
export function isProductLinePickable(row: {
  isActive?: boolean | null
  mergedIntoId?: string | null
}): boolean {
  if (row.mergedIntoId) return false
  if (row.isActive === false) return false
  return true
}

export function filterProductCatalogueForPicker<T extends {
  is_active?: boolean | null
  isActive?: boolean | null
  merged_into_id?: string | null
  mergedIntoId?: string | null
}>(rows: T[]): T[] {
  return rows.filter((row) =>
    isProductLinePickable({
      isActive: row.isActive ?? row.is_active ?? true,
      mergedIntoId: row.mergedIntoId ?? row.merged_into_id ?? null,
    }),
  )
}

/** UI status: inactive / merged → Retired. Blank retired_at = before PL1. */
export function productLineStatusLabel(row: {
  isActive: boolean
  retiredAt: string | null
  mergedIntoId: string | null
}): { label: string; detail?: string } {
  if (row.mergedIntoId) return { label: "Merged" }
  if (!row.isActive) {
    return {
      label: "Retired",
      detail: row.retiredAt ? undefined : "before PL1",
    }
  }
  return { label: "Active" }
}

export function filterProductLineAdminRows(
  rows: ProductLineAdminRow[],
  filters: ProductLineAdminFilters = {},
): ProductLineAdminRow[] {
  const q = (filters.search ?? "").trim().toLowerCase()
  const vendor = (filters.vendor ?? "").trim().toLowerCase()
  const status = filters.status ?? "all"

  return rows.filter((row) => {
    const retired = row.isActive === false || Boolean(row.mergedIntoId)
    if (status === "active" && retired) return false
    if (status === "retired" && !retired) return false
    if (vendor && row.vendor.trim().toLowerCase() !== vendor) return false
    if (!q) return true
    return (
      row.productName.toLowerCase().includes(q) ||
      row.vendor.toLowerCase().includes(q) ||
      row.id.toLowerCase().includes(q)
    )
  })
}

export function mapAdminProductLinesOverview(raw: unknown): ProductLineAdminRow[] {
  if (!Array.isArray(raw)) return []
  return raw.map((row) => {
    const r = row as Record<string, unknown>
    return {
      id: String(r.id ?? ""),
      productName: String(r.product_name ?? ""),
      vendor: String(r.vendor ?? "General"),
      requiresSerial: r.requires_serial === true,
      requiresCloudKey: r.requires_cloud_key === true,
      isActive: r.is_active !== false,
      retiredAt: typeof r.retired_at === "string" ? r.retired_at : null,
      retiredBy: typeof r.retired_by === "string" ? r.retired_by : null,
      mergedIntoId: typeof r.merged_into_id === "string" ? r.merged_into_id : null,
      reorderLevel: typeof r.reorder_level === "number" ? r.reorder_level : null,
      createdAt: typeof r.created_at === "string" ? r.created_at : "",
      inStockCount: Number(r.in_stock_count ?? 0),
      totalItems: Number(r.total_items ?? 0),
      requestLinesCount: Number(r.request_lines_count ?? 0),
    }
  })
}

export function canHardDeleteProductLine(row: {
  totalItems: number
  requestLinesCount: number
}): boolean {
  return row.totalItems === 0 && row.requestLinesCount === 0
}
