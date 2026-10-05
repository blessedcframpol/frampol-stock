import { describe, expect, it } from "vitest"
import {
  computeMovementResult,
  parseSaleDateOverride,
  validateMovementForItem,
} from "@/lib/supabase/movement-utils"
import type { InventoryItem, ItemStatus, TransactionType } from "@/lib/data"
import { businessDateToIso, todayBusinessDate } from "@/lib/business-date.mjs"
import { movementResult } from "@/lib/movement-transitions.mjs"

function item(overrides: Partial<InventoryItem> & Pick<InventoryItem, "status">): InventoryItem {
  return {
    id: "INV-1",
    serialNumber: "SN-1",
    name: "Starlink Standard Kit v4",
    vendor: "Starlink",
    dateAdded: "2026-01-01",
    location: "Warehouse A",
    ...overrides,
  }
}

describe("parseSaleDateOverride", () => {
  it("accepts a valid YYYY-MM-DD as exactly `${d}T00:00:00.000Z`", () => {
    const result = parseSaleDateOverride("2026-05-28")
    expect(result).toEqual({ ok: true, iso: "2026-05-28T00:00:00.000Z" })
  })

  it("does not introduce a timezone shift relative to the host offset", () => {
    const result = parseSaleDateOverride("2026-05-28")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.iso).toBe("2026-05-28T00:00:00.000Z")
    expect(new Date(result.iso).toISOString()).toBe(result.iso)
    expect(result.iso.endsWith("Z")).toBe(true)
    expect(result.iso.slice(0, 10)).toBe("2026-05-28")
  })

  it("rejects the production-corrupting 5-digit year 52026-05-28", () => {
    const result = parseSaleDateOverride("52026-05-28")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/YYYY-MM-DD/i)
  })

  it("rejects the production-corrupting short year 0206-05-18", () => {
    const result = parseSaleDateOverride("0206-05-18")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/between 2020 and 2100/i)
  })

  it("rejects year 2019", () => {
    expect(parseSaleDateOverride("2019-12-31").ok).toBe(false)
  })

  it("rejects year 2101", () => {
    expect(parseSaleDateOverride("2101-01-01").ok).toBe(false)
  })

  it("rejects empty string", () => {
    expect(parseSaleDateOverride("").ok).toBe(false)
  })

  it("rejects undefined by throwing (current signature is string-only)", () => {
    expect(() => parseSaleDateOverride(undefined as unknown as string)).toThrow()
  })

  it("rejects not-a-date", () => {
    expect(parseSaleDateOverride("not-a-date").ok).toBe(false)
  })

  it("rejects 2026-13-45", () => {
    expect(parseSaleDateOverride("2026-13-45").ok).toBe(false)
  })
})

describe("validateMovementForItem", () => {
  const ctx = {}

  describe("trash", () => {
    it("blocks any movement when deletedAt is set", () => {
      expect(
        validateMovementForItem("Sale", item({ status: "In Stock", deletedAt: "2026-01-01" }), ctx)
      ).toMatch(/Trash/i)
    })
  })

  describe("Sale / POC Out / Rentals", () => {
    for (const type of ["Sale", "POC Out", "Rentals"] as const) {
      it(`allows ${type} from In Stock`, () => {
        expect(validateMovementForItem(type, item({ status: "In Stock" }), ctx)).toBeNull()
      })
      const blocked = (
        type === "Sale"
          ? ["Sold", "Rented", "Maintenance", "RMA Hold", "Disposed", "Pending Inspection"]
          : ["Sold", "POC", "Rented", "Maintenance", "RMA Hold", "Disposed", "Pending Inspection"]
      ) as ItemStatus[]
      for (const st of blocked) {
        it(`blocks ${type} from ${st}`, () => {
          expect(validateMovementForItem(type, item({ status: st }), ctx)).toMatch(/Not available/)
        })
      }
      if (type === "Sale") {
        it("allows Sale from POC", () => {
          expect(validateMovementForItem("Sale", item({ status: "POC" }), ctx)).toBeNull()
        })
        it("blocks Sale of a rental or demo kit that is still In Stock", () => {
          expect(validateMovementForItem("Sale", item({ status: "In Stock", stockPool: "rental" }), ctx)).toMatch(/sellable/)
          expect(validateMovementForItem("Sale", item({ status: "In Stock", stockPool: "demo" }), ctx)).toMatch(/sellable/)
        })
      }
      if (type === "Rentals") {
        it("blocks Rentals from the demo group", () => {
          expect(validateMovementForItem("Rentals", item({ status: "In Stock", stockPool: "demo" }), ctx)).toMatch(/demo/)
          expect(
            validateMovementForItem("Rentals", item({ status: "In Stock", vendor: "Fortinet" }), ctx),
          ).toMatch(/Starlink/)
        })
      }
      if (type === "POC Out") {
        it("blocks POC Out from the rental group", () => {
          expect(validateMovementForItem("POC Out", item({ status: "In Stock", stockPool: "rental" }), ctx)).toMatch(/rental/)
        })
      }
    }
  })

  describe("Dispose", () => {
    for (const st of ["In Stock", "Maintenance", "RMA Hold", "Pending Inspection"] as ItemStatus[]) {
      it(`allows Dispose from ${st}`, () => {
        expect(validateMovementForItem("Dispose", item({ status: st }), ctx)).toBeNull()
      })
    }
    for (const st of ["Sold", "POC", "Rented", "Disposed"] as ItemStatus[]) {
      it(`blocks Dispose from ${st}`, () => {
        expect(validateMovementForItem("Dispose", item({ status: st }), ctx)).toMatch(/Cannot dispose/)
      })
    }
  })

  describe("Transfer", () => {
    for (const st of ["In Stock", "Maintenance", "RMA Hold", "Pending Inspection"] as ItemStatus[]) {
      it(`allows Transfer from ${st}`, () => {
        expect(validateMovementForItem("Transfer", item({ status: st }), ctx)).toBeNull()
      })
    }
    for (const st of ["POC", "Rented"] as ItemStatus[]) {
      it(`allows Transfer from ${st} without changing status`, () => {
        expect(validateMovementForItem("Transfer", item({ status: st, location: "Client Site" }), ctx)).toBeNull()
        expect(movementResult(st, "Transfer")).toBe(st)
      })
    }
    for (const st of ["Sold", "Disposed"] as ItemStatus[]) {
      it(`blocks Transfer from ${st}`, () => {
        expect(validateMovementForItem("Transfer", item({ status: st }), ctx)).toMatch(/Cannot transfer/)
      })
    }
    it("blocks Transfer when fromLocation does not match item location", () => {
      expect(
        validateMovementForItem(
          "Transfer",
          item({ status: "In Stock", location: "Warehouse A" }),
          { fromLocation: "Warehouse B" }
        )
      ).toMatch(/not Warehouse B/)
    })
    it("allows Transfer when fromLocation matches", () => {
      expect(
        validateMovementForItem(
          "Transfer",
          item({ status: "In Stock", location: "Warehouse A" }),
          { fromLocation: "Warehouse A" }
        )
      ).toBeNull()
    })
  })

  describe("Inbound", () => {
    it("blocks Inbound when already In Stock", () => {
      expect(validateMovementForItem("Inbound", item({ status: "In Stock" }), ctx)).toMatch(
        /Already in stock/
      )
    })
    for (const st of ["Sold", "POC", "Rented", "Disposed"] as ItemStatus[]) {
      it(`blocks Inbound from ${st} (use return/undo)`, () => {
        expect(validateMovementForItem("Inbound", item({ status: st }), ctx)).toMatch(/not Inbound/)
      })
    }
    for (const st of ["Maintenance", "RMA Hold"] as ItemStatus[]) {
      it(`allows Inbound from ${st}`, () => {
        expect(validateMovementForItem("Inbound", item({ status: st }), ctx)).toBeNull()
      })
    }
    it("blocks Inbound from Pending Inspection", () => {
      expect(
        validateMovementForItem("Inbound", item({ status: "Pending Inspection" }), ctx)
      ).toMatch(/Inbound not allowed/)
    })
  })

  describe("returns", () => {
    it("allows POC Return from POC only", () => {
      expect(validateMovementForItem("POC Return", item({ status: "POC" }), ctx)).toBeNull()
      expect(validateMovementForItem("POC Return", item({ status: "In Stock" }), ctx)).toMatch(
        /requires status POC/
      )
    })
    it("allows Rental Return from Rented only", () => {
      expect(validateMovementForItem("Rental Return", item({ status: "Rented" }), ctx)).toBeNull()
      expect(validateMovementForItem("Rental Return", item({ status: "In Stock" }), ctx)).toMatch(
        /requires status Rented/
      )
    })
    it("allows Sale Return from Sold only", () => {
      expect(validateMovementForItem("Sale Return", item({ status: "Sold" }), ctx)).toBeNull()
      expect(validateMovementForItem("Sale Return", item({ status: "In Stock" }), ctx)).toMatch(
        /requires status Sold/
      )
    })
  })

  describe("Decommissioned", () => {
    for (const st of ["POC", "Rented", "Sold"] as ItemStatus[]) {
      it(`allows Decommissioned from ${st}`, () => {
        expect(validateMovementForItem("Decommissioned", item({ status: st }), ctx)).toBeNull()
      })
    }
    it("blocks Decommissioned from In Stock", () => {
      expect(validateMovementForItem("Decommissioned", item({ status: "In Stock" }), ctx)).toMatch(
        /requires status POC, Rented, or Sold/
      )
    })
  })

  describe("Inspection", () => {
    for (const type of ["Inspection Pass", "Inspection Fail"] as TransactionType[]) {
      it(`allows ${type} from Pending Inspection`, () => {
        expect(
          validateMovementForItem(type, item({ status: "Pending Inspection" }), ctx)
        ).toBeNull()
      })
      it(`blocks ${type} from In Stock`, () => {
        expect(validateMovementForItem(type, item({ status: "In Stock" }), ctx)).toMatch(
          /Pending Inspection/
        )
      })
    }
  })

  describe("Remediation Loaner Issue", () => {
    it("allows from In Stock", () => {
      expect(
        validateMovementForItem("Remediation Loaner Issue", item({ status: "In Stock" }), ctx)
      ).toBeNull()
    })
    it("blocks from Sold", () => {
      expect(
        validateMovementForItem("Remediation Loaner Issue", item({ status: "Sold" }), ctx)
      ).toMatch(/In Stock/)
    })
  })

  describe("product expectations", () => {
    it("blocks when expectedProductName does not match", () => {
      expect(
        validateMovementForItem("Sale", item({ status: "In Stock", name: "Kit A" }), {
          expectedProductName: "Kit B",
        })
      ).toMatch(/not the selected product/)
    })
    it("blocks when expectedVendor does not match", () => {
      expect(
        validateMovementForItem("Sale", item({ status: "In Stock", vendor: "Starlink" }), {
          expectedVendor: "Fortinet",
        })
      ).toMatch(/Vendor mismatch/)
    })
  })
})

describe("computeMovementResult", () => {
  const baseParams = {
    serialNumbers: ["SN-1"],
    clientDisplay: "Acme - Acme Co",
    clientId: "client-1",
  }

  it("Sale: sets Sold / Delivered and emits a Sale transaction (no date override)", () => {
    const inv = [item({ status: "In Stock" })]
    const result = computeMovementResult(inv, { ...baseParams, type: "Sale" })
    expect(result.saleDateError).toBeUndefined()
    expect(result.success).toEqual(["SN-1"])
    expect(result.updatedItems[0]?.status).toBe("Sold")
    expect(result.updatedItems[0]?.location).toBe("Delivered")
    expect(result.updatedItems[0]?.client).toBe("Acme - Acme Co")
    expect(result.newTransactions).toHaveLength(1)
    expect(result.newTransactions[0]).toMatchObject({
      type: "Sale",
      serialNumber: "SN-1",
      itemName: "Starlink Standard Kit v4",
      client: "Acme - Acme Co",
      clientId: "client-1",
    })
    expect(result.newTransactions[0]?.date).toBe(businessDateToIso(todayBusinessDate("Africa/Harare")))
  })

  it("Sale with sale-date override uses the UTC midnight ISO on the transaction", () => {
    const inv = [item({ status: "In Stock" })]
    const result = computeMovementResult(inv, {
      ...baseParams,
      type: "Sale",
      saleTransactionDateIso: "2026-05-28",
    })
    expect(result.saleDateError).toBeUndefined()
    expect(result.newTransactions[0]?.date).toBe("2026-05-28T00:00:00.000Z")
    expect(result.updatedItems[0]?.status).toBe("Sold")
  })

  it("Sale with invalid sale-date override returns saleDateError and does no work", () => {
    const inv = [item({ status: "In Stock" })]
    const result = computeMovementResult(inv, {
      ...baseParams,
      type: "Sale",
      saleTransactionDateIso: "52026-05-28",
    })
    expect(result.saleDateError).toBeTruthy()
    expect(result.success).toEqual([])
    expect(result.updatedItems).toEqual([])
    expect(result.newTransactions).toEqual([])
  })

  it("POC Out: sets POC / Client Site", () => {
    const result = computeMovementResult([item({ status: "In Stock" })], {
      ...baseParams,
      type: "POC Out",
      returnDate: "2026-06-01",
    })
    expect(result.updatedItems[0]).toMatchObject({
      status: "POC",
      location: "Client Site",
      returnDate: "2026-06-01",
    })
    expect(result.newTransactions[0]?.type).toBe("POC Out")
    expect(result.newTransactions[0]?.date).toBe(businessDateToIso(todayBusinessDate("Africa/Harare")))
  })

  it("Sale from POC keeps the client, clears the return date, and records converted_from", () => {
    const result = computeMovementResult(
      [
        item({
          status: "POC",
          location: "Client Site",
          client: "Joseph Shenjere",
          assignedTo: "Joseph Shenjere",
          pocOutDate: "2026-06-01",
          returnDate: "2026-06-01",
          assignmentHistory: [{ date: "2026-06-01", assignedTo: "Joseph Shenjere", notes: "POC Out" }],
        }),
      ],
      { ...baseParams, type: "Sale", invoiceNumber: "", saleTransactionDateIso: "2026-10-01" }
    )
    expect(result.success).toEqual(["SN-1"])
    expect(result.updatedItems[0]).toMatchObject({
      status: "Sold",
      location: "Client Site",
      client: "Joseph Shenjere",
      assignedTo: "Joseph Shenjere",
      pocOutDate: "2026-06-01",
      returnDate: undefined,
      assignmentHistory: [{ date: "2026-06-01", assignedTo: "Joseph Shenjere", notes: "POC Out" }],
    })
    expect(result.newTransactions[0]).toMatchObject({
      type: "Sale",
      client: "Joseph Shenjere",
      invoiceNumber: "",
      date: "2026-10-01T00:00:00.000Z",
      metadata: { converted_from: "POC", poc_out_date: "2026-06-01" },
    })
  })

  it("Rentals: sets Rented / Client Site with returnDate", () => {
    const result = computeMovementResult([item({ status: "In Stock" })], {
      ...baseParams,
      type: "Rentals",
      returnDate: "2026-07-01",
    })
    expect(result.updatedItems[0]).toMatchObject({
      status: "Rented",
      location: "Client Site",
      returnDate: "2026-07-01",
      stockPool: "rental",
    })
    expect(result.newTransactions[0]?.type).toBe("Rentals")
  })

  it("POC Return: returns to In Stock at toLocation", () => {
    const result = computeMovementResult(
      [item({ status: "POC", location: "Client Site", client: "Acme", stockPool: "sale" })],
      { ...baseParams, type: "POC Return", toLocation: "Warehouse B", returnPool: "demo" }
    )
    expect(result.updatedItems[0]).toMatchObject({
      status: "In Stock",
      location: "Warehouse B",
      client: undefined,
      stockPool: "demo",
    })
    expect(result.newTransactions[0]?.returnPool).toBe("demo")
  })

  it("POC Return without a group choice is rejected", () => {
    const result = computeMovementResult(
      [item({ status: "POC", location: "Client Site" })],
      { ...baseParams, type: "POC Return", toLocation: "Warehouse A" }
    )
    expect(result.updatedItems).toHaveLength(0)
    expect(result.rejected[0]?.reason).toMatch(/Back in sellable stock/)
  })

  it("Rental Return: pending inspection, rental group", () => {
    const result = computeMovementResult(
      [item({ status: "Rented", location: "Client Site", stockPool: "rental" })],
      { ...baseParams, type: "Rental Return", toLocation: "Warehouse A" }
    )
    expect(result.updatedItems[0]).toMatchObject({ status: "Pending Inspection", stockPool: "rental" })
  })

  it("Sale Return: moves Sold to RMA Hold", () => {
    const result = computeMovementResult([item({ status: "Sold", location: "Delivered" })], {
      ...baseParams,
      type: "Sale Return",
      toLocation: "Warehouse A",
    })
    expect(result.updatedItems[0]).toMatchObject({ status: "RMA Hold", location: "Warehouse A" })
  })

  it("Transfer: changes location only", () => {
    const result = computeMovementResult([item({ status: "In Stock", location: "Warehouse A" })], {
      ...baseParams,
      type: "Transfer",
      fromLocation: "Warehouse A",
      toLocation: "Warehouse B",
    })
    expect(result.updatedItems[0]).toMatchObject({ status: "In Stock", location: "Warehouse B" })
    expect(result.newTransactions[0]).toMatchObject({
      type: "Transfer",
      fromLocation: "Warehouse A",
      toLocation: "Warehouse B",
    })
  })

  it("Transfer from POC changes location and stays POC", () => {
    const result = computeMovementResult(
      [item({ status: "POC", location: "Client Site", client: "Acme" })],
      {
        ...baseParams,
        type: "Transfer",
        fromLocation: "Client Site",
        toLocation: "Warehouse B",
      }
    )
    expect(result.updatedItems[0]).toMatchObject({ status: "POC", location: "Warehouse B", client: "Acme" })
  })

  it("Dispose: sets Disposed", () => {
    const result = computeMovementResult([item({ status: "In Stock" })], {
      ...baseParams,
      type: "Dispose",
      disposalReason: "EOL",
      authorisedBy: "Admin",
    })
    expect(result.updatedItems[0]?.status).toBe("Disposed")
    expect(result.newTransactions[0]).toMatchObject({
      type: "Dispose",
      disposalReason: "EOL",
      authorisedBy: "Admin",
    })
  })

  it("Inbound: Maintenance → In Stock", () => {
    const result = computeMovementResult([item({ status: "Maintenance" })], {
      ...baseParams,
      type: "Inbound",
      toLocation: "Warehouse A",
      deliveryNoteUrl: "https://example.com/dn.pdf",
    })
    expect(result.updatedItems[0]?.status).toBe("In Stock")
    expect(result.newTransactions[0]).toMatchObject({
      type: "Inbound",
      deliveryNoteUrl: "https://example.com/dn.pdf",
    })
  })

  it("Decommissioned: POC → Pending Inspection", () => {
    const result = computeMovementResult([item({ status: "POC", location: "Client Site" })], {
      ...baseParams,
      type: "Decommissioned",
      toLocation: "Warehouse A",
    })
    expect(result.updatedItems[0]).toMatchObject({
      status: "Pending Inspection",
      location: "Warehouse A",
    })
  })

  it("Inspection Pass: Pending Inspection → In Stock", () => {
    const result = computeMovementResult([item({ status: "Pending Inspection" })], {
      ...baseParams,
      type: "Inspection Pass",
      toLocation: "Warehouse A",
    })
    expect(result.updatedItems[0]?.status).toBe("In Stock")
    expect(result.newTransactions[0]?.metadata).toMatchObject({ inspectionOutcome: "available" })
  })

  it("Inspection Fail: Pending Inspection → RMA Hold", () => {
    const result = computeMovementResult([item({ status: "Pending Inspection" })], {
      ...baseParams,
      type: "Inspection Fail",
      toLocation: "Warehouse A",
    })
    expect(result.updatedItems[0]?.status).toBe("RMA Hold")
    expect(result.newTransactions[0]?.metadata).toMatchObject({ inspectionOutcome: "faulty" })
  })

  it("Remediation Loaner Issue: In Stock → Sold / Delivered", () => {
    const result = computeMovementResult([item({ status: "In Stock" })], {
      ...baseParams,
      type: "Remediation Loaner Issue",
    })
    expect(result.updatedItems[0]).toMatchObject({ status: "Sold", location: "Delivered" })
  })

  it("rejects illegal Sale from Sold without updating inventory", () => {
    const result = computeMovementResult([item({ status: "Sold" })], {
      ...baseParams,
      type: "Sale",
    })
    expect(result.success).toEqual([])
    expect(result.rejected).toHaveLength(1)
    expect(result.updatedItems).toEqual([])
  })
})
