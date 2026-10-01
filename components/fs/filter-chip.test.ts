import { describe, expect, it } from "vitest"
import {
  clearAllCount,
  clearAllLabel,
  filterChipCountText,
  type FilterChipModel,
} from "@/components/fs/filter-chip"

const chips: FilterChipModel[] = [
  { id: "sale", label: "Sale", count: 12 },
  { id: "poc", label: "POC", count: 3 },
  { id: "open", label: "Open" },
]

describe("filter chip counts", () => {
  it("prints each chip's own count and omits a missing one", () => {
    expect(filterChipCountText(12)).toBe("12")
    expect(filterChipCountText(0)).toBe("0")
    expect(filterChipCountText(undefined)).toBeNull()
  })

  it("counts chips for Clear all, not the sum of their result counts", () => {
    expect(clearAllCount(chips)).toBe(3)
    expect(clearAllLabel(chips)).toBe("Clear all (3)")
    expect(clearAllCount([])).toBe(0)
    expect(clearAllLabel([])).toBe("Clear all (0)")
  })
})