import { describe, expect, it } from "vitest"
import {
  RESOLVE_POOL,
  RESOLVE_RENTAL_END,
  RESOLVE_RETURN_BOUNDS,
  RESOLVE_RETURN_LAST,
  RESOLVE_SALE_BEFORE_END,
  resolveDraftFromItem,
  resolveHoldingRow,
  resolveRowProblems,
  resolveSummaryText,
  type ResolveDraft,
} from "@/lib/bulk-resolve"
import type { InventoryItem } from "@/lib/data"

const TODAY = "2026-10-06"

function item(partial: Partial<InventoryItem> & Pick<InventoryItem, "status" | "returnDate">): InventoryItem {
  return {
    id: partial.id ?? "item",
    serialNumber: partial.serialNumber ?? "KIT-1",
    name: partial.name ?? "Kit",
    vendor: partial.vendor ?? "Starlink",
    dateAdded: "2026-01-01",
    location: partial.location ?? "Client Site",
    client: partial.client ?? "Holder",
    pocOutDate: partial.pocOutDate,
    ...partial,
  }
}

function draft(partial: Partial<ResolveDraft> & Pick<ResolveDraft, "action" | "kind">): ResolveDraft {
  return {
    serialNumber: "KIT-1",
    client: "Holder",
    dueDate: "2026-10-01",
    daysOverdue: 5,
    dispatchDate: "2026-09-20",
    lastMovementDate: "2026-09-25",
    rentalStart: "2026-09-20",
    starlink: true,
    actionDate: TODAY,
    location: "",
    returnPool: "",
    reasonCategory: "",
    reasonText: "",
    invoiceChoice: "",
    invoiceNumber: "",
    invoiceReason: "",
    rentalEnd: TODAY,
    rentalEndTouched: false,
    serverErrors: [],
    ...partial,
  }
}

describe("resolveDraftFromItem", () => {
  it("builds an overdue POC row and skips a kit that is not overdue", () => {
    const poc = item({ status: "POC", returnDate: "2026-10-01", pocOutDate: "2026-09-20", serialNumber: "POC-1" })
    const built = resolveDraftFromItem(
      poc,
      [{ type: "Transfer", serialNumber: "POC-1", date: "2026-09-25T00:00:00.000Z" }],
      TODAY,
    )
    expect(built?.kind).toBe("POC")
    expect(built?.daysOverdue).toBe(5)
    expect(built?.dispatchDate).toBe("2026-09-20")
    expect(built?.lastMovementDate).toBe("2026-09-25")
    expect(built?.action).toBe("leave")
    expect(resolveDraftFromItem(item({ status: "POC", returnDate: TODAY }), [], TODAY)).toBeNull()
    expect(resolveDraftFromItem(item({ status: "In Stock", returnDate: "2026-10-01" }), [], TODAY)).toBeNull()
  })
})

describe("resolveRowProblems", () => {
  it("leaves a Leave row alone and rejects a return date outside the bounds", () => {
    expect(resolveRowProblems(draft({ action: "leave", kind: "POC" }), TODAY)).toEqual([])
    const early = draft({ action: "returned", kind: "POC", actionDate: "2026-09-22", location: "Warehouse A", returnPool: "sale" })
    expect(resolveRowProblems(early, TODAY)).toContain(RESOLVE_RETURN_LAST)
    const beforeDispatch = draft({
      action: "returned",
      kind: "POC",
      actionDate: "2026-09-01",
      location: "Warehouse A",
      returnPool: "sale",
    })
    expect(resolveRowProblems(beforeDispatch, TODAY)).toEqual(expect.arrayContaining([RESOLVE_RETURN_BOUNDS, RESOLVE_RETURN_LAST]))
    const future = draft({ action: "returned", kind: "POC", actionDate: "2026-10-07", location: "Warehouse A", returnPool: "sale" })
    expect(resolveRowProblems(future, TODAY)).toContain(RESOLVE_RETURN_BOUNDS)
  })

  it("requires a POC pool and a rental end that is not after the sale", () => {
    expect(resolveRowProblems(draft({ action: "returned", kind: "POC", location: "Warehouse A" }), TODAY)).toContain(RESOLVE_POOL)
    const sold = draft({
      action: "sold",
      kind: "Rental",
      invoiceChoice: "pending",
      rentalEnd: "2026-10-07",
    })
    expect(resolveRowProblems(sold, TODAY)).toEqual(expect.arrayContaining([RESOLVE_RENTAL_END, RESOLVE_SALE_BEFORE_END]))
    const ready = draft({
      action: "sold",
      kind: "POC",
      invoiceChoice: "number",
      invoiceNumber: "INV-17",
    })
    expect(resolveRowProblems(ready, TODAY)).toEqual([])
  })
})

describe("resolveHoldingRow", () => {
  it("sends the rental end and omits leave details", () => {
    expect(resolveHoldingRow(draft({ action: "leave", kind: "POC" }))).toEqual({
      serial_number: "KIT-1",
      action: "leave",
    })
    expect(
      resolveHoldingRow(
        draft({
          action: "sold",
          kind: "Rental",
          invoiceChoice: "not_invoiced",
          invoiceReason: "Complimentary kit, not invoiced",
          rentalEnd: "2026-10-04",
        }),
      ).rental_end,
    ).toBe("2026-10-04")
  })
})

describe("resolveSummaryText", () => {
  it("counts returned, sold, inspection, and approval", () => {
    expect(resolveSummaryText({ returned: 2, sold: 3, inspection: 1, awaitingApproval: 1 })).toBe(
      "2 returned, 3 sold, 1 to inspection, 1 awaiting invoice approval",
    )
  })
})
