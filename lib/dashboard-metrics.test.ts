import { describe, expect, it } from "vitest"
import {
  allUnitsByVendor,
  inStockByVendor,
  lastSixBusinessMonths,
  monthlySaleUnits,
} from "@/lib/dashboard-metrics"

describe("inStockByVendor", () => {
  it("counts in-stock units only and sorts vendors by that count", () => {
    const rows = inStockByVendor([
      { vendor: "Starlink", status: "Sold" },
      { vendor: "Starlink", status: "Disposed" },
      { vendor: "Starlink", status: "In Stock" },
      { vendor: "Starlink", status: "In Stock" },
      { vendor: " Fortinet ", status: "In Stock" },
      { vendor: "", status: "In Stock" },
      { vendor: null, status: "POC" },
    ])
    expect(rows).toEqual([
      { vendor: "Starlink", units: 2 },
      { vendor: "Fortinet", units: 1 },
      { vendor: "General", units: 1 },
    ])
  })
})

describe("allUnitsByVendor", () => {
  it("counts every status, so it is not the in-stock ranking", () => {
    const items = [
      { vendor: "Starlink", status: "Sold" },
      { vendor: "Starlink", status: "In Stock" },
      { vendor: "Ubiquiti", status: "In Stock" },
    ]
    expect(allUnitsByVendor(items)).toEqual([
      { vendor: "Starlink", units: 2 },
      { vendor: "Ubiquiti", units: 1 },
    ])
    expect(inStockByVendor(items)).toEqual([
      { vendor: "Starlink", units: 1 },
      { vendor: "Ubiquiti", units: 1 },
    ])
  })
})

describe("monthlySaleUnits", () => {
  it("counts sale units on the business date for the last six months", () => {
    const rows = monthlySaleUnits(
      [
        { type: "Sale", date: "2026-05-02T00:00:00.000Z" },
        { type: "Sale", date: "2026-07-24T00:00:00.000Z" },
        { type: "Sale", date: "2026-07-01T00:00:00.000Z" },
        { type: "POC Out", date: "2026-07-01T00:00:00.000Z" },
        { type: "Sale", date: "2026-04-30T00:00:00.000Z" },
        { type: "Sale", date: "2026-10-01T00:00:00.000Z" },
      ],
      "2026-10-01"
    )
    expect(lastSixBusinessMonths("2026-10-01")).toEqual([
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
    ])
    expect(rows.map((row) => [row.month, row.units])).toEqual([
      ["May", 1],
      ["Jun", 0],
      ["Jul", 2],
      ["Aug", 0],
      ["Sep", 0],
      ["Oct", 1],
    ])
  })
})
