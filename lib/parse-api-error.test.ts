import { describe, expect, it } from "vitest"
import { humanizeStockDbError } from "@/lib/parse-api-error"

describe("humanizeStockDbError", () => {
  it("maps 42501 RLS on transactions to the session-retry copy", () => {
    expect(
      humanizeStockDbError({
        code: "42501",
        message: 'new row violates row-level security policy for table "transactions"',
      })
    ).toBe(
      "Could not record movement — your session could not be verified. Sign out and back in, then retry."
    )
  })

  it("maps 42501 RLS on inventory_items to the inventory permission copy", () => {
    expect(
      humanizeStockDbError({
        code: "42501",
        message: 'new row violates row-level security policy for table "inventory_items"',
      })
    ).toBe("You do not have permission to change inventory.")
  })

  it("maps 23514 on transactions_date_iso_utc to the sale-date copy", () => {
    expect(
      humanizeStockDbError({
        code: "23514",
        message: 'new row for relation "transactions" violates check constraint "transactions_date_iso_utc"',
      })
    ).toBe("Sale date must be a valid calendar date (YYYY-MM-DD) between 2020 and 2100.")
  })

  it("maps message mentioning transactions_date_iso_utc without code", () => {
    expect(
      humanizeStockDbError({
        message: "transactions_date_iso_utc check failed",
      })
    ).toBe("Sale date must be a valid calendar date (YYYY-MM-DD) between 2020 and 2100.")
  })

  it("maps Invalid stock request transition P0001", () => {
    expect(
      humanizeStockDbError({
        code: "P0001",
        message: "Invalid stock request transition: draft -> invoiced (role sales)",
      })
    ).toBe("This request has already moved to a different status. Refresh and try again.")
  })

  it("maps Cannot mark serviced", () => {
    expect(
      humanizeStockDbError({
        code: "P0001",
        message: "Cannot mark serviced: serial-tracked lines need all serials assigned",
      })
    ).toBe("Assign all required serial numbers before marking this request serviced.")
  })

  it("maps ensure_product_line vendor conflict", () => {
    expect(
      humanizeStockDbError({
        code: "P0001",
        message: 'ensure_product_line: product "Widget" already exists under vendor "Acme" (cannot use vendor "General")',
      })
    ).toBe(
      "That product name already exists in the catalog. Choose it from the list instead of adding it as new."
    )
  })

  it("unknown errors fall through to null rather than throwing", () => {
    expect(() =>
      humanizeStockDbError({ code: "XX000", message: "something obscure from postgres" })
    ).not.toThrow()
    expect(
      humanizeStockDbError({ code: "XX000", message: "something obscure from postgres" })
    ).toBeNull()
  })

  it("empty / missing message with no code returns null", () => {
    expect(humanizeStockDbError(null)).toBeNull()
    expect(humanizeStockDbError({ message: "" })).toBeNull()
  })
})
