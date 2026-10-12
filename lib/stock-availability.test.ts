import { describe, expect, it } from "vitest"
import { availabilityByProductId, overRequestWarning } from "@/lib/stock-availability"

describe("overRequestWarning", () => {
  it("warns when quantity exceeds availability", () => {
    expect(overRequestWarning(5, 3)).toBe("Only 3 in stock — the rest may be issued later.")
    expect(overRequestWarning(1, 0)).toBe("Only 0 in stock — the rest may be issued later.")
  })

  it("stays quiet when enough is in stock or availability is unknown", () => {
    expect(overRequestWarning(3, 3)).toBeNull()
    expect(overRequestWarning(2, 3)).toBeNull()
    expect(overRequestWarning(2, null)).toBeNull()
    expect(overRequestWarning(2, undefined)).toBeNull()
  })
})

describe("availabilityByProductId", () => {
  it("maps rows by product id", () => {
    expect(
      availabilityByProductId([
        { product_id: "a", product_name: "A", vendor: null, available_count: 4, reorder_level: 2, is_low: false },
        { product_id: "b", product_name: "B", vendor: "V", available_count: 0, reorder_level: 2, is_low: true },
      ])
    ).toEqual({ a: 4, b: 0 })
  })
})
