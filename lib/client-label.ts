/**
 * How a client is shown. Company is omitted when it is missing or the same as the
 * name once both are trimmed and compared without case. Stored rows are not rewritten.
 */
export function formatClientLabel(client: {
  name?: string | null
  company?: string | null
}): string {
  const name = (client.name ?? "").trim()
  const company = (client.company ?? "").trim()
  if (!name) return company
  if (!company || company.toLowerCase() === name.toLowerCase()) return name
  return `${name} - ${company}`
}

/** Company subtitle. Null when it would repeat the name. */
export function clientCompanyDetail(client: {
  name?: string | null
  company?: string | null
}): string | null {
  const name = (client.name ?? "").trim()
  const company = (client.company ?? "").trim()
  if (!company || !name) return null
  if (company.toLowerCase() === name.toLowerCase()) return null
  return company
}

const STORED_SEPARATOR = " - "

/** Display a ledger string that was saved as "name - company", without writing it back. */
export function collapseClientLabel(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim()
  if (!trimmed) return ""
  const parts = trimmed.split(STORED_SEPARATOR)
  if (parts.length !== 2) return trimmed
  return formatClientLabel({ name: parts[0], company: parts[1] }) || trimmed
}
