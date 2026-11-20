import { describe, expect, it } from "vitest"
import {
  blockMessageForCode,
  canDeleteVendorRow,
  deleteVendorDisabledReason,
  filterVendorAdminRows,
  mapAdminVendorsOverview,
  mapVendorMovePreview,
  moveProductsConfirmMessage,
  VENDOR_MOVE_COPY,
  warningMessageForCode,
  type VendorAdminRow,
} from "@/lib/vendors-admin"

function row(partial: Partial<VendorAdminRow> & { name: string }): VendorAdminRow {
  return {
    isProtected: false,
    protectedReason: null,
    createdAt: "2026-01-01T00:00:00Z",
    productCount: 0,
    inStockCount: 0,
    ...partial,
  }
}

describe("vendors-admin helpers", () => {
  it("maps overview rows", () => {
    const mapped = mapAdminVendorsOverview([
      {
        name: "Ubiquiti",
        is_protected: false,
        protected_reason: null,
        created_at: "2026-01-01T00:00:00Z",
        product_count: 8,
        in_stock_count: 9,
      },
    ])
    expect(mapped[0]).toMatchObject({ name: "Ubiquiti", productCount: 8, inStockCount: 9 })
  })

  it("blocks delete when protected or non-empty", () => {
    expect(canDeleteVendorRow(row({ name: "Empty" }))).toBe(true)
    expect(canDeleteVendorRow(row({ name: "Busy", productCount: 2 }))).toBe(false)
    expect(
      canDeleteVendorRow(
        row({ name: "Starlink", isProtected: true, protectedReason: "Rentals only for Starlink" }),
      ),
    ).toBe(false)
    expect(deleteVendorDisabledReason(row({ name: "Busy", productCount: 3 }))).toBe(
      "Move its products first",
    )
  })

  it("builds a plain move confirmation", () => {
    expect(
      moveProductsConfirmMessage({
        productCount: 3,
        kitCount: 12,
        fromVendors: ["General"],
        toVendor: "Ubiquiti",
      }),
    ).toBe("Move 3 products (12 kits) from General to Ubiquiti?")
  })

  it("filters vendors by search", () => {
    const rows = [
      row({ name: "Starlink", isProtected: true, protectedReason: "Rentals only" }),
      row({ name: "Ubiquiti" }),
    ]
    expect(filterVendorAdminRows(rows, "ubi").map((r) => r.name)).toEqual(["Ubiquiti"])
    expect(filterVendorAdminRows(rows, "rental").map((r) => r.name)).toEqual(["Starlink"])
  })

  it("maps warning and block copy from one dictionary", () => {
    expect(warningMessageForCode("move_into_starlink")).toBe(VENDOR_MOVE_COPY.move_into_starlink)
    expect(warningMessageForCode("move_out_of_fortinet")).toBe(
      VENDOR_MOVE_COPY.move_out_of_fortinet,
    )
    expect(blockMessageForCode("starlink_out_active", 4)).toBe(
      "4 kits are out on rental — return them first",
    )
    expect(blockMessageForCode("fortinet_open_requests", 2)).toBe(
      "2 open requests use this product",
    )
    expect(VENDOR_MOVE_COPY.move_into_starlink).toMatch(/rentable/i)
    expect(VENDOR_MOVE_COPY.move_out_of_fortinet).toMatch(/Accounts/i)
  })

  it("maps preview payload including blocks and warnings", () => {
    const preview = mapVendorMovePreview({
      target: "Ubiquiti",
      from_vendors: ["Starlink"],
      product_count: 1,
      kit_count: 4,
      source_protected: [
        { name: "Starlink", protected_reason: "Rentals only for Starlink kits" },
      ],
      target_protected: null,
      protected_reasons_text: "Starlink — Rentals only for Starlink kits",
      requires_reason: true,
      blocked: true,
      blocks: [{ code: "starlink_out_active", count: 4 }],
      warnings: [{ code: "move_out_of_starlink" }],
      starlink_out_kit_count: 4,
      fortinet_open_request_count: 0,
    })
    expect(preview.requiresReason).toBe(true)
    expect(preview.blocked).toBe(true)
    expect(preview.blocks[0]?.message).toBe("4 kits are out on rental — return them first")
    expect(preview.warnings[0]?.message).toBe(VENDOR_MOVE_COPY.move_out_of_starlink)
    expect(preview.sourceProtected[0]?.name).toBe("Starlink")
  })
})
