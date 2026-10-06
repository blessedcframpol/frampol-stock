import { describe, expect, it } from "vitest"
import {
  allowedTransitions,
  type StockRequestStatus,
} from "@/lib/stock-request-statuses"
import type { AppRole } from "@/lib/permissions"

const STATUSES: StockRequestStatus[] = [
  "draft",
  "submitted",
  "in_progress",
  "serviced",
  "invoiced",
  "cancelled",
]

const ROLES: Array<AppRole | null> = [
  "admin",
  "sales",
  "accounts",
  "technicians",
  "viewer",
  null,
]

/** Expected transitions matching migration 049 + STOCK_REQUEST_TRANSITIONS. */
function expected(
  status: StockRequestStatus,
  role: AppRole | null,
  isOwner: boolean
): StockRequestStatus[] {
  // owner_or_admin: admin always; ownership only for creator roles (not accounts).
  const ownerOrAdmin =
    role === "admin" ||
    (isOwner === true && (role === "sales" || role === "technicians"))
  const adminOrTech = role === "admin" || role === "technicians"
  const adminOrAccounts = role === "admin" || role === "accounts"

  switch (status) {
    case "draft":
      return ownerOrAdmin ? ["submitted", "cancelled"] : []
    case "submitted": {
      const out: StockRequestStatus[] = []
      if (ownerOrAdmin) out.push("draft")
      if (adminOrTech) out.push("in_progress", "serviced")
      if (ownerOrAdmin) out.push("cancelled")
      return out
    }
    case "in_progress":
      return adminOrTech ? ["serviced", "cancelled"] : []
    case "serviced": {
      const out: StockRequestStatus[] = []
      if (adminOrTech) out.push("in_progress")
      if (adminOrAccounts) out.push("invoiced")
      return out
    }
    case "invoiced":
    case "cancelled":
      return []
  }
}

describe("allowedTransitions", () => {
  for (const status of STATUSES) {
    for (const role of ROLES) {
      for (const isOwner of [true, false]) {
        const label = `${status} / role=${role ?? "null"} / isOwner=${isOwner}`
        it(label, () => {
          expect(allowedTransitions(status, role, isOwner)).toEqual(
            expected(status, role, isOwner)
          )
        })
      }
    }
  }

  it("invoiced returns [] for every role and ownership", () => {
    for (const role of ROLES) {
      for (const isOwner of [true, false]) {
        expect(allowedTransitions("invoiced", role, isOwner)).toEqual([])
      }
    }
  })

  it("cancelled returns [] for every role and ownership", () => {
    for (const role of ROLES) {
      for (const isOwner of [true, false]) {
        expect(allowedTransitions("cancelled", role, isOwner)).toEqual([])
      }
    }
  })

  it("serviced -> in_progress is offered to admin and technicians", () => {
    expect(allowedTransitions("serviced", "admin", false)).toContain("in_progress")
    expect(allowedTransitions("serviced", "technicians", false)).toContain("in_progress")
    expect(allowedTransitions("serviced", "sales", true)).not.toContain("in_progress")
    expect(allowedTransitions("serviced", "accounts", true)).not.toContain("in_progress")
  })

  it("in_progress -> submitted is offered to NOBODY", () => {
    for (const role of ROLES) {
      for (const isOwner of [true, false]) {
        expect(allowedTransitions("in_progress", role, isOwner)).not.toContain("submitted")
      }
    }
  })
})
