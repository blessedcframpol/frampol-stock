import { describe, expect, it } from "vitest"
import {
  DISPLAY_STATUS_LABELS,
  DISPLAY_STATUS_PILL_CLASS,
  REQUEST_DISPLAY_STATUSES,
  displayStatusLabel,
  displayStatusOrReviewState,
  displayStatusPillClass,
  displayStatusTone,
  isRequestDisplayStatus,
  isStockRequestReviewState,
  requestInvoiceColumnLabel,
  requestItemsSummary,
  type RequestDisplayStatus,
  type StockRequestReviewState,
} from "@/lib/stock-request-statuses"

const REVIEW_STATES: StockRequestReviewState[] = [
  "submitted",
  "awaiting_approval",
  "rejected",
  "cancelled",
  "closed",
]

const DISPLAY: RequestDisplayStatus[] = [
  "cancelled",
  "closed",
  "rejected",
  "awaiting_approval",
  "being_reviewed",
  "partially_issued",
  "awaiting_invoice",
  "completed",
]

describe("stock request review states (RQ1)", () => {
  it("recognises every review_state", () => {
    for (const state of REVIEW_STATES) {
      expect(isStockRequestReviewState(state)).toBe(true)
    }
    expect(isStockRequestReviewState("draft")).toBe(false)
    expect(isStockRequestReviewState("serviced")).toBe(false)
  })

  it("lists the display statuses the server function returns", () => {
    expect(DISPLAY).toHaveLength(8)
    expect([...REQUEST_DISPLAY_STATUSES].sort()).toEqual([...DISPLAY].sort())
  })
})

describe("display status helpers", () => {
  it("labels and colours every display status", () => {
    for (const status of DISPLAY) {
      expect(DISPLAY_STATUS_LABELS[status]).toBeTruthy()
      expect(DISPLAY_STATUS_PILL_CLASS[status]).toMatch(/^bg-/)
      expect(isRequestDisplayStatus(status)).toBe(true)
    }
  })

  it("gives every display status a tone, muted when unknown", () => {
    for (const status of DISPLAY) expect(displayStatusTone(status)).toBeTruthy()
    expect(displayStatusTone("completed")).toBe("success")
    expect(displayStatusTone("rejected")).toBe("danger")
    expect(displayStatusTone("awaiting_invoice")).toBe("warning")
    expect(displayStatusTone("nope")).toBe("muted")
    expect(displayStatusTone(null)).toBe("muted")
  })

  it("is defensive about unknown values", () => {
    expect(isRequestDisplayStatus("draft")).toBe(false)
    expect(isRequestDisplayStatus(null)).toBe(false)
    expect(displayStatusLabel("nope")).toBe("Unknown")
    expect(displayStatusPillClass(undefined)).toBe("bg-muted text-muted-foreground")
  })

  it("falls back to the review state when the RPC value is missing", () => {
    expect(displayStatusOrReviewState("completed", "submitted")).toBe("completed")
    expect(displayStatusOrReviewState(undefined, "rejected")).toBe("rejected")
    expect(displayStatusOrReviewState(undefined, "awaiting_approval")).toBe("awaiting_approval")
    expect(displayStatusOrReviewState(undefined, "submitted")).toBe("being_reviewed")
  })

  it("formats the invoice column and item summary for the list", () => {
    expect(
      requestInvoiceColumnLabel({ invoice_status: "invoiced", invoice_number: "INV-9" }),
    ).toBe("INV-9")
    expect(requestInvoiceColumnLabel({ invoice_status: "pending" })).toBe("Pending")
    expect(
      requestInvoiceColumnLabel({
        invoice_status: "not_invoiced",
        invoice_approval: "awaiting",
      }),
    ).toBe("Awaiting approval")
    expect(
      requestInvoiceColumnLabel({
        invoice_status: "not_invoiced",
        invoice_approval: "approved",
        not_invoiced_kind: "internal",
      }),
    ).toBe("Not invoiced · Internal")
    expect(
      requestItemsSummary([
        { product_name: "Starlink Standard Kit v4", quantity_requested: 2, sort_order: 0 },
        { product_name: "UCG Ultra", quantity_requested: 1, sort_order: 1 },
      ]),
    ).toBe("Starlink Standard Kit v4 ×2, UCG Ultra +1")
  })
})
