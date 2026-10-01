import { describe, expect, it } from "vitest"
import { collapseClientLabel, formatClientLabel } from "./client-label"

describe("formatClientLabel", () => {
  it("shows the name once when company equals the name", () => {
    expect(formatClientLabel({ name: "Nikki Blythe-Wood", company: "Nikki Blythe-Wood" })).toBe(
      "Nikki Blythe-Wood",
    )
  })

  it("joins a different company", () => {
    expect(formatClientLabel({ name: "DC Coetzee", company: "Therapy Worx" })).toBe(
      "DC Coetzee - Therapy Worx",
    )
  })

  it("shows the name when company is missing", () => {
    expect(formatClientLabel({ name: "Glenrise Investments", company: "" })).toBe("Glenrise Investments")
    expect(formatClientLabel({ name: "Glenrise Investments", company: null })).toBe("Glenrise Investments")
    expect(formatClientLabel({ name: "Glenrise Investments" })).toBe("Glenrise Investments")
  })

  it("ignores surrounding whitespace and case when deciding they match", () => {
    expect(formatClientLabel({ name: "  Nikki Blythe-Wood ", company: " nikki blythe-wood" })).toBe(
      "Nikki Blythe-Wood",
    )
  })
})

describe("collapseClientLabel", () => {
  it("collapses a stored duplicate and leaves a real company", () => {
    expect(collapseClientLabel("Nikki Blythe-Wood - Nikki Blythe-Wood")).toBe("Nikki Blythe-Wood")
    expect(collapseClientLabel("DC Coetzee - Therapy Worx")).toBe("DC Coetzee - Therapy Worx")
  })
})
