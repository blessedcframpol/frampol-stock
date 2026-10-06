import { describe, expect, it } from "vitest"
import { getLowStockAlerts } from "./low-stock-helper.mjs"

describe("getLowStockAlerts", () => {
  it("maps only rows classified as low by the database view", () => {
    const alerts = getLowStockAlerts([
      {
        productId: "at-threshold",
        productName: "At threshold",
        vendor: "Vendor A",
        inStockCount: 2,
        effectiveReorderLevel: 2,
        isLow: true,
      },
      {
        productId: "above-threshold",
        productName: "Above threshold",
        vendor: "Vendor B",
        inStockCount: 3,
        effectiveReorderLevel: 2,
        isLow: false,
      },
    ])

    expect(alerts).toEqual([
      {
        productId: "at-threshold",
        groupName: "At threshold",
        vendor: "Vendor A",
        inStock: 2,
        threshold: 2,
      },
    ])
  })

  it("keeps the view classification for stocked rows, including above-threshold and sold-out", () => {
    const alerts = getLowStockAlerts([
      {
        productId: "PL-f3ee0d0dc1264eb192146a22d20a6f45",
        productName: "Starlink Standard Kit v4(Rental)",
        vendor: "Starlink",
        inStockCount: 5,
        effectiveReorderLevel: 2,
        isLow: false,
      },
      {
        productId: "sold-out",
        productName: "Sold out",
        vendor: "Vendor C",
        inStockCount: 0,
        effectiveReorderLevel: 2,
        isLow: true,
      },
    ])

    expect(alerts).toEqual([
      {
        productId: "sold-out",
        groupName: "Sold out",
        vendor: "Vendor C",
        inStock: 0,
        threshold: 2,
      },
    ])
  })
})
