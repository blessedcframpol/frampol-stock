import { describe, expect, it } from "vitest"
import {
  businessDateToIso,
  compareBusinessDatesDesc,
  formatBusinessDate,
  formatRecordedAt,
  todayBusinessDate,
} from "./business-date.mjs"

describe("formatBusinessDate", () => {
  it("renders 16/09/2026 from a midnight ISO value without a clock time", () => {
    expect(formatBusinessDate("2026-09-16T00:00:00.000Z")).toBe("16/09/2026")
    expect(formatBusinessDate("2026-09-16")).toBe("16/09/2026")
    expect(formatBusinessDate("2026-09-16T00:00:00.000Z")).not.toContain("02:00")
  })
})

describe("formatRecordedAt", () => {
  it("is blank when the recorded instant is unknown", () => {
    expect(formatRecordedAt(null, "2026-09-16T00:00:00.000Z", "Africa/Harare")).toBe("")
    expect(formatRecordedAt(undefined, "2026-09-16", "UTC")).toBe("")
  })

  it("renders the instant in Africa/Harare, including the date when it differs", () => {
    expect(formatRecordedAt("2026-09-16T10:00:00.000Z", "2026-09-16", "Africa/Harare")).toBe("12:00")
    expect(formatRecordedAt("2026-09-16T22:30:00.000Z", "2026-09-16", "Africa/Harare")).toBe(
      "17/09/2026 00:30"
    )
    expect(formatRecordedAt("2026-09-16T22:30:00.000Z", "2026-09-17T00:00:00.000Z", "Africa/Harare")).toBe(
      "00:30"
    )
  })
})

describe("business date helpers", () => {
  it("stores a picked day at midnight and orders by that calendar day", () => {
    expect(businessDateToIso("2026-09-16")).toBe("2026-09-16T00:00:00.000Z")
    expect(compareBusinessDatesDesc("2026-09-17T00:00:00.000Z", "2026-09-16T22:30:00.000Z")).toBe(-1)
    const harareLate = new Date("2026-09-16T22:30:00.000Z")
    expect(todayBusinessDate("Africa/Harare", harareLate)).toBe("2026-09-17")
    expect(todayBusinessDate("UTC", harareLate)).toBe("2026-09-16")
  })
})
