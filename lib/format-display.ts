/** Shared empty cell. Use this instead of "-", blank, or N/A. */
export const EMPTY = "—"

const COUNT = new Intl.NumberFormat("en-GB")

/** Thousands separators: 1,262 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return EMPTY
  return COUNT.format(value)
}

export function displayOrEmpty(value: string | number | null | undefined): string {
  if (typeof value === "number") return formatCount(value)
  const trimmed = (value ?? "").trim()
  return trimmed ? trimmed : EMPTY
}

/** Axis ticks at 0, 100, 200, … covering max. */
export function hundredTicks(max: number): { domain: [number, number]; ticks: number[] } {
  const ceiling = Math.max(100, Math.ceil(Math.max(0, max) / 100) * 100)
  const ticks: number[] = []
  for (let n = 0; n <= ceiling; n += 100) ticks.push(n)
  return { domain: [0, ceiling], ticks }
}

/** Whole days from a date (YYYY-MM-DD or ISO) to a business YYYY-MM-DD. */
export function ageInDays(from: string | null | undefined, todayYmd: string): number | null {
  const start = (from ?? "").slice(0, 10)
  const end = todayYmd.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null
  const ms = Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)
  if (!Number.isFinite(ms)) return null
  return Math.max(0, Math.round(ms / 86400000))
}

export function formatAgeDays(days: number): string {
  return days === 1 ? "1 day" : `${formatCount(days)} days`
}

/**
 * Initials from letter-starting words only.
 * Tries each source in order (name, then company, then email local-part).
 * Never "-" or digits. Falls back to "?".
 */
export function displayInitials(...sources: Array<string | null | undefined>): string {
  for (const source of sources) {
    const words = (source ?? "")
      .trim()
      .split(/\s+/)
      .filter((word) => /^\p{L}/u.test(word))
    if (words.length === 0) continue
    return words
      .slice(0, 2)
      .map((word) => word[0]!.toUpperCase())
      .join("")
  }
  return "?"
}
