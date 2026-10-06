import { describe, expect, it } from "vitest"
import { ROLES, type AppRole } from "@/lib/permissions"
import {
  DISPATCHED_MOVEMENTS,
  dispatchResultLabel,
  dispatchRowsForBatch,
  filteredTotal,
  historyBatchCountLabel,
  movementChipIds,
  pageCount,
  reversalAffordances,
  type DispatchMember,
} from "@/lib/ledger-pages"

const HISTORY_COUNTS = {
  Sale: 697,
  Inbound: 85,
  Rentals: 26,
  "POC Out": 13,
  "Rental Return": 11,
  Dispose: 4,
  "POC Return": 2,
  "Sale Return": 1,
  Decommissioned: 1,
  Reversed: 15,
}

describe("filteredTotal", () => {
  it("uses the SQL movement count, not a page of rows", () => {
    expect(filteredTotal(HISTORY_COUNTS, null)).toBe(855)
    expect(filteredTotal(HISTORY_COUNTS, "Sale")).toBe(697)
    expect(filteredTotal(HISTORY_COUNTS, "Dispose")).toBe(4)
    expect(filteredTotal(HISTORY_COUNTS, "Transfer")).toBe(0)
    expect(filteredTotal(HISTORY_COUNTS, "Reversed")).toBe(15)
    expect(historyBatchCountLabel(filteredTotal(HISTORY_COUNTS, null), HISTORY_COUNTS.Reversed, null)).toBe(
      "855 batches · 15 reversed"
    )
    expect(historyBatchCountLabel(15, 15, "Reversed")).toBe("15 batches")
  })

  it("keeps the selected chip equal to the paginated total", () => {
    for (const [movement, count] of Object.entries(HISTORY_COUNTS)) {
      expect(filteredTotal(HISTORY_COUNTS, movement)).toBe(count)
    }
  })
})

describe("movementChipIds", () => {
  it("lists dispatched movements that have a SQL count", () => {
    expect(movementChipIds({ Sale: 1224, "POC Out": 17, Rentals: 14, Dispose: 64 }, null, DISPATCHED_MOVEMENTS)).toEqual([
      "Sale",
      "POC Out",
      "Rentals",
      "Dispose",
    ])
  })

  it("keeps a selected movement that currently has no rows", () => {
    expect(movementChipIds({ Sale: 3 }, "Dispose", DISPATCHED_MOVEMENTS)).toEqual(["Sale", "Dispose"])
  })
})

describe("dispatchRowsForBatch", () => {
  const sale: DispatchMember[] = [
    { serial: "KIT-1", product: "Starlink", client: "Acme", invoice: "86052", movement: "Sale", batchId: "BATCH-1" },
    { serial: "KIT-2", product: "Starlink", client: "Acme", invoice: "86052", movement: "Sale", batchId: "BATCH-1" },
  ]

  it("keeps a dispatch as one row, including a single serial", () => {
    expect(dispatchRowsForBatch(sale, "")).toEqual(["batch"])
    expect(dispatchRowsForBatch(sale, null)).toEqual(["batch"])
    expect(dispatchRowsForBatch([sale[0]!], "")).toEqual(["batch"])
  })

  it("stays grouped when the needle hits a batch field, even if a serial also matches", () => {
    for (const needle of ["starlink", "acme", "86052", "sale", "batch-1"]) {
      expect(dispatchRowsForBatch(sale, needle)).toEqual(["batch"])
    }
    expect(dispatchRowsForBatch([{ ...sale[0]!, serial: "ACME-1" }, sale[1]!], "acme")).toEqual(["batch"])
  })

  it("returns matching serials when nothing else in the dispatch matches", () => {
    expect(dispatchRowsForBatch(sale, "KIT-1")).toEqual(["serial"])
    expect(dispatchRowsForBatch(sale, "kit")).toEqual(["serial", "serial"])
    expect(dispatchRowsForBatch(sale, "missing")).toEqual([])
  })
})

describe("dispatchResultLabel", () => {
  it("names the row grain", () => {
    expect(dispatchResultLabel(1262, "batch")).toBe("1,262 dispatches")
    expect(dispatchResultLabel(1, "batch")).toBe("1 dispatch")
    expect(dispatchResultLabel(2, "serial")).toBe("2 serials")
    expect(dispatchResultLabel(3, "mixed")).toBe("3 results")
  })
})

describe("pageCount", () => {
  it("pages the SQL total", () => {
    expect(pageCount(855, 24)).toBe(36)
    expect(pageCount(24, 24)).toBe(1)
    expect(pageCount(0, 24)).toBe(1)
  })
})

describe("reversalAffordances", () => {
  const roles: Array<AppRole | null> = [...ROLES, null]

  it("shows Reverse and Export only to admins, and hides Reverse once a batch is reversed", () => {
    for (const role of roles) {
      const open = reversalAffordances({
        role,
        isReversed: false,
        movementType: "Sale",
        reverseBatchId: "BATCH-1",
      })
      const reversed = reversalAffordances({
        role,
        isReversed: true,
        movementType: "Sale",
        reverseBatchId: "BATCH-1",
        reversedByBatchId: "BATCH-REV-1",
      })
      expect(open.showReverse).toBe(role === "admin")
      expect(open.showRestore).toBe(false)
      expect(open.showExport).toBe(role === "admin")
      expect(reversed.showReverse).toBe(false)
      expect(reversed.showRestore).toBe(role === "admin")
      expect(reversed.showReversedPill).toBe(true)
      expect(reversed.linksToBatchId).toBe("BATCH-REV-1")
    }
  })

  it("links a reversal row back to the batch it undid", () => {
    const affordance = reversalAffordances({
      role: "viewer",
      isReversed: false,
      movementType: "Reversal",
      reverseBatchId: null,
      reversesBatchId: "BATCH-1",
    })
    expect(affordance.showReverse).toBe(false)
    expect(affordance.showRestore).toBe(false)
    expect(affordance.showReversedPill).toBe(false)
    expect(affordance.showExport).toBe(false)
    expect(affordance.linksToBatchId).toBe("BATCH-1")
  })

  it("offers Reverse for every movement except a Reversal", () => {
    expect(
      reversalAffordances({
        role: "admin",
        isReversed: false,
        movementType: "POC Return",
        reverseBatchId: "BATCH-1",
      }).showReverse
    ).toBe(true)
    expect(
      reversalAffordances({
        role: "admin",
        isReversed: false,
        movementType: "Reversal",
        reverseBatchId: "BATCH-REV-1",
      }).showReverse
    ).toBe(false)
  })
})
