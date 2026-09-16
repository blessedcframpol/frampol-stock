import { describe, expect, it } from "vitest"
import {
  isAuthFailure,
  isUnauthorizedStatus,
  loadErrorFromCaught,
  SESSION_EXPIRED_MESSAGE,
} from "@/lib/unauthorized"

describe("isUnauthorizedStatus", () => {
  it("is true only for 401", () => {
    expect(isUnauthorizedStatus(401)).toBe(true)
    expect(isUnauthorizedStatus(403)).toBe(false)
    expect(isUnauthorizedStatus(200)).toBe(false)
    expect(isUnauthorizedStatus(500)).toBe(false)
  })
})

describe("SESSION_EXPIRED_MESSAGE", () => {
  it("is the user-facing copy with no request id", () => {
    expect(SESSION_EXPIRED_MESSAGE).toBe("Your session has expired. Please sign in again.")
  })
})

describe("isAuthFailure", () => {
  it("is true for JWT / session errors from supabase-js", () => {
    expect(isAuthFailure({ status: 401 })).toBe(true)
    expect(isAuthFailure({ code: "PGRST301", message: "JWT expired" })).toBe(true)
    expect(isAuthFailure({ code: "401" })).toBe(true)
    expect(isAuthFailure({ name: "AuthSessionMissingError", message: "Auth session missing!" })).toBe(
      true
    )
    expect(isAuthFailure({ message: "invalid JWT" })).toBe(true)
  })

  it("is false for ordinary query failures", () => {
    expect(isAuthFailure({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" })).toBe(
      false
    )
    expect(isAuthFailure({ code: "42501", message: "new row violates row-level security policy" })).toBe(
      false
    )
    expect(isAuthFailure(new Error("Could not load request"))).toBe(false)
    expect(isAuthFailure(null)).toBe(false)
  })
})

describe("loadErrorFromCaught", () => {
  it("uses the session message for auth failures and the fallback otherwise", () => {
    expect(loadErrorFromCaught({ status: 401 }, "Could not load this request.")).toBe(
      SESSION_EXPIRED_MESSAGE
    )
    expect(loadErrorFromCaught(new Error("network"), "Could not load this request.")).toBe(
      "Could not load this request."
    )
  })
})
