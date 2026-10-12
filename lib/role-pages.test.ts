import { describe, expect, it } from "vitest"
import type { AppRole } from "@/lib/permissions"
import {
  ROLE_LANDING,
  ROLE_MENU,
  roleCanAccessPath,
  roleLandingPath,
  roleMenuItems,
  roleRedirectAfterSignIn,
  roleRedirectForPath,
} from "@/lib/role-pages"

const ROLES: AppRole[] = ["admin", "sales", "accounts", "technicians", "viewer"]

describe("roleLandingPath", () => {
  it.each([
    ["sales", "/requests"],
    ["technicians", "/requests"],
    ["admin", "/"],
    ["accounts", "/invoices"],
    ["viewer", "/"],
    [null, "/pending-role"],
  ] as const)("role %s → %s", (role, path) => {
    expect(roleLandingPath(role)).toBe(path)
  })
})

describe("ROLE_MENU labels", () => {
  it("sales and technicians share requester menu labels", () => {
    const labels = (r: AppRole) => ROLE_MENU[r].map((i) => i.label)
    expect(labels("sales")).toEqual([
      "My requests",
      "New request",
      "Stock",
      "Notifications",
      "Report a problem",
    ])
    expect(labels("technicians")).toEqual(labels("sales"))
  })

  it("accounts menu", () => {
    expect(ROLE_MENU.accounts.map((i) => i.label)).toEqual([
      "Invoices",
      "Requests",
      "Notifications",
      "Report a problem",
    ])
  })

  it("admin and viewer include Dashboard and Inventory", () => {
    for (const role of ["admin", "viewer"] as const) {
      const labels = ROLE_MENU[role].map((i) => i.label)
      expect(labels).toContain("Dashboard")
      expect(labels).toContain("Inventory")
      expect(labels).toContain("Report a problem")
    }
  })
})

describe("roleCanAccessPath / redirects", () => {
  it.each(ROLES)("%s can open its landing page", (role) => {
    expect(roleCanAccessPath(role, ROLE_LANDING[role])).toBe(true)
    expect(roleRedirectForPath(role, ROLE_LANDING[role])).toBeNull()
  })

  it("sales forbidden pages redirect to My requests", () => {
    expect(roleCanAccessPath("sales", "/inventory")).toBe(false)
    expect(roleRedirectForPath("sales", "/inventory")).toBe("/requests")
    expect(roleRedirectForPath("sales", "/transaction-history")).toBe("/requests")
    expect(roleRedirectForPath("sales", "/")).toBe("/requests")
  })

  it("accounts forbidden pages redirect to Invoices", () => {
    expect(roleRedirectForPath("accounts", "/inventory")).toBe("/invoices")
    expect(roleRedirectForPath("accounts", "/")).toBe("/invoices")
    expect(roleCanAccessPath("accounts", "/requests")).toBe(true)
  })

  it("technicians can open stock and new request", () => {
    expect(roleCanAccessPath("technicians", "/stock")).toBe(true)
    expect(roleCanAccessPath("technicians", "/requests/new")).toBe(true)
  })

  it("menu items from roleMenuItems match ROLE_MENU", () => {
    expect(roleMenuItems("sales")).toEqual(ROLE_MENU.sales)
  })
})

describe("roleRedirectAfterSignIn", () => {
  it("keeps an allowed deep link", () => {
    expect(roleRedirectAfterSignIn("sales", "/requests/abc")).toBe("/requests/abc")
    expect(roleRedirectAfterSignIn("admin", "/inventory?x=1")).toBe("/inventory?x=1")
  })

  it("falls back to landing when the role may not open the page", () => {
    expect(roleRedirectAfterSignIn("sales", "/inventory")).toBe("/requests")
    expect(roleRedirectAfterSignIn("accounts", "/")).toBe("/invoices")
  })

  it("rejects unsafe or auth redirects", () => {
    expect(roleRedirectAfterSignIn("admin", "//evil.example")).toBe("/")
    expect(roleRedirectAfterSignIn("admin", "https://evil.example")).toBe("/")
    expect(roleRedirectAfterSignIn("admin", "/login")).toBe("/")
    expect(roleRedirectAfterSignIn("sales", null)).toBe("/requests")
  })
})
