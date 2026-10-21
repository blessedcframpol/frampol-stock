import { describe, expect, it } from "vitest"
import type { InventoryItem } from "@/lib/data"
import {
  TRANSACTION_TYPE_CHOICES,
  buildSerialFeedback,
  businessDateProblem,
  disposalReasonProblem,
  groupForType,
  requiresClient,
  requiresInvoice,
  requiresWarehouseLocation,
  submitBlockMessage,
  transferDestinationProblem,
  transferOriginFromSerials,
  type MovementFormFields,
} from "@/lib/stock-movement-form-logic"

function item(partial: Partial<InventoryItem> & Pick<InventoryItem, "serialNumber">): InventoryItem {
  return {
    id: partial.id ?? `id-${partial.serialNumber}`,
    serialNumber: partial.serialNumber,
    name: partial.name ?? "Kit",
    vendor: partial.vendor ?? "Starlink",
    status: partial.status ?? "In Stock",
    location: partial.location ?? "Warehouse A",
    dateAdded: partial.dateAdded ?? "2026-01-01",
    stockPool: partial.stockPool ?? "sale",
    client: partial.client,
    assignedTo: partial.assignedTo,
    productIsActive: partial.productIsActive,
  }
}

function baseFields(over: Partial<MovementFormFields> = {}): MovementFormFields {
  return {
    type: "Sale",
    productName: "Kit",
    vendor: "Starlink",
    serialText: "S1",
    clientId: "client-1",
    invoiceChoice: "pending",
    invoiceNumber: "",
    invoiceReason: "",
    notInvoicedKind: "",
    returnDate: "",
    returnPool: "",
    intakeCategory: "",
    intakeReason: "",
    toLocation: "Warehouse A",
    disposalReason: "",
    authorisedBy: "",
    businessDate: "2026-10-09",
    notes: "",
    ...over,
  }
}

describe("P3.6 type groups", () => {
  it("groups Out / In / Move and omits Remediation Loaner", () => {
    expect(TRANSACTION_TYPE_CHOICES.some((c) => c.value === "Remediation Loaner Issue")).toBe(false)
    expect(groupForType("Sale")).toBe("out")
    expect(groupForType("Inbound")).toBe("in")
    expect(groupForType("Transfer")).toBe("move")
    expect(groupForType("Remediation Loaner Issue")).toBeNull()
  })

  it("requires client for Out and Decommissioned only", () => {
    expect(requiresClient("Sale")).toBe(true)
    expect(requiresClient("Dispose")).toBe(true)
    expect(requiresClient("Decommissioned")).toBe(true)
    expect(requiresClient("Transfer")).toBe(false)
    expect(requiresClient("Inbound")).toBe(false)
  })

  it("marks In movements as warehouse-only", () => {
    expect(requiresWarehouseLocation("Inbound")).toBe(true)
    expect(requiresWarehouseLocation("Sale Return")).toBe(true)
    expect(requiresWarehouseLocation("Sale")).toBe(false)
    expect(requiresInvoice("Rentals")).toBe(true)
  })
})

describe("serial feedback", () => {
  it("summarises duplicates, not found, and blocked sale kits", () => {
    const inventory = [
      item({ serialNumber: "OK", status: "In Stock", stockPool: "sale" }),
      item({ serialNumber: "RENT", status: "In Stock", stockPool: "rental" }),
    ]
    const feedback = buildSerialFeedback("Sale", "OK, OK, RENT, MISSING", inventory)
    expect(feedback.duplicateCount).toBe(1)
    expect(feedback.notFoundCount).toBe(1)
    expect(feedback.blockedCount).toBe(1)
    expect(feedback.validSerials).toEqual(["OK"])
    expect(feedback.summary).toContain("can't be sold")
    expect(feedback.summary).toMatch(/not in stock records/i)
  })

  it("stops unknown serials for non-Inbound (including Decommissioned)", () => {
    const feedback = buildSerialFeedback("Decommissioned", "UNKNOWN-1", [])
    expect(feedback.validSerials).toEqual([])
    expect(feedback.notFoundCount).toBe(1)
    expect(feedback.marks[0]?.detail).toMatch(/Not in stock records/i)
  })

  it("names product and status when Inbound scans an existing serial", () => {
    const feedback = buildSerialFeedback("Inbound", "EXIST", [
      item({ serialNumber: "EXIST", name: "Mini", vendor: "Starlink", status: "Sold" }),
    ])
    expect(feedback.validSerials).toEqual([])
    expect(feedback.blockedCount).toBe(1)
    expect(feedback.marks[0]?.detail).toMatch(/Mini · Starlink \(Sold\)/)
  })

  it("attaches kit product labels on Sale ok marks", () => {
    const feedback = buildSerialFeedback("Sale", "OK", [
      item({ serialNumber: "OK", name: "Mini", vendor: "Starlink", status: "In Stock", stockPool: "sale" }),
    ])
    expect(feedback.validSerials).toEqual(["OK"])
    expect(feedback.marks[0]?.detail).toBe("Mini · Starlink")
  })

  it("HF2: Sale ignores leftover Inbound expectedVendor=General against Starlink kit", () => {
    const feedback = buildSerialFeedback(
      "Sale",
      "KIT1",
      [item({ serialNumber: "KIT1", name: "Standard Kit v4", vendor: "Starlink", status: "In Stock", stockPool: "sale" })],
      { expectedVendor: "General", expectedProductName: "Something from Inbound picker" },
    )
    expect(feedback.blockedCount).toBe(0)
    expect(feedback.validSerials).toEqual(["KIT1"])
    expect(feedback.marks[0]?.detail).toBe("Standard Kit v4 · Starlink")
  })

  it("HF2: mixed-vendor batch is all valid on Sale (product from kits)", () => {
    const inventory = [
      item({ serialNumber: "A", vendor: "Starlink", name: "SL", status: "In Stock", stockPool: "sale" }),
      item({ serialNumber: "B", vendor: "Fortinet", name: "FG", status: "In Stock", stockPool: "sale" }),
      item({ serialNumber: "C", vendor: "Ubiquiti", name: "UB", status: "In Stock", stockPool: "sale" }),
      item({ serialNumber: "D", vendor: "General", name: "GN", status: "In Stock", stockPool: "sale" }),
    ]
    const feedback = buildSerialFeedback("Sale", "A, B, C, D", inventory, {
      expectedVendor: "General",
    })
    expect(feedback.validSerials).toEqual(["A", "B", "C", "D"])
    expect(feedback.blockedCount).toBe(0)
  })

  it("warns when returning a kit into an archived product", () => {
    const feedback = buildSerialFeedback("POC Return", "POC1", [
      item({
        serialNumber: "POC1",
        name: "Starlink Business Kit",
        vendor: "Starlink",
        status: "POC",
        productIsActive: false,
      }),
    ])
    expect(feedback.validSerials).toEqual(["POC1"])
    expect(feedback.archivedProductWarnCount).toBe(1)
    expect(feedback.marks[0]?.mark).toBe("warn")
    expect(feedback.marks[0]?.detail).toMatch(/This product is archived/)
  })
})

describe("Transfer origin / destination", () => {
  it("reads a single origin and rejects same destination", () => {
    const inventory = [
      item({ serialNumber: "A", location: "Warehouse A" }),
      item({ serialNumber: "B", location: "Warehouse A" }),
    ]
    expect(transferOriginFromSerials(["A", "B"], inventory)).toEqual({
      location: "Warehouse A",
      mixed: false,
    })
    expect(transferDestinationProblem("Warehouse A", "Warehouse A")).toMatch(/differ/i)
    expect(transferDestinationProblem("Warehouse B", "Warehouse A")).toBeNull()
  })

  it("flags mixed origins", () => {
    const inventory = [
      item({ serialNumber: "A", location: "Warehouse A" }),
      item({ serialNumber: "B", location: "Warehouse B" }),
    ]
    expect(transferOriginFromSerials(["A", "B"], inventory).mixed).toBe(true)
  })
})

describe("Dispose and dates", () => {
  it("enforces disposal reason length and business date", () => {
    expect(disposalReasonProblem("too short")).toMatch(/15/)
    expect(disposalReasonProblem("Beyond economical repair")).toBeNull()
    expect(businessDateProblem("2026-10-10", "2026-10-09")).toMatch(/future/i)
    expect(businessDateProblem("2026-10-09", "2026-10-09")).toBeNull()
  })
})

describe("Decommissioned unknown serial", () => {
  it("blocks submit until the serial is received via Inbound", () => {
    const feedback = buildSerialFeedback("Decommissioned", "UNKNOWN-1", [])
    expect(
      submitBlockMessage(
        baseFields({
          type: "Decommissioned",
          productName: "",
          clientId: "client-1",
          intakeCategory: "Client cancelled",
          intakeReason: "Service ended",
          invoiceChoice: "",
        }),
        feedback,
        { todayYmd: "2026-10-09", hasUnknownSerial: true },
      ),
    ).toMatch(/Not in stock records/i)
  })
})

describe("Inbound product required", () => {
  it("asks for a product only on Inbound", () => {
    const saleFeedback = buildSerialFeedback("Sale", "OK", [
      item({ serialNumber: "OK", status: "In Stock", stockPool: "sale" }),
    ])
    expect(
      submitBlockMessage(
        baseFields({ type: "Sale", productName: "", clientId: "c1", invoiceChoice: "pending" }),
        saleFeedback,
        { todayYmd: "2026-10-09" },
      ),
    ).toBeNull()

    const inboundFeedback = buildSerialFeedback("Inbound", "NEW-1", [])
    expect(
      submitBlockMessage(
        baseFields({ type: "Inbound", productName: "", invoiceChoice: "" }),
        inboundFeedback,
        { todayYmd: "2026-10-09" },
      ),
    ).toBe("Select a product")
  })
})

describe("submitBlockMessage", () => {
  it("asks for a client before recording a Sale", () => {
    const feedback = buildSerialFeedback("Sale", "OK", [
      item({ serialNumber: "OK", status: "In Stock", stockPool: "sale" }),
    ])
    expect(
      submitBlockMessage(baseFields({ clientId: "" }), feedback, { todayYmd: "2026-10-09" }),
    ).toBe("Select a client")
  })

  it("asks for authorising admin on Dispose", () => {
    const feedback = buildSerialFeedback("Dispose", "OK", [
      item({ serialNumber: "OK", status: "In Stock" }),
    ])
    const msg = submitBlockMessage(
      baseFields({
        type: "Dispose",
        disposalReason: "Beyond economical repair now",
        authorisedBy: "",
        invoiceChoice: "",
      }),
      feedback,
      { todayYmd: "2026-10-09" },
    )
    expect(msg).toMatch(/admin/i)
  })
})
