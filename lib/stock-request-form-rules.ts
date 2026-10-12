/**
 * Client-side mirror of the checks in public.stock_request_fields_problem and
 * public.stock_request_lines_problem. The server stays the authority; these only
 * give feedback while the form is being filled in.
 */

export { atlasTaskUrlProblem, ATLAS_TASK_URL_EXAMPLE, ATLAS_TASK_LINK_HINT } from "@/lib/atlas-task-url"

export const REQUEST_TYPES = ["Sale", "POC Out", "Rentals"] as const
export type RequestType = (typeof REQUEST_TYPES)[number]

export function requestTypeNeedsReturnDate(type: string): boolean {
  return type === "POC Out" || type === "Rentals"
}

/** `today` and `returnDate` are YYYY-MM-DD business dates. */
export function returnDateProblem(type: string, returnDate: string, today: string): string | null {
  if (!requestTypeNeedsReturnDate(type)) return null
  if (!returnDate) return `${type} needs a return date`
  if (returnDate <= today) return "Return date must be after today"
  return null
}

export type FormLine = {
  productId: string
  productName: string
  vendor: string | null
  quantity: number
}

function isFortinet(vendor: string | null | undefined): boolean {
  return (vendor ?? "").trim().toLowerCase() === "fortinet"
}

/** First problem found in the lines, or null. */
export function requestLinesProblem(type: string, lines: FormLine[]): string | null {
  const filled = lines.filter((l) => l.productId)
  if (filled.length === 0) return "Add at least one product line"
  if (lines.some((l) => !l.productId)) return "Each line needs a product"
  if (lines.some((l) => !Number.isInteger(l.quantity) || l.quantity < 1)) {
    return "Each line needs a whole quantity of at least 1"
  }
  const seen = new Set<string>()
  for (const line of lines) {
    if (seen.has(line.productId)) return "A product appears on more than one line"
    seen.add(line.productId)
  }
  if (type === "Rentals" && lines.some((l) => (l.vendor ?? "").trim() !== "Starlink")) {
    return "Rentals is only for Starlink kits"
  }
  const fortinet = lines.filter((l) => isFortinet(l.vendor)).length
  if (fortinet > 0 && fortinet < lines.length) {
    return "A request must be all Fortinet lines or no Fortinet lines — do not mix them"
  }
  return null
}

/** Internal 00000 requests are filed against the internal client by the server. */
export function clientIsAutomatic(invoiceChoice: string, kind: string): boolean {
  return invoiceChoice === "not_invoiced" && kind === "internal"
}
