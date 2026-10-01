/** Dashboard chart series. Counts come from the in-memory ledger; these helpers only group it. */

const MONTH_LABELS: Record<string, string> = {
  "01": "Jan",
  "02": "Feb",
  "03": "Mar",
  "04": "Apr",
  "05": "May",
  "06": "Jun",
  "07": "Jul",
  "08": "Aug",
  "09": "Sep",
  "10": "Oct",
  "11": "Nov",
  "12": "Dec",
}

export type VendorUnits = {
  vendor: string
  units: number
}

export type MonthlySaleUnits = {
  monthKey: string
  month: string
  units: number
}

export function inventoryVendorKey(vendor: string | null | undefined): string {
  const trimmed = vendor?.trim()
  return trimmed ? trimmed : "General"
}

/** In-stock units only, one row per vendor, highest first. */
export function inStockByVendor(
  items: readonly { vendor?: string | null; status?: string | null }[]
): VendorUnits[] {
  return unitsByVendor(items.filter((item) => item.status === "In Stock"))
}

/** Every live unit, every status, one row per vendor, highest first. */
export function allUnitsByVendor(
  items: readonly { vendor?: string | null }[]
): VendorUnits[] {
  return unitsByVendor(items)
}

function unitsByVendor(items: readonly { vendor?: string | null }[]): VendorUnits[] {
  const counts = new Map<string, number>()
  for (const item of items) {
    const vendor = inventoryVendorKey(item.vendor)
    counts.set(vendor, (counts.get(vendor) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([vendor, units]) => ({ vendor, units }))
    .sort((a, b) => b.units - a.units || a.vendor.localeCompare(b.vendor))
}

/** Six calendar months ending on the business date's month, oldest first. */
export function lastSixBusinessMonths(businessDate: string): string[] {
  const [year, month] = businessDate.slice(0, 7).split("-").map(Number)
  const months: string[] = []
  for (let offset = 5; offset >= 0; offset -= 1) {
    const cursor = new Date(Date.UTC(year, month - 1 - offset, 1))
    const key = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`
    months.push(key)
  }
  return months
}

/**
 * Sale rows in the last six business months. One row is one unit.
 * `date` is the business date (YYYY-MM-DDT00:00:00.000Z), not the recorded instant.
 */
export function monthlySaleUnits(
  transactions: readonly { type?: string | null; date?: string | null }[],
  businessDate: string
): MonthlySaleUnits[] {
  const months = lastSixBusinessMonths(businessDate)
  const counts = new Map(months.map((month) => [month, 0]))
  for (const txn of transactions) {
    if (txn.type !== "Sale") continue
    const monthKey = (txn.date ?? "").slice(0, 7)
    if (!counts.has(monthKey)) continue
    counts.set(monthKey, (counts.get(monthKey) ?? 0) + 1)
  }
  return months.map((monthKey) => ({
    monthKey,
    month: MONTH_LABELS[monthKey.slice(5, 7)] ?? monthKey,
    units: counts.get(monthKey) ?? 0,
  }))
}
