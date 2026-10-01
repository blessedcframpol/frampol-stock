import { describe, expect, it } from "vitest"
import { ROLES } from "@/lib/permissions"
import {
  alertChipCounts,
  alertChipFromSearch,
  canRecordReturn,
  formatReturnAge,
  groupReturnRows,
  prefillMovementType,
  recordReturnHref,
  sortReturnRows,
  type ReturnAlertRow,
} from "@/lib/alerts"

const TODAY = "2026-10-01"

function row(partial: Partial<ReturnAlertRow> & Pick<ReturnAlertRow, "id" | "holder" | "returnDate">): ReturnAlertRow {
  return {
    serialNumber: partial.serialNumber ?? partial.id,
    productId: partial.productId ?? "product",
    product: partial.product ?? "Kit",
    kind: partial.kind ?? "POC",
    ...partial,
  }
}

describe("alertChipFromSearch", () => {
  it("opens the low stock section from the dashboard card", () => {
    expect(alertChipFromSearch("lowStock")).toBe("lowStock")
    expect(alertChipFromSearch("nope")).toBe("all")
    expect(alertChipFromSearch(null)).toBe("all")
  })
})

describe("formatReturnAge", () => {
  it("says how many days overdue", () => {
    expect(formatReturnAge("2026-06-22", TODAY)).toBe("101 days overdue")
    expect(formatReturnAge("2026-09-30", TODAY)).toBe("1 day overdue")
  })

  it("says how soon a return is due", () => {
    expect(formatReturnAge("2026-10-07", TODAY)).toBe("due in 6 days")
    expect(formatReturnAge("2026-10-02", TODAY)).toBe("due in 1 day")
    expect(formatReturnAge("2026-10-01", TODAY)).toBe("due today")
  })
})

describe("groupReturnRows", () => {
  it("groups a holder's units that share a return date", () => {
    const joseph = ["KIT-1", "KIT-2", "KIT-3"].map((serial, index) =>
      row({
        id: `j${index}`,
        serialNumber: serial,
        holder: "Joseph Shenjere",
        returnDate: "2026-06-22",
        kind: "POC",
      })
    )
    const other = row({
      id: "other",
      holder: "Anna Dhlamini",
      returnDate: "2026-06-22",
      kind: "POC",
    })
    const later = row({
      id: "later",
      holder: "Joseph Shenjere",
      returnDate: "2026-07-01",
      kind: "POC",
    })
    const groups = groupReturnRows(sortReturnRows([...joseph, other, later], TODAY))
    const shenjere = groups.find((group) => group.holder === "Joseph Shenjere" && group.rows.length === 3)
    expect(shenjere?.rows.map((item) => item.serialNumber)).toEqual(["KIT-1", "KIT-2", "KIT-3"])
    expect(groups.filter((group) => group.holder === "Joseph Shenjere")).toHaveLength(2)
    expect(groups.find((group) => group.holder === "Anna Dhlamini")?.rows).toHaveLength(1)
  })
})

describe("alertChipCounts", () => {
  it("sums overdue, due soon, and low stock into All, and POC plus rental into the return units", () => {
    const counts = alertChipCounts({
      overduePoc: 9,
      overdueRental: 14,
      dueSoonPoc: 0,
      dueSoonRental: 0,
      lowStock: 20,
      internal: 2,
    })
    expect(counts.overdue).toBe(23)
    expect(counts.dueSoon).toBe(0)
    expect(counts.poc).toBe(9)
    expect(counts.rental).toBe(14)
    expect(counts.all).toBe(43)
    expect(counts.overdue + counts.dueSoon + counts.lowStock).toBe(counts.all)
    expect(counts.poc + counts.rental).toBe(counts.overdue + counts.dueSoon)
    expect(counts.internal).toBe(2)
  })
})

describe("record return", () => {
  it("prefills Inventory movement with the return type and serials", () => {
    expect(recordReturnHref("POC", ["KIT-1", "KIT-2"])).toBe(
      "/inventory/movement?type=POC+Return&serials=KIT-1%2CKIT-2"
    )
    expect(recordReturnHref("Rental", ["KIT-9"])).toBe(
      "/inventory/movement?type=Rental+Return&serials=KIT-9"
    )
    expect(prefillMovementType("POC Return")).toBe("POC Return")
    expect(prefillMovementType("Rental Return")).toBe("Rental Return")
    expect(prefillMovementType("Sale")).toBeNull()
  })

  it("follows the stock-movement role gate for every role", () => {
    const allowed = new Set(["admin", "technicians"])
    for (const role of ROLES) {
      expect(canRecordReturn(role)).toBe(allowed.has(role))
    }
    expect(canRecordReturn(null)).toBe(false)
  })
})
