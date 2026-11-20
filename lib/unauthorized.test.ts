import { describe, expect, it } from "vitest"
import {
  classifyFailure,
  isAuthFailure,
  isNetworkFailure,
  isUnauthorizedStatus,
  loadErrorFromCaught,
  NETWORK_UNAVAILABLE_MESSAGE,
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
      true,
    )
    expect(isAuthFailure({ message: "invalid JWT" })).toBe(true)
  })

  it("is false for ordinary query failures and network failures", () => {
    expect(isAuthFailure({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" })).toBe(
      false,
    )
    expect(isAuthFailure({ code: "42501", message: "new row violates row-level security policy" })).toBe(
      false,
    )
    expect(isAuthFailure(new Error("Could not load request"))).toBe(false)
    expect(isAuthFailure(new TypeError("Failed to fetch"))).toBe(false)
    expect(isAuthFailure(null)).toBe(false)
  })
})

describe("isNetworkFailure", () => {
  it("detects Failed to fetch / TypeError / offline / timeout / 5xx", () => {
    expect(isNetworkFailure(new TypeError("Failed to fetch"))).toBe(true)
    expect(isNetworkFailure({ name: "TypeError", message: "Failed to fetch" })).toBe(true)
    expect(isNetworkFailure({ name: "AbortError", message: "The operation was aborted" })).toBe(true)
    expect(isNetworkFailure({ message: "NetworkError when attempting to fetch resource." })).toBe(true)
    expect(isNetworkFailure({ message: "Load failed" })).toBe(true)
    expect(isNetworkFailure({ message: "timeout of 10000ms exceeded" })).toBe(true)
    expect(isNetworkFailure({ message: "navigator is offline" })).toBe(true)
    expect(isNetworkFailure({ status: 502, message: "Bad Gateway" })).toBe(true)
    expect(isNetworkFailure(503)).toBe(true)
    expect(isNetworkFailure("Failed to fetch")).toBe(true)
  })

  it("is false for auth and ordinary app errors", () => {
    expect(isNetworkFailure({ status: 401 })).toBe(false)
    expect(isNetworkFailure({ code: "PGRST301", message: "JWT expired" })).toBe(false)
    expect(isNetworkFailure(new Error("Could not load request"))).toBe(false)
    expect(isNetworkFailure({ status: 400, message: "bad request" })).toBe(false)
    expect(isNetworkFailure(null)).toBe(false)
  })
})

describe("classifyFailure / loadErrorFromCaught", () => {
  it("maps auth to session message", () => {
    expect(classifyFailure({ status: 401 }, "fallback")).toEqual({
      kind: "auth",
      message: SESSION_EXPIRED_MESSAGE,
    })
    expect(loadErrorFromCaught({ status: 401 }, "Could not load this request.")).toBe(
      SESSION_EXPIRED_MESSAGE,
    )
  })

  it("maps network to the connection copy (not session expired)", () => {
    expect(classifyFailure(new TypeError("Failed to fetch"), "fallback")).toEqual({
      kind: "network",
      message: NETWORK_UNAVAILABLE_MESSAGE,
    })
    expect(loadErrorFromCaught(new TypeError("Failed to fetch"), "Could not load this request.")).toBe(
      NETWORK_UNAVAILABLE_MESSAGE,
    )
    expect(loadErrorFromCaught({ status: 503 }, "Could not load this request.")).toBe(
      NETWORK_UNAVAILABLE_MESSAGE,
    )
  })

  it("uses the fallback for other errors", () => {
    expect(loadErrorFromCaught(new Error("network"), "Could not load this request.")).toBe(
      "Could not load this request.",
    )
    expect(classifyFailure(new Error("boom"), "Could not load this request.")).toEqual({
      kind: "other",
      message: "Could not load this request.",
    })
  })

  it("prefers auth over network when status is 401", () => {
    expect(classifyFailure({ status: 401, message: "Failed to fetch" }, "fallback").kind).toBe("auth")
  })
})
