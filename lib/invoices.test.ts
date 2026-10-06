import { describe, expect, it } from "vitest"
import {
  displayedInvoice,
  invoiceChoiceProblem,
  invoiceEventLabel,
  invoiceStateLabel,
  realInvoiceNumberProblem,
} from "@/lib/invoices"

describe("real invoice numbers", () => {
  it("rejects placeholders and accepts a real number", () => {
    expect(realInvoiceNumberProblem("  ")).toMatch(/required/)
    expect(realInvoiceNumberProblem("-")).toMatch(/placeholder/)
    expect(realInvoiceNumberProblem("N/A")).toMatch(/placeholder/)
    expect(realInvoiceNumberProblem("0000")).toMatch(/placeholder/)
    expect(realInvoiceNumberProblem("000000")).toMatch(/placeholder/)
    expect(realInvoiceNumberProblem("00000")).toMatch(/not an invoice number/)
    expect(realInvoiceNumberProblem(" 80183 ")).toBeNull()
  })
})

describe("invoice choice", () => {
  it("requires one of the three choices", () => {
    expect(invoiceChoiceProblem("", "", "")).toMatch(/Invoice pending/)
    expect(invoiceChoiceProblem("pending", "", "")).toBeNull()
    expect(invoiceChoiceProblem("not_invoiced", "", "short")).toMatch(/at least 15/)
    expect(invoiceChoiceProblem("not_invoiced", "", "Complimentary kit for the site")).toBeNull()
    expect(invoiceChoiceProblem("number", "80183", "")).toBeNull()
  })
})

describe("invoice labels", () => {
  it("shows the state a reader should see", () => {
    expect(invoiceStateLabel({ status: "invoiced", invoiceNumber: "80183" })).toBe("80183")
    expect(invoiceStateLabel({ status: "pending", legacy: true })).toBe("Invoice pending · legacy")
    expect(invoiceStateLabel({ status: "not_invoiced", approval: "awaiting" })).toBe("Awaiting approval")
    expect(invoiceStateLabel({ status: "legacy_unreviewed" })).toBe("00000 — unreviewed")
    expect(displayedInvoice({ type: "Sale", invoiceNumber: "00000" })).toBe("—")
    expect(
      displayedInvoice({
        type: "Sale",
        invoiceNumber: "00000",
        invoiceState: { status: "legacy_unreviewed", legacy: true },
      }),
    ).toBe("00000 — unreviewed")
    expect(displayedInvoice({ type: "Dispose", invoiceNumber: "00000" })).toBe("00000")
    expect(
      invoiceEventLabel({
        id: "1",
        batchId: "B",
        oldStatus: "pending",
        newStatus: "invoiced",
        newInvoiceNumber: "80183",
        reason: "Found the invoice",
        createdAt: "2026-10-05T00:00:00.000Z",
      }),
    ).toBe("pending → invoiced · 80183 · Found the invoice")
  })
})
