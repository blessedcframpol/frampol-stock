import { describe, expect, it } from "vitest"
import type { InventoryItem } from "@/lib/data"
import {
  activeInStockTotal,
  inStockPoolCounts,
  buildInventoryProducts,
  canEditReorderLevel,
  canLaunchStockTake,
  canMoveProductGroup,
  filterInventoryProducts,
  lowStockChipCount,
  parseReorderDraft,
  productRowActions,
  serialColumnsVisible,
  showSerialCheckboxes,
  sortInventoryProducts,
  vendorChipSelected,
  vendorChips,
} from "@/lib/inventory-products"
import type { LowStockProduct, ProductLineSetting } from "@/lib/settings"

function item(partial: Partial<InventoryItem> & Pick<InventoryItem, "id" | "productId" | "status">): InventoryItem {
  return {
    serialNumber: partial.id,
    name: "Kit",
    dateAdded: "2026-01-01",
    location: "Warehouse A",
    ...partial,
  }
}

const lines: ProductLineSetting[] = [
  { productId: "star", productName: "Mini", vendor: "Starlink", reorderLevel: null, isActive: true },
  { productId: "fort", productName: "Gate", vendor: "Fortinet", reorderLevel: 5, isActive: true },
  { productId: "gen", productName: "Router", vendor: "General", reorderLevel: null, isActive: true },
  { productId: "ubi", productName: "Cloud", vendor: "Ubiquiti", reorderLevel: 1, isActive: true },
  { productId: "off", productName: "Retired", vendor: "General", reorderLevel: null, isActive: false },
  { productId: "never", productName: "Unstocked", vendor: "Starlink", reorderLevel: null, isActive: true },
]

const lowStock: LowStockProduct[] = [
  { productId: "star", productName: "Mini", vendor: "Starlink", inStockCount: 298, effectiveReorderLevel: 2, isLow: false },
  { productId: "fort", productName: "Gate", vendor: "Fortinet", inStockCount: 88, effectiveReorderLevel: 5, isLow: false },
  { productId: "gen", productName: "Router", vendor: "General", inStockCount: 25, effectiveReorderLevel: 2, isLow: true },
  { productId: "ubi", productName: "Cloud", vendor: "Ubiquiti", inStockCount: 18, effectiveReorderLevel: 1, isLow: false },
]

const items: InventoryItem[] = [
  item({ id: "p1", productId: "gen", status: "POC" }),
  item({ id: "r1", productId: "gen", status: "Rented" }),
  item({ id: "r2", productId: "gen", status: "Rented" }),
  item({ id: "sold", productId: "gen", status: "Sold" }),
  item({ id: "gone", productId: "gen", status: "POC", deletedAt: "2026-01-02" }),
]

describe("in stock pool counts", () => {
  it("counts In Stock kits by group and treats a missing pool as sale", () => {
    expect(
      inStockPoolCounts([
        item({ id: "a", productId: "gen", status: "In Stock" }),
        item({ id: "b", productId: "gen", status: "In Stock", stockPool: "rental" }),
        item({ id: "c", productId: "gen", status: "In Stock", stockPool: "demo" }),
        item({ id: "d", productId: "gen", status: "Sold", stockPool: "demo" }),
        item({ id: "e", productId: "gen", status: "In Stock", stockPool: "sale", deletedAt: "2026-01-02" }),
      ])
    ).toEqual({ inStock: 3, sale: 1, rental: 1, demo: 1 })
  })
})

describe("inventory product chips", () => {
  const rows = buildInventoryProducts(lowStock, lines, items, 2)

  it("sums vendor chips to the in-stock total and counts low products", () => {
    const chips = vendorChips(rows)
    expect(chips.map((chip) => [chip.label, chip.count])).toEqual([
      ["All", 429],
      ["Fortinet", 88],
      ["General", 25],
      ["Starlink", 298],
      ["Ubiquiti", 18],
    ])
    expect(activeInStockTotal(rows)).toBe(429)
    expect(chips.reduce((sum, chip) => (chip.id === "all" ? sum : sum + chip.count), 0)).toBe(429)
    expect(lowStockChipCount(rows)).toBe(1)
  })

  it("keeps POC and rental from the loaded ledger and shows never-stocked lines at zero", () => {
    const router = rows.find((row) => row.productId === "gen")
    expect(router).toMatchObject({ pocCount: 1, rentalCount: 2, isLow: true, reorderLevel: null })
    expect(rows.find((row) => row.productId === "never")).toMatchObject({
      inStockCount: 0,
      isLow: false,
      isActive: true,
      effectiveReorderLevel: 2,
    })
    expect(rows.some((row) => row.productId === "off")).toBe(true)
    expect(lowStockChipCount(rows)).toBe(1)
    expect(rows).toHaveLength(lines.length)
  })

  it("ignores a view row that is not a product line", () => {
    const withGhost = buildInventoryProducts(
      [...lowStock, { productId: "ghost", productName: "Ghost", vendor: "General", inStockCount: 4, effectiveReorderLevel: 2, isLow: true }],
      lines,
      items,
      2,
    )
    expect(withGhost.some((row) => row.productId === "ghost")).toBe(false)
    expect(withGhost).toHaveLength(lines.length)
  })
})

describe("inventory product sorting and filters", () => {
  const rows = buildInventoryProducts(lowStock, lines, items, 2)

  it("sorts low stock ahead of vendor", () => {
    const sorted = sortInventoryProducts(rows.filter((row) => row.isActive), "default", "asc")
    expect(sorted.map((row) => row.productId)).toEqual(["gen", "fort", "star", "never", "ubi"])
  })

  it("filters by vendor, low stock, search, and inactive", () => {
    expect(filterInventoryProducts(rows, { query: "gate", vendor: "all", lowOnly: false, showInactive: false }).map((row) => row.productId)).toEqual(["fort"])
    expect(filterInventoryProducts(rows, { query: "", vendor: "Starlink", lowOnly: false, showInactive: false }).map((row) => row.productId)).toEqual(["star", "never"])
    expect(filterInventoryProducts(rows, { query: "", vendor: "all", lowOnly: true, showInactive: false }).some((row) => row.productId === "never")).toBe(false)
    expect(filterInventoryProducts(rows, { query: "", vendor: "all", lowOnly: true, showInactive: false }).map((row) => row.productId)).toEqual(["gen"])
    expect(filterInventoryProducts(rows, { query: "", vendor: "all", lowOnly: false, showInactive: false }).some((row) => row.productId === "off")).toBe(false)
    expect(filterInventoryProducts(rows, { query: "", vendor: "all", lowOnly: false, showInactive: true }).some((row) => row.productId === "off")).toBe(true)
  })
})

describe("reorder edit permission", () => {
  it("allows only admin, matching product_lines admin-only writes", () => {
    expect(canEditReorderLevel("admin")).toBe(true)
    for (const role of ["sales", "accounts", "technicians", "viewer", null] as const) {
      expect(canEditReorderLevel(role)).toBe(false)
    }
  })

  it("keeps stock take and move group on the admin menu only", () => {
    expect(canLaunchStockTake("admin")).toBe(true)
    expect(canMoveProductGroup("admin")).toBe(true)
    expect(productRowActions("admin")).toMatchObject({ move: true, stockTake: true })
    expect(showSerialCheckboxes("admin")).toBe(true)
    expect(showSerialCheckboxes("technicians")).toBe(true)
    for (const role of ["sales", "accounts", "technicians", "viewer", null] as const) {
      expect(canLaunchStockTake(role)).toBe(false)
      expect(canMoveProductGroup(role)).toBe(false)
      expect(productRowActions(role).move).toBe(false)
      expect(productRowActions(role).stockTake).toBe(false)
    }
    for (const role of ["sales", "accounts", "viewer", null] as const) {
      expect(showSerialCheckboxes(role)).toBe(false)
    }
  })

  it("leaves All unselected while the low-stock chip is on", () => {
    expect(vendorChipSelected("all", "all", false)).toBe(true)
    expect(vendorChipSelected("all", "all", true)).toBe(false)
    expect(vendorChipSelected("all", "Starlink", false)).toBe(false)
    expect(vendorChipSelected("Starlink", "Starlink", true)).toBe(true)
  })

  it("treats a blank reorder draft as the default and rejects junk", () => {
    expect(parseReorderDraft("")).toEqual({ ok: true, value: null })
    expect(parseReorderDraft("4")).toEqual({ ok: true, value: 4 })
    expect(parseReorderDraft("-1").ok).toBe(false)
    expect(parseReorderDraft("1.5").ok).toBe(false)
  })
})

describe("serial columns", () => {
  it("hides assigned-to and purchase columns when every row is empty", () => {
    expect(
      serialColumnsVisible([
        { assignedTo: "  ", purchaseDate: undefined, warrantyEndDate: undefined },
        { assignedTo: undefined, purchaseDate: "", warrantyEndDate: undefined },
      ]),
    ).toEqual({ assignedTo: false, purchaseWarranty: false })
    expect(
      serialColumnsVisible([{ assignedTo: "Site", purchaseDate: "2026-01-01", warrantyEndDate: undefined }]),
    ).toEqual({ assignedTo: true, purchaseWarranty: true })
  })
})
