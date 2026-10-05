import { describe, expect, it } from "vitest"
import {
  canAccessReports,
  canAccessRequests,
  canAmendTransaction,
  canCreateStockRequest,
  canChangeStockPool,
  canCompleteInspection,
  canEditInventory,
  canManageUsers,
  canRecordStockMovement,
  type AppRole,
} from "@/lib/permissions"

const ROLES: Array<AppRole | null> = ["admin", "sales", "accounts", "technicians", "viewer", null]

describe("canRecordStockMovement", () => {
  it.each([
    ["admin", true],
    ["technicians", true],
    ["sales", false],
    ["accounts", false],
    ["viewer", false],
    [null, false],
  ] as const)("role %s → %s", (role, expected) => {
    expect(canRecordStockMovement(role)).toBe(expected)
  })
})

describe("canEditInventory", () => {
  it.each([
    ["admin", true],
    ["technicians", false],
    ["sales", false],
    ["accounts", false],
    ["viewer", false],
    [null, false],
  ] as const)("role %s → %s", (role, expected) => {
    expect(canEditInventory(role)).toBe(expected)
  })
})

describe("canChangeStockPool", () => {
  it.each([
    ["admin", true],
    ["technicians", false],
    ["sales", false],
    ["accounts", false],
    ["viewer", false],
    [null, false],
  ] as const)("role %s → %s", (role, expected) => {
    expect(canChangeStockPool(role)).toBe(expected)
  })
})

describe("canAmendTransaction", () => {
  const uid = "user-1"
  const other = "user-2"

  it("admin is always true regardless of createdBy", () => {
    expect(canAmendTransaction("admin", uid, uid)).toBe(true)
    expect(canAmendTransaction("admin", other, uid)).toBe(true)
    expect(canAmendTransaction("admin", null, uid)).toBe(true)
    expect(canAmendTransaction("admin", uid, null)).toBe(true)
  })

  it("technician is true only when createdBy === currentUserId", () => {
    expect(canAmendTransaction("technicians", uid, uid)).toBe(true)
    expect(canAmendTransaction("technicians", other, uid)).toBe(false)
  })

  it("technician is false when createdBy is null", () => {
    expect(canAmendTransaction("technicians", null, uid)).toBe(false)
    expect(canAmendTransaction("technicians", undefined, uid)).toBe(false)
  })

  it("sales, accounts, and viewer are false regardless of createdBy", () => {
    for (const role of ["sales", "accounts", "viewer"] as const) {
      expect(canAmendTransaction(role, uid, uid)).toBe(false)
      expect(canAmendTransaction(role, other, uid)).toBe(false)
      expect(canAmendTransaction(role, null, uid)).toBe(false)
    }
  })

  it("null role is false", () => {
    expect(canAmendTransaction(null, uid, uid)).toBe(false)
  })

  it("covers all roles plus null in a matrix snapshot", () => {
    const matrix = ROLES.map((role) => ({
      role,
      own: canAmendTransaction(role, uid, uid),
      other: canAmendTransaction(role, other, uid),
      nullCreator: canAmendTransaction(role, null, uid),
    }))
    expect(matrix).toEqual([
      { role: "admin", own: true, other: true, nullCreator: true },
      { role: "sales", own: false, other: false, nullCreator: false },
      { role: "accounts", own: false, other: false, nullCreator: false },
      { role: "technicians", own: true, other: false, nullCreator: false },
      { role: "viewer", own: false, other: false, nullCreator: false },
      { role: null, own: false, other: false, nullCreator: false },
    ])
  })
})

describe("canCompleteInspection", () => {
  it.each([
    ["admin", true],
    ["technicians", false],
    ["sales", false],
    ["accounts", false],
    ["viewer", false],
    [null, false],
  ] as const)("role %s → %s", (role, expected) => {
    expect(canCompleteInspection(role)).toBe(expected)
  })
})

describe("viewer permissions", () => {
  it("can read requests and reports but cannot use write capabilities", () => {
    expect(canAccessRequests("viewer")).toBe(true)
    expect(canAccessReports("viewer")).toBe(true)
    expect(canCreateStockRequest("viewer")).toBe(false)
    expect(canRecordStockMovement("viewer")).toBe(false)
    expect(canEditInventory("viewer")).toBe(false)
    expect(canManageUsers("viewer")).toBe(false)
  })
})
