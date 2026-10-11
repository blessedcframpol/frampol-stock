import { describe, expect, it } from "vitest"
import {
  atlasTaskUrlProblem,
  clientIsAutomatic,
  requestLinesProblem,
  returnDateProblem,
  type FormLine,
} from "@/lib/stock-request-form-rules"

const UUID_A = "0b9f4c1e-3c52-4e0a-9d0a-1f4c2b7a8e11"
const UUID_B = "9a7d2f10-55aa-4b13-8c77-2e6f0d1c3b22"
const GOOD = `https://ai.frampolafrica.com:10801/projects/${UUID_A}?task=${UUID_B}`

const line = (over: Partial<FormLine> = {}): FormLine => ({
  productId: "p1",
  productName: "Starlink Standard",
  vendor: "Starlink",
  quantity: 1,
  ...over,
})

describe("atlasTaskUrlProblem", () => {
  it("accepts the canonical link", () => {
    expect(atlasTaskUrlProblem(GOOD)).toBeNull()
    expect(atlasTaskUrlProblem(`  ${GOOD}  `)).toBeNull()
  })

  it("requires a value and the exact shape", () => {
    expect(atlasTaskUrlProblem("")).toBe("Atlas task link is required")
    expect(atlasTaskUrlProblem("https://example.com")).toMatch(/must look like/)
    expect(atlasTaskUrlProblem(GOOD.replace("https", "http"))).toMatch(/must look like/)
    expect(atlasTaskUrlProblem(`${GOOD}&x=1`)).toMatch(/must look like/)
    expect(atlasTaskUrlProblem(GOOD.replace(":10801", ""))).toMatch(/must look like/)
  })
})

describe("returnDateProblem", () => {
  it("is not needed for a Sale", () => {
    expect(returnDateProblem("Sale", "", "2026-10-11")).toBeNull()
  })

  it("is required and must be after today for POC Out and Rentals", () => {
    for (const type of ["POC Out", "Rentals"]) {
      expect(returnDateProblem(type, "", "2026-10-11")).toBe(`${type} needs a return date`)
      expect(returnDateProblem(type, "2026-10-11", "2026-10-11")).toBe("Return date must be after today")
      expect(returnDateProblem(type, "2026-10-12", "2026-10-11")).toBeNull()
    }
  })
})

describe("requestLinesProblem", () => {
  it("needs at least one line with a product and whole quantity", () => {
    expect(requestLinesProblem("Sale", [])).toBe("Add at least one product line")
    expect(requestLinesProblem("Sale", [line({ productId: "" })])).toBe("Add at least one product line")
    expect(requestLinesProblem("Sale", [line(), line({ productId: "" })])).toBe("Each line needs a product")
    expect(requestLinesProblem("Sale", [line({ quantity: 0 })])).toMatch(/whole quantity/)
    expect(requestLinesProblem("Sale", [line({ quantity: 1.5 })])).toMatch(/whole quantity/)
  })

  it("rejects the same product twice", () => {
    expect(requestLinesProblem("Sale", [line(), line()])).toBe("A product appears on more than one line")
  })

  it("limits Rentals to Starlink", () => {
    expect(requestLinesProblem("Rentals", [line()])).toBeNull()
    expect(requestLinesProblem("Rentals", [line({ vendor: "Fortinet" })])).toBe("Rentals is only for Starlink kits")
  })

  it("does not mix Fortinet with other vendors", () => {
    const fortinet = line({ productId: "f1", vendor: "Fortinet" })
    const other = line({ productId: "s1", vendor: "Starlink" })
    expect(requestLinesProblem("Sale", [fortinet, line({ productId: "f2", vendor: "Fortinet" })])).toBeNull()
    expect(requestLinesProblem("Sale", [fortinet, other])).toMatch(/do not mix/)
  })
})

describe("clientIsAutomatic", () => {
  it("only for internal 00000", () => {
    expect(clientIsAutomatic("not_invoiced", "internal")).toBe(true)
    expect(clientIsAutomatic("not_invoiced", "complimentary")).toBe(false)
    expect(clientIsAutomatic("number", "internal")).toBe(false)
  })
})
