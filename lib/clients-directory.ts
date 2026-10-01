import { formatClientLabel } from "@/lib/client-label"
import { isOverdue } from "@/lib/alerts"

/** Stored stand-ins. Display hides these; the database row is left alone. */
const PLACEHOLDERS = new Set(["n/a", "na", "n.a", "n.a.", "none", "-", "null", ""])

export type ClientListChip = "all" | "out" | "overdue" | "noContact"

export type ClientSort = "name" | "activity" | "out" | "orders" | "units"

export type DirectoryClient = {
  id: string
  name: string
  company: string
  email?: string | null
  phone?: string | null
  sites?: { name?: string; address: string }[] | null
}

export type HeldUnit = {
  id: string
  serialNumber: string
  product: string
  kind: "POC" | "Rental"
  holder: string
  dateOut: string | null
  returnDate: string | null
}

export const OPEN_REQUEST_STATUSES = new Set(["draft", "submitted", "in_progress", "serviced"])

export function isPlaceholder(value: string | null | undefined): boolean {
  return PLACEHOLDERS.has((value ?? "").trim().toLowerCase())
}

/** Null when the stored value should not be shown. */
export function displayContact(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim()
  if (isPlaceholder(trimmed)) return null
  return trimmed
}

export function displayLabel(client: { name?: string | null; company?: string | null }): string {
  return displayContact(formatClientLabel(client)) ?? "—"
}

/**
 * A name that cannot identify the client.
 * Stand-ins from the directory (N/A and the same blanks), a single 0, a run of zeros,
 * or a value with no letter — digits and punctuation only. A street address still has
 * letters, so it stays with real names.
 */
export function isWeakClientName(value: string | null | undefined): boolean {
  const trimmed = (value ?? "").trim()
  if (isPlaceholder(trimmed)) return true
  if (/^0+$/.test(trimmed)) return true
  return !/\p{L}/u.test(trimmed)
}

export type ClientListIdentity = {
  title: string
  /** Stored name was not usable, so the title is the company or "Unnamed client". */
  fallback: boolean
}

/** Usable name, then company, then a fixed label. Stored rows are not rewritten. */
export function clientListIdentity(client: {
  name?: string | null
  company?: string | null
}): ClientListIdentity {
  if (!isWeakClientName(client.name)) {
    const title = formatClientLabel(client).trim()
    if (title && !isWeakClientName(title)) return { title, fallback: false }
  }
  const company = (client.company ?? "").trim()
  if (!isWeakClientName(company)) return { title: company, fallback: true }
  return { title: "Unnamed client", fallback: true }
}

/** Real names first. Weak stored names follow, ordered by the fallback title. */
export function compareClientsByName(
  a: { id?: string; name?: string | null; company?: string | null },
  b: { id?: string; name?: string | null; company?: string | null },
): number {
  const aWeak = isWeakClientName(a.name)
  const bWeak = isWeakClientName(b.name)
  if (aWeak !== bWeak) return aWeak ? 1 : -1
  const byTitle = clientListIdentity(a).title.localeCompare(clientListIdentity(b).title, undefined, {
    sensitivity: "base",
  })
  if (byTitle !== 0) return byTitle
  return (a.id ?? "").localeCompare(b.id ?? "")
}

export function splitEmails(value: string | null | undefined): string[] {
  const raw = (value ?? "").trim()
  if (!raw) return []
  return raw
    .split(";")
    .map((part) => part.trim())
    .filter((part) => !isPlaceholder(part))
}

export function realSites(
  sites: { name?: string; address: string }[] | null | undefined,
): { name?: string; address: string }[] {
  const out: { name?: string; address: string }[] = []
  for (const site of sites ?? []) {
    const address = displayContact(site.address)
    if (!address) continue
    const name = displayContact(site.name)
    out.push(name ? { name, address } : { address })
  }
  return out
}

export function clientHasNoContact(client: { email?: string | null; phone?: string | null }): boolean {
  return splitEmails(client.email).length === 0 && !displayContact(client.phone)
}

/** Exact keys a holding or ledger string can use for this directory row. */
export function clientMatchKeys(client: { name?: string | null; company?: string | null }): string[] {
  const name = (client.name ?? "").trim().toLowerCase()
  const company = (client.company ?? "").trim().toLowerCase()
  const keys = new Set<string>()
  if (name && !isPlaceholder(name)) keys.add(name)
  if (company && !isPlaceholder(company)) keys.add(company)
  if (name && company) keys.add(`${name} - ${company}`)
  const label = formatClientLabel(client).trim().toLowerCase()
  if (label && !isPlaceholder(label)) keys.add(label)
  return [...keys]
}

export function holderMatchesClient(
  holder: string | null | undefined,
  client: { name?: string | null; company?: string | null },
): boolean {
  const key = (holder ?? "").trim().toLowerCase()
  if (!key || isPlaceholder(key)) return false
  return clientMatchKeys(client).includes(key)
}

export function holdingsForClient(units: readonly HeldUnit[], client: DirectoryClient): HeldUnit[] {
  return units.filter((unit) => holderMatchesClient(unit.holder, client))
}

export type ClientHoldingStats = {
  out: number
  overdue: number
}

export function holdingStats(
  clients: readonly DirectoryClient[],
  units: readonly HeldUnit[],
  today: string,
): Map<string, ClientHoldingStats> {
  const stats = new Map<string, ClientHoldingStats>()
  for (const client of clients) stats.set(client.id, { out: 0, overdue: 0 })
  for (const unit of units) {
    for (const client of clients) {
      if (!holderMatchesClient(unit.holder, client)) continue
      const current = stats.get(client.id) ?? { out: 0, overdue: 0 }
      current.out += 1
      if (unit.returnDate && isOverdue(unit.returnDate, today)) current.overdue += 1
      stats.set(client.id, current)
    }
  }
  return stats
}

export type ClientChipCounts = {
  all: number
  out: number
  overdue: number
  noContact: number
}

/** Full directory, not the page on screen. */
export function clientChipCounts(
  clients: readonly DirectoryClient[],
  units: readonly HeldUnit[],
  today: string,
): ClientChipCounts {
  const stats = holdingStats(clients, units, today)
  let out = 0
  let overdue = 0
  let noContact = 0
  for (const client of clients) {
    const row = stats.get(client.id)
    if ((row?.out ?? 0) > 0) out += 1
    if ((row?.overdue ?? 0) > 0) overdue += 1
    if (clientHasNoContact(client)) noContact += 1
  }
  return { all: clients.length, out, overdue, noContact }
}

