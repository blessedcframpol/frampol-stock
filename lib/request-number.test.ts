import { describe, expect, it } from "vitest"
import { matchesRequestNumber } from "@/lib/request-number"

describe("matchesRequestNumber", () => {
  it("matches the full number and substrings", () => {
    expect(matchesRequestNumber("REQ-26-0042", "REQ-26-0042")).toBe(true)
    expect(matchesRequestNumber("REQ-26-0042", "req-26-0042")).toBe(true)
    expect(matchesRequestNumber("REQ-26-0042", "26-0042")).toBe(true)
  })

  it("matches trailing digits", () => {
    expect(matchesRequestNumber("REQ-26-0042", "42")).toBe(true)
    expect(matchesRequestNumber("REQ-26-0042", "0042")).toBe(true)
    expect(matchesRequestNumber("REQ-26-0001", "1")).toBe(true)
    expect(matchesRequestNumber("REQ-26-0001", "99")).toBe(false)
  })
})
