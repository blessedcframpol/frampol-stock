import { describe, expect, it } from "vitest"
import { isSubsequentMovement } from "./quick-scan-reversal-inventory"

const BUSINESS_DATE = "2026-09-16T00:00:00.000Z"

describe("isSubsequentMovement", () => {
  it("uses created_at to distinguish movements on the same business date", () => {
    expect(
      isSubsequentMovement(
        { date: BUSINESS_DATE, created_at: "2026-09-16T12:00:00.000Z" },
        { date: BUSINESS_DATE, created_at: "2026-09-16T10:00:00.000Z" }
      )
    ).toBe(true)
    expect(
      isSubsequentMovement(
        { date: BUSINESS_DATE, created_at: "2026-09-16T08:00:00.000Z" },
        { date: BUSINESS_DATE, created_at: "2026-09-16T10:00:00.000Z" }
      )
    ).toBe(false)
  })

  it("blocks an ambiguous same-day legacy movement whose created_at is NULL", () => {
    expect(
      isSubsequentMovement(
        { date: BUSINESS_DATE, created_at: null },
        { date: BUSINESS_DATE, created_at: "2026-09-16T10:00:00.000Z" }
      )
    ).toBe(true)
  })

  it("falls back to date::timestamptz for a NULL recorded time on another day", () => {
    expect(
      isSubsequentMovement(
        { date: "2026-09-17T00:00:00.000Z", created_at: null },
        { date: BUSINESS_DATE, created_at: "2026-09-16T10:00:00.000Z" }
      )
    ).toBe(true)
  })
})
