import { describe, expect, it } from "vitest"
import {
  computeMovementResult,
  getRevertUpdatesForTransaction,
  parseSaleDateOverride,
  validateMovementForItem,
} from "@/lib/supabase/movement-utils"
import type { InventoryItem, ItemStatus, Transaction, TransactionType } from "@/lib/data"

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
      for (const st of [
        "Sold",
        "POC",
        "Rented",
        "Maintenance",
        "RMA Hold",
        "Disposed",
        "Pending Inspection",
      ] as ItemStatus[]) {
        it(`blocks ${type} from ${st}`, () => {
          expect(validateMovementForItem(type, item({ status: st }), ctx)).toMatch(/Not available/)
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
    for (const st of ["Sold", "POC", "Rented", "Disposed"] as ItemStatus[]) {
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
    expect(result.newTransactions[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}T/)
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
    })
    expect(result.newTransactions[0]?.type).toBe("Rentals")
  })

  it("POC Return: returns to In Stock at toLocation", () => {
    const result = computeMovementResult(
      [item({ status: "POC", location: "Client Site", client: "Acme" })],
      { ...baseParams, type: "POC Return", toLocation: "Warehouse B" }
    )
    expect(result.updatedItems[0]).toMatchObject({
      status: "In Stock",
      location: "Warehouse B",
      client: undefined,
    })
  })

  it("Rental Return: returns to In Stock", () => {
    const result = computeMovementResult(
      [item({ status: "Rented", location: "Client Site" })],
      { ...baseParams, type: "Rental Return", toLocation: "Warehouse A" }
    )
    expect(result.updatedItems[0]?.status).toBe("In Stock")
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

function txn(overrides: Partial<Transaction> & Pick<Transaction, "type">): Transaction {
  return {
    id: "TXN-1",
    serialNumber: "SN-1",
    itemName: "Starlink Standard Kit v4",
    client: "",
    date: "2026-03-01T00:00:00.000Z",
    ...overrides,
  }
}

function priorFields(row: InventoryItem) {
  return {
    status: row.status,
    location: row.location,
    client: row.client,
    assignedTo: row.assignedTo,
    pocOutDate: row.pocOutDate,
    returnDate: row.returnDate,
  }
}

describe("getRevertUpdatesForTransaction", () => {
  it("Inbound: empty patch (does not restore prior status/location)", () => {
    expect(getRevertUpdatesForTransaction(txn({ type: "Inbound" }))).toEqual({})
  })

  it("Sale: In Stock / Warehouse A and clears client + assignedTo; invoice lives on the txn, not the item", () => {
    const saleTxn = txn({
      type: "Sale",
      client: "Acme - Acme Co",
      clientId: "client-1",
      assignedTo: "Jane",
      invoiceNumber: "INV-99",
    })
    const patch = getRevertUpdatesForTransaction(saleTxn)
    expect(patch).toEqual({
      status: "In Stock",
      location: "Warehouse A",
      client: undefined,
      assignedTo: undefined,
    })
    expect(patch).not.toHaveProperty("invoiceNumber")

    const sold = item({
      status: "Sold",
      location: "Delivered",
      client: "Acme - Acme Co",
      assignedTo: "Jane",
    })
    expect(priorFields({ ...sold, ...patch })).toEqual({
      status: "In Stock",
      location: "Warehouse A",
      client: undefined,
      assignedTo: undefined,
      pocOutDate: undefined,
      returnDate: undefined,
    })
  })

  it("Sale: does not clear leftover pocOutDate / returnDate (current patch omits those keys)", () => {
    const sold = item({
      status: "Sold",
      location: "Delivered",
      client: "Acme - Acme Co",
      assignedTo: "Jane",
      pocOutDate: "2026-01-10",
      returnDate: "2026-02-10",
    })
    const reverted = { ...sold, ...getRevertUpdatesForTransaction(txn({ type: "Sale" })) }
    expect(reverted.pocOutDate).toBe("2026-01-10")
    expect(reverted.returnDate).toBe("2026-02-10")
  })

  it("POC Out: In Stock / Warehouse A, clears client, assignedTo, pocOutDate", () => {
    const patch = getRevertUpdatesForTransaction(txn({ type: "POC Out", client: "Acme - Acme Co" }))
    expect(patch).toEqual({
      status: "In Stock",
      location: "Warehouse A",
      client: undefined,
      assignedTo: undefined,
      pocOutDate: undefined,
    })
    const out = item({
      status: "POC",
      location: "Client Site",
      client: "Acme - Acme Co",
      assignedTo: "Jane",
      pocOutDate: "2026-03-01",
      returnDate: "2026-03-15",
    })
    const reverted = { ...out, ...patch }
    expect(priorFields(reverted)).toEqual({
      status: "In Stock",
      location: "Warehouse A",
      client: undefined,
      assignedTo: undefined,
      pocOutDate: undefined,
      returnDate: "2026-03-15",
    })
  })

  it("POC Return: POC / Client Site and clears client + assignedTo (does not restore dates or the prior client)", () => {
    const patch = getRevertUpdatesForTransaction(
      txn({ type: "POC Return", client: "Acme - Acme Co", assignedTo: "Jane" })
    )
    expect(patch).toEqual({
      status: "POC",
      location: "Client Site",
      client: undefined,
      assignedTo: undefined,
    })
    const returned = item({
      status: "In Stock",
      location: "Warehouse A",
    })
    const reverted = { ...returned, ...patch }
    expect(priorFields(reverted)).toEqual({
      status: "POC",
      location: "Client Site",
      client: undefined,
      assignedTo: undefined,
      pocOutDate: undefined,
      returnDate: undefined,
    })
  })

  it("Rental Return: Rented / Client Site and clears client, assignedTo, pocOutDate, returnDate", () => {
    const patch = getRevertUpdatesForTransaction(txn({ type: "Rental Return", client: "Acme - Acme Co" }))
    expect(patch).toEqual({
      status: "Rented",
      location: "Client Site",
      client: undefined,
      assignedTo: undefined,
      pocOutDate: undefined,
      returnDate: undefined,
    })
    const returned = item({
      status: "In Stock",
      location: "Warehouse A",
      pocOutDate: "stale",
      returnDate: "stale",
    })
    expect(priorFields({ ...returned, ...patch })).toEqual({
      status: "Rented",
      location: "Client Site",
      client: undefined,
      assignedTo: undefined,
      pocOutDate: undefined,
      returnDate: undefined,
    })
  })

  it("Sale Return: Sold / Delivered and restores client/assignedTo from the txn (empty client → undefined)", () => {
    const withClient = getRevertUpdatesForTransaction(
      txn({ type: "Sale Return", client: "Acme - Acme Co", assignedTo: "Jane" })
    )
    expect(withClient).toEqual({
      status: "Sold",
      location: "Delivered",
      client: "Acme - Acme Co",
      assignedTo: "Jane",
    })

    const clientOnly = getRevertUpdatesForTransaction(txn({ type: "Sale Return", client: "Acme - Acme Co" }))
    expect(clientOnly.client).toBe("Acme - Acme Co")
    expect(clientOnly.assignedTo).toBe("Acme - Acme Co")

    const emptyClient = getRevertUpdatesForTransaction(txn({ type: "Sale Return", client: "" }))
    expect(emptyClient.client).toBeUndefined()
    expect(emptyClient.assignedTo).toBeUndefined()
  })

  it("Rentals: In Stock / Warehouse A and clears client, assignedTo, pocOutDate, returnDate", () => {
    const patch = getRevertUpdatesForTransaction(txn({ type: "Rentals", client: "Acme - Acme Co" }))
    expect(patch).toEqual({
      status: "In Stock",
      location: "Warehouse A",
      client: undefined,
      assignedTo: undefined,
      pocOutDate: undefined,
      returnDate: undefined,
    })
    const rented = item({
      status: "Rented",
      location: "Client Site",
      client: "Acme - Acme Co",
      assignedTo: "Jane",
      pocOutDate: "2026-03-01",
      returnDate: "2026-03-31",
    })
    expect(priorFields({ ...rented, ...patch })).toEqual({
      status: "In Stock",
      location: "Warehouse A",
      client: undefined,
      assignedTo: undefined,
      pocOutDate: undefined,
      returnDate: undefined,
    })
  })

  it("Transfer: restores fromLocation when present; empty patch when absent", () => {
    expect(
      getRevertUpdatesForTransaction(txn({ type: "Transfer", fromLocation: "Warehouse A", toLocation: "Warehouse B" }))
    ).toEqual({ location: "Warehouse A" })
    expect(getRevertUpdatesForTransaction(txn({ type: "Transfer" }))).toEqual({})
  })

  it("Dispose: In Stock / Warehouse A and clears client + assignedTo (caller still blocks undo)", () => {
    expect(getRevertUpdatesForTransaction(txn({ type: "Dispose" }))).toEqual({
      status: "In Stock",
      location: "Warehouse A",
      client: undefined,
      assignedTo: undefined,
    })
  })

  it.each([
    "Decommissioned",
    "Inspection Pass",
    "Inspection Fail",
    "Remediation Loaner Issue",
    "Reversal",
  ] as const)("%s: empty patch (type not handled)", (type) => {
    expect(getRevertUpdatesForTransaction(txn({ type }))).toEqual({})
  })

  it("does not read the inventory item — same Sale patch whether the row is missing, trashed, or present", () => {
    const sale = txn({ type: "Sale", client: "Acme - Acme Co", invoiceNumber: "INV-99" })
    const patch = getRevertUpdatesForTransaction(sale)
    const trashed = item({
      status: "Sold",
      location: "Delivered",
      client: "Acme - Acme Co",
      deletedAt: "2026-04-01T00:00:00.000Z",
    })
    expect(patch).toEqual({
      status: "In Stock",
      location: "Warehouse A",
      client: undefined,
      assignedTo: undefined,
    })
    expect({ ...trashed, ...patch }.deletedAt).toBe("2026-04-01T00:00:00.000Z")
    expect(getRevertUpdatesForTransaction(sale)).toEqual(patch)
  })

  it("Sale round-trip via computeMovementResult restores warehouse fields (not invoice)", () => {
    const prior = item({ status: "In Stock", location: "Warehouse A" })
    const moved = computeMovementResult([prior], {
      serialNumbers: ["SN-1"],
      type: "Sale",
      clientDisplay: "Acme - Acme Co",
      clientId: "client-1",
      assignedTo: "Jane",
      invoiceNumber: "INV-99",
    })
    expect(moved.updatedItems[0]).toMatchObject({
      status: "Sold",
      location: "Delivered",
      client: "Acme - Acme Co",
      assignedTo: "Jane",
    })
    const reverted = { ...moved.updatedItems[0]!, ...getRevertUpdatesForTransaction(moved.newTransactions[0]!) }
    expect(priorFields(reverted)).toEqual(priorFields(prior))
    expect(moved.newTransactions[0]?.invoiceNumber).toBe("INV-99")
  })
})
