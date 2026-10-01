import { describe, expect, it } from "vitest"
import { STATUS_PILL_CLASS, statusLabel, statusPillClass } from "@/components/fs/status-pill"

const TOKEN_CLASS = /^(bg-(success-soft|info-soft|warning-soft|danger-soft|muted|brand\/15) text-(success|info|warning|danger|muted-foreground|brand))$/

describe("statusPillClass", () => {
  it("maps every known status and movement to a token pair", () => {
    for (const [value, classes] of Object.entries(STATUS_PILL_CLASS)) {
      expect(classes, value).toMatch(TOKEN_CLASS)
      expect(statusPillClass(value)).toBe(classes)
    }
  })

  it("keeps the status meanings from the token table", () => {
    expect(statusPillClass("Sale")).toBe("bg-success-soft text-success")
    expect(statusPillClass("Sold")).toBe("bg-success-soft text-success")
    expect(statusPillClass("POC")).toBe("bg-info-soft text-info")
    expect(statusPillClass("Rentals")).toBe("bg-brand/15 text-brand")
    expect(statusPillClass("Dispose")).toBe("bg-muted text-muted-foreground")
    expect(statusPillClass("Reversal")).toBe("bg-warning-soft text-warning")
    expect(statusPillClass("Inspection Fail")).toBe("bg-danger-soft text-danger")
    expect(statusPillClass("cancelled")).toBe("bg-danger-soft text-danger")
    expect(statusPillClass("in_progress")).toBe("bg-info-soft text-info")
  })

  it("falls back to muted for an unknown value", () => {
    expect(statusPillClass("not-a-status")).toBe("bg-muted text-muted-foreground")
  })

  it("prints request statuses with spaces", () => {
    expect(statusLabel("in_progress")).toBe("in progress")
    expect(statusLabel("Sale")).toBe("Sale")
  })
})
