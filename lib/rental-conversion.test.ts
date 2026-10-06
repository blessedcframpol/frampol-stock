import { describe, expect, it } from "vitest"
import {
  inclusiveRentalDays,
  rentalConversionLabel,
  rentalConversionProblem,
  rentalDaysFromMetadata,
} from "@/lib/rental-conversion"

describe("rental conversion", () => {
  it("counts the start and end dates", () => {
    expect(inclusiveRentalDays("2026-10-01", "2026-10-03")).toBe(3)
    expect(inclusiveRentalDays("2026-10-05", "2026-10-05")).toBe(1)
  })

  it("rejects an end outside the rental, and a sale before that end", () => {
    expect(
      rentalConversionProblem({
        rentalStart: "2026-10-01",
        rentalEnd: "2026-09-30",
        saleDate: "2026-10-01",
        today: "2026-10-05",
      }),
    ).toMatch(/between the rental start and today/)
    expect(
      rentalConversionProblem({
        rentalStart: "2026-10-01",
        rentalEnd: "2026-10-06",
        saleDate: "2026-10-06",
        today: "2026-10-05",
      }),
    ).toMatch(/between the rental start and today/)
    expect(
      rentalConversionProblem({
        rentalStart: "2026-10-01",
        rentalEnd: "2026-10-03",
        saleDate: "2026-10-02",
        today: "2026-10-05",
      }),
    ).toMatch(/before the rental end/)
    expect(
      rentalConversionProblem({
        rentalStart: "2026-10-01",
        rentalEnd: "2026-10-03",
        saleDate: "2026-10-03",
        today: "2026-10-05",
      }),
    ).toBeNull()
  })

  it("reads the period the way history and the drawer show it", () => {
    const metadata = { converted_from: "Rentals", rental_start: "2026-10-01", rental_end: "2026-10-03", rental_days: 3 }
    expect(rentalDaysFromMetadata(metadata)).toBe(3)
    expect(rentalConversionLabel(metadata, "2026-10-03")).toBe(
      "Rented from 01/10/2026 to 03/10/2026 (3 days), then sold on 03/10/2026",
    )
  })
})
