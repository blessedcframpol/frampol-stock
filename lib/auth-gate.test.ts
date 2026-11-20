import { describe, expect, it } from "vitest"
import { decideAuthGate, isPublicPath } from "@/lib/auth-gate"

describe("isPublicPath", () => {
  it("allows NT3 public paths and login/callback", () => {
    expect(isPublicPath("/login")).toBe(true)
    expect(isPublicPath("/auth/callback")).toBe(true)
    expect(isPublicPath("/auth/callback/exchange")).toBe(true)
    expect(isPublicPath("/api/push/send")).toBe(true)
    expect(isPublicPath("/sw.js")).toBe(true)
    expect(isPublicPath("/manifest.webmanifest")).toBe(true)
  })

  it("does not treat other API routes as public", () => {
    expect(isPublicPath("/api/admin/profiles")).toBe(false)
    expect(isPublicPath("/api/stock-takes")).toBe(false)
    expect(isPublicPath("/requests")).toBe(false)
  })
})

describe("decideAuthGate", () => {
  it("allows public paths without a user", () => {
    expect(decideAuthGate("/api/push/send", false)).toEqual({ kind: "allow" })
    expect(decideAuthGate("/login", false)).toEqual({ kind: "allow" })
  })

  it("returns 401 JSON decision for /api/* without a session", () => {
    expect(decideAuthGate("/api/admin/profiles", false)).toEqual({ kind: "api_unauthorized" })
    expect(decideAuthGate("/api/stock-takes", false)).toEqual({ kind: "api_unauthorized" })
  })

  it("redirects pages to login without a session", () => {
    expect(decideAuthGate("/requests", false)).toEqual({
      kind: "redirect_login",
      redirectTo: "/requests",
    })
    expect(decideAuthGate("/", false)).toEqual({
      kind: "redirect_login",
      redirectTo: "/",
    })
  })

  it("allows authenticated users on pages and APIs", () => {
    expect(decideAuthGate("/api/admin/profiles", true)).toEqual({ kind: "allow" })
    expect(decideAuthGate("/requests", true)).toEqual({ kind: "allow" })
  })
})
