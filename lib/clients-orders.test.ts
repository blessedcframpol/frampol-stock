import { describe, expect, it } from "vitest"
import { compareDispatchCount, dispatchCell, dispatchCountLabel, type ClientDispatchCount } from "@/lib/clients-orders"

const matched: ClientDispatchCount = { orders: 1, units: 9, reliable: true }
const unmatched: ClientDispatchCount = { orders: null, units: null, reliable: false }

describe("dispatchCountLabel", () => {
  it("prints a real zero when the client has no sale", () => {
    expect(dispatchCountLabel(undefined, "orders")).toBe("0")
    expect(dispatchCountLabel(undefined, "units")).toBe("0")
  })

  it("keeps a 9-serial sale as 1 order and 9 units", () => {
    expect(dispatchCountLabel(matched, "orders")).toBe("1")
    expect(dispatchCountLabel(matched, "units")).toBe("9")
  })

  it("does not invent a zero when the count query failed", () => {
    expect(dispatchCell(undefined, "orders", true, true)).toBe("—")
    expect(dispatchCell(undefined, "units", false, false)).toBe("…")
  })

  it("refuses a number when the match is not reliable", () => {
    expect(dispatchCountLabel(unmatched, "orders")).toBe("Unmatched")
    expect(dispatchCountLabel(unmatched, "units")).toBe("Unmatched")
  })
})

describe("compareDispatchCount", () => {
  it("sorts larger counts first and leaves unmatched last", () => {
    expect(compareDispatchCount(matched, undefined, "units")).toBeLessThan(0)
    expect(compareDispatchCount(unmatched, matched, "orders")).toBeGreaterThan(0)
    expect(compareDispatchCount(unmatched, undefined, "orders")).toBeGreaterThan(0)
  })
})
