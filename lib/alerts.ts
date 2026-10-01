import { canRecordStockMovement, type AppRole } from "@/lib/permissions"

/** Returns due today through this many days ahead. Overdue is strictly before today. */
export const DUE_SOON_DAYS = 14

export const INTERNAL_HOLDERS = ["Frampol Inhouse", "CC Sales", "Internal"] as const

export type ReturnKind = "POC" | "Rental"

export type ReturnAlertRow = {
  id: string
  serialNumber: string
  productId: string
  product: string
  kind: ReturnKind
  holder: string
  returnDate: string
}

export type ReturnAlertGroup = {
  key: string
  holder: string
  returnDate: string
  kind: ReturnKind
  rows: ReturnAlertRow[]
}

export type LowStockAlertRow = {
  productId: string
  product: string
  vendor: string
  inStock: number
  reorderAt: number
}

export type AlertCountParts = {
  overduePoc: number
  overdueRental: number
  dueSoonPoc: number
  dueSoonRental: number
  lowStock: number
  internal: number
}

export type AlertCounts = AlertCountParts & {
  all: number
  overdue: number
  dueSoon: number
  poc: number
  rental: number
}

export type AlertChip = "all" | "overdue" | "dueSoon" | "lowStock" | "poc" | "rental"

const ALERT_CHIPS: readonly AlertChip[] = ["all", "overdue", "dueSoon", "lowStock", "poc", "rental"]

/** Chip named by `?chip=` on /alerts. Unknown values stay on All. */
export function alertChipFromSearch(value: string | null | undefined): AlertChip {
  return ALERT_CHIPS.find((chip) => chip === value) ?? "all"
}

const MS_PER_DAY = 86_400_000

export function addCalendarDays(ymd: string, days: number): string {
  const [year, month, day] = ymd.slice(0, 10).split("-").map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** Positive when the return date is before today. Zero is due today. */
export function returnAgeDays(returnDate: string, today: string): number {
  const due = Date.parse(`${returnDate.slice(0, 10)}T00:00:00Z`)
  const now = Date.parse(`${today.slice(0, 10)}T00:00:00Z`)
  return Math.round((now - due) / MS_PER_DAY)
}

export function formatReturnAge(returnDate: string, today: string): string {
  const age = returnAgeDays(returnDate, today)
  if (age > 0) return age === 1 ? "1 day overdue" : `${age} days overdue`
  if (age === 0) return "due today"
  const until = -age
  return until === 1 ? "due in 1 day" : `due in ${until} days`
}

export function isDueSoon(returnDate: string, today: string): boolean {
  const age = returnAgeDays(returnDate, today)
  return age <= 0 && -age <= DUE_SOON_DAYS
}

export function isOverdue(returnDate: string, today: string): boolean {
  return returnAgeDays(returnDate, today) > 0
}

export function isInternalHolder(holder: string | null | undefined): boolean {
  const key = (holder ?? "").trim().toLowerCase()
  return INTERNAL_HOLDERS.some((name) => name.toLowerCase() === key)
}

export function alertChipCounts(parts: AlertCountParts): AlertCounts {
  const overdue = parts.overduePoc + parts.overdueRental
  const dueSoon = parts.dueSoonPoc + parts.dueSoonRental
  const poc = parts.overduePoc + parts.dueSoonPoc
  const rental = parts.overdueRental + parts.dueSoonRental
  return {
    ...parts,
    overdue,
    dueSoon,
    poc,
    rental,
    all: overdue + dueSoon + parts.lowStock,
  }
}

/** Most overdue first, then soonest due. Same day stays together by holder and type. */
export function sortReturnRows(rows: readonly ReturnAlertRow[], today: string): ReturnAlertRow[] {
  return [...rows].sort((a, b) => {
    const age = returnAgeDays(b.returnDate, today) - returnAgeDays(a.returnDate, today)
    if (age !== 0) return age
    const holder = a.holder.localeCompare(b.holder)
    if (holder !== 0) return holder
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind)
    return a.serialNumber.localeCompare(b.serialNumber)
  })
}

/** Consecutive rows that share a holder, return date, and type become one group. */
export function groupReturnRows(rows: readonly ReturnAlertRow[]): ReturnAlertGroup[] {
  const groups: ReturnAlertGroup[] = []
  for (const row of rows) {
    const last = groups[groups.length - 1]
    if (
      last &&
      last.holder === row.holder &&
      last.returnDate === row.returnDate &&
      last.kind === row.kind
    ) {
      last.rows.push(row)
      continue
    }
    groups.push({
      key: `${row.holder}|${row.returnDate}|${row.kind}|${row.id}`,
      holder: row.holder,
      returnDate: row.returnDate,
      kind: row.kind,
      rows: [row],
    })
  }
  return groups
}

export function visibleReturnRows(
  rows: readonly ReturnAlertRow[],
  chip: AlertChip,
  hideInternal: boolean
): ReturnAlertRow[] {
  return rows.filter((row) => {
    if (hideInternal && isInternalHolder(row.holder)) return false
    if (chip === "poc") return row.kind === "POC"
    if (chip === "rental") return row.kind === "Rental"
    return true
  })
}

export function sectionCount(
  counts: AlertCounts,
  section: "overdue" | "dueSoon",
  chip: AlertChip
): number {
  if (section === "overdue") {
    if (chip === "poc") return counts.overduePoc
    if (chip === "rental") return counts.overdueRental
    return counts.overdue
  }
  if (chip === "poc") return counts.dueSoonPoc
  if (chip === "rental") return counts.dueSoonRental
  return counts.dueSoon
}

export function showsSection(chip: AlertChip, section: "overdue" | "dueSoon" | "lowStock"): boolean {
  if (chip === "all") return true
  if (chip === "poc" || chip === "rental") return section !== "lowStock"
  return chip === section
}

export const ALERTS_UPDATED_EVENT = "fram-stock-alerts-updated"

export function announceAlertsUpdated() {
  if (typeof window === "undefined") return
  window.dispatchEvent(new Event(ALERTS_UPDATED_EVENT))
}

/** Record return uses the same role gate as recording a stock movement. */
export function canRecordReturn(role: AppRole | null | undefined): boolean {
  return canRecordStockMovement(role)
}

export function recordReturnHref(kind: ReturnKind, serials: readonly string[]): string {
  const params = new URLSearchParams()
  params.set("type", kind === "POC" ? "POC Return" : "Rental Return")
  params.set("serials", serials.join(","))
  return `/inventory/movement?${params.toString()}`
}

/** Unknown types stay on the movement form's default. Serials are applied separately. */
export function prefillMovementType(value: string | null | undefined): string | null {
  if (value === "POC Return" || value === "Rental Return") return value
  return null
}
