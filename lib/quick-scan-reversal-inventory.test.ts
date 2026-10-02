import { describe, expect, it } from "vitest"
import { isQuickScanStockReversibleMovement } from "./quick-scan-reversal-inventory"

describe("isQuickScanStockReversibleMovement", () => {
  it("allows every movement except a Reversal", () => {
    expect(isQuickScanStockReversibleMovement("Sale")).toBe(true)
    expect(isQuickScanStockReversibleMovement("POC Return")).toBe(true)
    expect(isQuickScanStockReversibleMovement("Inspection Fail")).toBe(true)
    expect(isQuickScanStockReversibleMovement("Reversal")).toBe(false)
    expect(isQuickScanStockReversibleMovement("")).toBe(false)
  })
})
