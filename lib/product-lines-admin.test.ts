import { describe, expect, it } from "vitest"
import {
  canHardDeleteProductLine,
  filterProductCatalogueForPicker,
  filterProductLineAdminRows,
  isProductLinePickable,
  mapAdminProductLinesOverview,
  productLineStatusLabel,
  type ProductLineAdminRow,
} from "@/lib/product-lines-admin"

function row(partial: Partial<ProductLineAdminRow> & { id: string; productName: string }): ProductLineAdminRow {
  return {
    vendor: "Starlink",
    requiresSerial: true,
    requiresCloudKey: false,
    isActive: true,
    retiredAt: null,
    retiredBy: null,
    mergedIntoId: null,
    reorderLevel: null,
    createdAt: "2026-01-01T00:00:00Z",
    inStockCount: 0,
    totalItems: 0,
    requestLinesCount: 0,
    ...partial,
  }
}

describe("isProductLinePickable / filterProductCatalogueForPicker", () => {
  it("hides inactive and merge aliases; retired_at alone does not hide", () => {
    expect(isProductLinePickable({ isActive: true, mergedIntoId: null })).toBe(true)
    expect(isProductLinePickable({ isActive: false })).toBe(false)
    expect(isProductLinePickable({ isActive: true, mergedIntoId: "PL-other" })).toBe(false)

    const filtered = filterProductCatalogueForPicker([
      { product_id: "a", is_active: true },
      { product_id: "b", is_active: true, retired_at: "2026-01-01" },
      { product_id: "c", is_active: false },
      { product_id: "d", is_active: true, merged_into_id: "PL-x" },
    ])
    expect(filtered.map((r) => r.product_id)).toEqual(["a", "b"])
  })
})

describe("productLineStatusLabel", () => {
  it("shows Retired for inactive rows; before PL1 when retired_at blank", () => {
    expect(productLineStatusLabel({ isActive: true, retiredAt: null, mergedIntoId: null })).toEqual({
      label: "Active",
    })
    expect(productLineStatusLabel({ isActive: false, retiredAt: null, mergedIntoId: null })).toEqual({
      label: "Retired",
      detail: "before PL1",
    })
    expect(
      productLineStatusLabel({ isActive: false, retiredAt: "2026-11-20T00:00:00Z", mergedIntoId: null }),
    ).toEqual({ label: "Retired" })
    expect(
      productLineStatusLabel({ isActive: false, retiredAt: "2026-11-20T00:00:00Z", mergedIntoId: "PL-x" }),
    ).toEqual({ label: "Merged" })
  })
})

describe("filterProductLineAdminRows", () => {
  const rows = [
    row({ id: "1", productName: "Mini Kit", vendor: "Starlink", inStockCount: 2 }),
    row({
      id: "2",
      productName: "FortiGate",
      vendor: "Fortinet",
      retiredAt: "2026-02-01T00:00:00Z",
      isActive: false,
    }),
    row({ id: "3", productName: "Typo FortiGte", vendor: "Fortinet", totalItems: 0, requestLinesCount: 0 }),
  ]

  it("filters by search, vendor, and retired status", () => {
    expect(filterProductLineAdminRows(rows, { search: "forti" }).map((r) => r.id)).toEqual(["2", "3"])
    expect(filterProductLineAdminRows(rows, { vendor: "Starlink" }).map((r) => r.id)).toEqual(["1"])
    expect(filterProductLineAdminRows(rows, { status: "retired" }).map((r) => r.id)).toEqual(["2"])
    expect(filterProductLineAdminRows(rows, { status: "active" }).map((r) => r.id)).toEqual(["1", "3"])
  })
})

describe("canHardDeleteProductLine", () => {
  it("only allows zero inventory and zero request lines", () => {
    expect(canHardDeleteProductLine({ totalItems: 0, requestLinesCount: 0 })).toBe(true)
    expect(canHardDeleteProductLine({ totalItems: 1, requestLinesCount: 0 })).toBe(false)
    expect(canHardDeleteProductLine({ totalItems: 0, requestLinesCount: 2 })).toBe(false)
  })
})

describe("mapAdminProductLinesOverview", () => {
  it("maps snake_case overview rows", () => {
    const mapped = mapAdminProductLinesOverview([
      {
        id: "PL-1",
        product_name: "Kit",
        vendor: "Starlink",
        requires_serial: true,
        requires_cloud_key: false,
        is_active: true,
        retired_at: null,
        retired_by: null,
        merged_into_id: null,
        reorder_level: 3,
        created_at: "2026-01-01T00:00:00Z",
        in_stock_count: 4,
        total_items: 5,
        request_lines_count: 1,
      },
    ])
    expect(mapped[0]).toMatchObject({
      id: "PL-1",
      productName: "Kit",
      inStockCount: 4,
      totalItems: 5,
      requestLinesCount: 1,
      requiresSerial: true,
    })
  })
})
