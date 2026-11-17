import { describe, expect, it } from "vitest"
import {
  clientContactEmailProblem,
  clientContactFieldErrors,
  clientContactNameProblem,
  clientContactPhoneProblem,
  formatBuyerHeader,
  formatClientContactLabel,
  normalizeClientContactForDb,
} from "./client-contacts"

describe("client contacts validation", () => {
  it("requires name and email or phone", () => {
    expect(clientContactNameProblem("")).toMatch(/required/i)
    expect(clientContactFieldErrors({ name: "Ada", role: "buyer", email: "", phone: "" })).toBeTruthy()
    expect(clientContactFieldErrors({ name: "Ada", role: "buyer", email: "ada@ex.com", phone: "" })).toBeNull()
    expect(clientContactFieldErrors({ name: "Ada", role: "buyer", email: "", phone: "0771234567" })).toBeNull()
  })

  it("rejects multi-address and placeholder email", () => {
    expect(clientContactEmailProblem("a@ex.com; b@ex.com")).toMatch(/single/i)
    expect(clientContactEmailProblem("N/A")).toMatch(/placeholder/i)
  })

  it("normalises phone like NC1", () => {
    expect(clientContactPhoneProblem("N/A")).toMatch(/placeholder/i)
    const row = normalizeClientContactForDb({
      name: "Ada Lovelace",
      role: "buyer",
      email: "Ada@Ex.COM",
      phone: "0771234567",
    })
    expect(row.email).toBe("ada@ex.com")
    expect(row.phone).toBe("+263771234567")
  })

  it("formats buyer header without repeating role", () => {
    expect(
      formatBuyerHeader({ name: "Ada", email: "ada@ex.com", phone: "+263771234567" }),
    ).toBe("Buyer: Ada · ada@ex.com")
    expect(
      formatBuyerHeader({ name: "Ada", email: null, phone: null, active: false }),
    ).toBe("Buyer: Ada (archived)")
  })

  it("labels contacts and skips buyer role chip", () => {
    expect(
      formatClientContactLabel({
        name: "Ada",
        role: "buyer",
        email: "ada@ex.com",
      }),
    ).toBe("Ada · ada@ex.com")
    expect(
      formatClientContactLabel({
        name: "Bob",
        role: "collector",
        email: "bob@ex.com",
        active: false,
      }),
    ).toBe("Bob (archived) · Collector · bob@ex.com")
  })
})
