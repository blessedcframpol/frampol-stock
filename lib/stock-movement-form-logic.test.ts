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
  })

  it("allows unknown serials for Decommissioned", () => {
    const feedback = buildSerialFeedback("Decommissioned", "UNKNOWN-1", [])
    expect(feedback.validSerials).toEqual(["UNKNOWN-1"])
    expect(feedback.notFoundCount).toBe(0)
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
  it("requires client when an unknown serial is present", () => {
    const feedback = buildSerialFeedback("Decommissioned", "UNKNOWN-1", [])
    expect(
      submitBlockMessage(
        baseFields({
          type: "Decommissioned",
          clientId: "",
          intakeCategory: "Client cancelled",
          intakeReason: "Service ended",
          invoiceChoice: "",
        }),
        feedback,
        { todayYmd: "2026-10-09", hasUnknownSerial: true },
      ),
    ).toBe("Select a client")
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
