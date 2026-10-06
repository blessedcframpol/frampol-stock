import { describe, expect, it } from "vitest"
import {
  EMPTY,
  ageInDays,
  displayInitials,
  displayOrEmpty,
  formatAgeDays,
  formatCount,
  hundredTicks,
} from "@/lib/format-display"

describe("formatCount", () => {
  it("groups thousands with commas", () => {
    expect(formatCount(0)).toBe("0")
    expect(formatCount(17)).toBe("17")
    expect(formatCount(1262)).toBe("1,262")
    expect(formatCount(1850)).toBe("1,850")
  })
})

describe("displayOrEmpty", () => {
  it("uses the em dash for blanks", () => {
    expect(displayOrEmpty("")).toBe(EMPTY)
    expect(displayOrEmpty("  ")).toBe(EMPTY)
    expect(displayOrEmpty(null)).toBe(EMPTY)
    expect(displayOrEmpty("Borrowdale")).toBe("Borrowdale")
    expect(displayOrEmpty(1262)).toBe("1,262")
  })
})

describe("hundredTicks", () => {
  it("steps by 100 and always includes 0", () => {
    expect(hundredTicks(0)).toEqual({ domain: [0, 100], ticks: [0, 100] })
    expect(hundredTicks(17)).toEqual({ domain: [0, 100], ticks: [0, 100] })
    expect(hundredTicks(100)).toEqual({ domain: [0, 100], ticks: [0, 100] })
    expect(hundredTicks(406)).toEqual({ domain: [0, 500], ticks: [0, 100, 200, 300, 400, 500] })
  })
})

describe("age", () => {
  it("counts whole days and labels them", () => {
    expect(ageInDays("2026-06-20T12:00:00.000Z", "2026-10-06")).toBe(108)
    expect(formatAgeDays(108)).toBe("108 days")
    expect(formatAgeDays(1)).toBe("1 day")
    expect(formatAgeDays(0)).toBe("0 days")
  })
})

describe("displayInitials", () => {
  it("uses letter-starting words, then company, then ?", () => {
    expect(displayInitials("Blessed Chikosha")).toBe("BC")
    expect(displayInitials("Africa Albida Tourism")).toBe("AA")
    expect(displayInitials("000000000", "Prince Mubau")).toBe("PM")
    expect(displayInitials("-", "4th Street Shop")).toBe("SS")
    expect(displayInitials("-", "000")).toBe("?")
    expect(displayInitials("123", null, "dev4@frampolafrica.com")).toBe("D")
  })
})
