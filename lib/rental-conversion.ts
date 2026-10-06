import { formatBusinessDate } from "@/lib/business-date.mjs"

const DAY = /^\d{4}-\d{2}-\d{2}$/

export function inclusiveRentalDays(start: string, end: string): number | null {
  if (!DAY.test(start) || !DAY.test(end)) return null
  const from = Date.parse(`${start}T00:00:00.000Z`)
  const to = Date.parse(`${end}T00:00:00.000Z`)
  if (Number.isNaN(from) || Number.isNaN(to)) return null
  return Math.round((to - from) / 86400000) + 1
}

/** Same wording the server enforces. Dates are YYYY-MM-DD. */
export function rentalConversionProblem(input: {
  rentalStart?: string | null
  rentalEnd?: string | null
  saleDate?: string | null
  today: string
}): string | null {
  const start = input.rentalStart?.slice(0, 10) ?? ""
  const end = input.rentalEnd?.slice(0, 10) ?? ""
  const sale = input.saleDate?.slice(0, 10) ?? ""
  const today = input.today.slice(0, 10)
  if (!DAY.test(start)) return "Convert to sale needs the rental start"
  if (!DAY.test(end)) return "Rental end date is required"
  if (!DAY.test(sale)) return "Sale date must be a business-date midnight"
  if (end < start || end > today) return "Rental end date must be between the rental start and today"
  if (sale < end) return "Sale date cannot be before the rental end date"
  return null
}

export function latestRentalStart(
  transactions: readonly { type: string; serialNumber: string; date: string }[],
  serial: string,
): string | null {
  let best: string | null = null
  for (const txn of transactions) {
    if (txn.type !== "Rentals" || txn.serialNumber !== serial) continue
    const day = txn.date.slice(0, 10)
    if (!DAY.test(day)) continue
    if (!best || day > best) best = day
  }
  return best
}

function metaRecord(metadata: unknown): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null
  return metadata as Record<string, unknown>
}

export function rentalDaysFromMetadata(metadata: unknown): number | null {
  const record = metaRecord(metadata)
  if (!record || record.converted_from !== "Rentals") return null
  const days = typeof record.rental_days === "number" ? record.rental_days : Number(record.rental_days)
  return Number.isInteger(days) && days >= 1 ? days : null
}

/** "Rented from <start> to <end> (<n> days), then sold on <date>". */
export function rentalConversionLabel(metadata: unknown, saleDate: string): string | null {
  const record = metaRecord(metadata)
  if (!record || record.converted_from !== "Rentals") return null
  const start = typeof record.rental_start === "string" ? record.rental_start.slice(0, 10) : ""
  const end = typeof record.rental_end === "string" ? record.rental_end.slice(0, 10) : ""
  const days = rentalDaysFromMetadata(metadata)
  if (!DAY.test(start) || !DAY.test(end) || days == null) return null
  return `Rented from ${formatBusinessDate(start)} to ${formatBusinessDate(end)} (${days} days), then sold on ${formatBusinessDate(saleDate)}`
}

export function rentalSaleSentence(
  transactions: readonly { type: string; serialNumber: string; date: string; metadata?: unknown }[],
  serial: string,
): string | null {
  let best: { date: string; metadata?: unknown } | null = null
  for (const txn of transactions) {
    if (txn.type !== "Sale" || txn.serialNumber !== serial) continue
    if (!rentalConversionLabel(txn.metadata, txn.date)) continue
    if (!best || txn.date > best.date) best = txn
  }
  return best ? rentalConversionLabel(best.metadata, best.date) : null
}
