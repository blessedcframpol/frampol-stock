import { describe, expect, it } from "vitest"
import {
  formatNowAfterLine,
  reverseAgeBanner,
  reverseBlockedMessage,
  reverseMovementHint,
  reverseReasonPlaceholder,
  REVERSE_MOVEMENT_HINTS,
  REVERSE_PLAN_MOVEMENT_TYPES,
  REVERSE_SERIAL_PREVIEW_LIMIT,
} from "@/lib/supabase/movement-utils"

describe("reverseMovementHint", () => {
  it("maps every plan movement type to a specific hint (no silent fallthrough)", () => {
    for (const type of REVERSE_PLAN_MOVEMENT_TYPES) {
      const hint = reverseMovementHint(type, {
        softDelete: type === "Inbound",
        restoreStatus: type === "Inbound" ? null : "In Stock",
      })
      expect(hint, type).not.toBeNull()
      expect(hint!.text.length).toBeGreaterThan(10)
      if (type === "Sale Return" || type === "POC Return" || type === "Rental Return") {
        expect(hint!.tone).toBe("amber")
      } else {
        expect(hint!.tone).toBe("info")
      }
    }
    expect(Object.keys(REVERSE_MOVEMENT_HINTS).sort()).toEqual([...REVERSE_PLAN_MOVEMENT_TYPES].sort())
  })

  it("resolves Inbound create vs from hold", () => {
    expect(reverseMovementHint("Inbound", { softDelete: true })?.text).toMatch(/removes the kit from stock/)
    expect(reverseMovementHint("Inbound", { softDelete: false, restoreStatus: "Maintenance" })?.text).toBe(
      "This puts the kit back to Maintenance.",
    )
    expect(reverseMovementHint("Inbound", { softDelete: false })?.text).toMatch(/previous status/)
  })

  it("returns null only for unknown types", () => {
    expect(reverseMovementHint("Not A Type")).toBeNull()
    expect(reverseMovementHint(null)).toBeNull()
  })
})

describe("reverseReasonPlaceholder", () => {
  it("uses Sale Return-specific copy and a neutral fallback", () => {
    expect(reverseReasonPlaceholder("Sale Return")).toMatch(/wrong serial/)
    expect(reverseReasonPlaceholder("Inbound")).toMatch(/mistake/)
    expect(reverseReasonPlaceholder("Mystery")).toBe("Why is this movement being undone?")
  })
})

describe("formatNowAfterLine", () => {
  const current = {
    status: "RMA Hold",
    location: "Warehouse A",
    client: null,
    assignedTo: null,
    stockPool: "sale",
  }
  const afterSold = {
    status: "Sold",
    location: "Delivered",
    client: "Acme Co",
    assignedTo: null,
    stockPool: "sale",
  }

  it("omits empty fields and uses · separators", () => {
    expect(formatNowAfterLine({ current, after: afterSold })).toBe(
      "Now: RMA Hold · Warehouse A → After: Sold · Delivered · Acme Co",
    )
  })

  it("formats Inbound-create soft-delete as removed from stock", () => {
    expect(
      formatNowAfterLine({
        current: {
          status: "In Stock",
          location: "Warehouse A",
          client: null,
          assignedTo: null,
          stockPool: "sale",
        },
        after: null,
        softDelete: true,
      }),
    ).toBe("Now: In Stock · Warehouse A → After: removed from stock")
  })

  it("formats POC Return after back to POC", () => {
    expect(
      formatNowAfterLine({
        current: {
          status: "In Stock",
          location: "Warehouse B",
          client: null,
          assignedTo: null,
          stockPool: "demo",
        },
        after: {
          status: "POC",
          location: "Client Site",
          client: "Acme Co",
          assignedTo: "Pat",
          stockPool: "demo",
        },
      }),
    ).toBe("Now: In Stock · Warehouse B → After: POC · Client Site · Acme Co")
  })
})

describe("reverseAgeBanner", () => {
  it("is silent at 7 days or fewer", () => {
    expect(reverseAgeBanner(0)).toBeNull()
    expect(reverseAgeBanner(7)).toBeNull()
    expect(reverseAgeBanner(null)).toBeNull()
  })

  it("is amber between 8 and 29 days", () => {
    const banner = reverseAgeBanner(8)
    expect(banner?.level).toBe("amber")
    expect(banner?.text).toMatch(/8 days old/)
    expect(banner?.text).not.toMatch(/history first/)
  })

  it("is red at 30+ days", () => {
    const banner = reverseAgeBanner(30)
    expect(banner?.level).toBe("red")
    expect(banner?.text).toMatch(/30 days old/)
    expect(banner?.text).toMatch(/history first/)
  })
})

describe("reverseBlockedMessage", () => {
  it("names the later batch", () => {
    expect(
      reverseBlockedMessage({
        batchId: "BATCH-LATER",
        serial: "KIT1",
        type: "Sale",
        date: "2026-11-01",
      }),
    ).toBe("Reverse Sale (BATCH-LATER) first")
  })

  it("is null when not blocked", () => {
    expect(reverseBlockedMessage(null)).toBeNull()
    expect(reverseBlockedMessage(undefined)).toBeNull()
  })
})

describe("REVERSE_SERIAL_PREVIEW_LIMIT", () => {
  it("previews five serials before expanding", () => {
    expect(REVERSE_SERIAL_PREVIEW_LIMIT).toBe(5)
  })
})
