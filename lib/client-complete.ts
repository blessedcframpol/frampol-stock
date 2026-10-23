/**
 * NC1 — new client completeness (mirrors public.client_* SQL helpers).
 */

export type ClientEntityKind = "company" | "individual"

export type ClientCompleteInput = {
  kind: ClientEntityKind
  name: string
  company: string
  email: string
  phone: string
  sites: { name?: string; address: string }[]
}

const PLACEHOLDER_RE =
  /^(n\/a|na|n\.a\.?|none|null|nil|tbd|tbc|\?+|\.+|,+|\/+|\\+|—|-+|0+|000+)$/i

/** Trim and strip leading/trailing punctuation (keep inner punctuation). */
export function sanitizeClientText(value: string): string {
  let s = value.trim()
  s = s.replace(/^[\s.,;:/\\\-–—]+/, "").replace(/[\s.,;:/\\\-–—]+$/, "")
  return s.trim()
}

export function isClientPlaceholder(value: string | null | undefined): boolean {
  const s = sanitizeClientText(value ?? "")
  if (!s) return true
  if (PLACEHOLDER_RE.test(s)) return true
  if (/^0+$/.test(s.replace(/\s/g, ""))) return true
  return false
}

/** Split email field on ";" / "," → trimmed non-empty parts (order preserved). */
export function splitClientEmailParts(email: string): string[] {
  const raw = email.trim()
  if (!raw) return []
  return raw
    .split(/[;,]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

function oneClientEmailProblem(raw: string): string | null {
  if (!raw) return "Email is required"
  if (isClientPlaceholder(raw)) return "Email cannot be a placeholder"
  if (/\s/.test(raw)) return "Email cannot contain spaces"
  const at = raw.indexOf("@")
  if (at <= 0 || at === raw.length - 1) return "Enter a valid email address"
  const domain = raw.slice(at + 1)
  if (!domain.includes(".")) return "Enter a valid email address"
  return null
}

/** Deduped lowercased parts in first-seen order (case-insensitive). */
export function uniqueClientEmailParts(email: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of splitClientEmailParts(email)) {
    const key = part.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

/** 1–5 addresses separated by ";" or ","; each must be valid; repeats ignored. */
export function clientEmailProblem(email: string): string | null {
  const raw = email.trim()
  if (!raw) return "Email is required"
  const parts = uniqueClientEmailParts(raw)
  if (parts.length === 0) return "Email is required"
  if (parts.length > 5) return "At most 5 email addresses allowed"
  for (const part of parts) {
    const problem = oneClientEmailProblem(part)
    if (problem) return `${problem}: ${part}`
  }
  return null
}

/** Canonical store form: "a@x.com; b@y.com" (silent case-insensitive dedupe). */
export function normalizeClientEmails(email: string): string {
  return uniqueClientEmailParts(email).join("; ")
}

/**
 * Local 07…/02… → +263…; explicit +<country> kept as + and digits only (10–15 digits after +).
 */
export function normalizeClientPhone(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "")
    if (digits.length < 10 || digits.length > 15) return null
    if (/^0+$/.test(digits)) return null
    return `+${digits}`
  }

  let digits = trimmed.replace(/\D/g, "")
  if (!digits) return null
  if (digits.startsWith("263")) {
    const national = digits.slice(3)
    if (national.length >= 9 && national.length <= 10 && !/^0+$/.test(national)) {
      return `+263${national}`
    }
    return null
  }
  if (digits.startsWith("0")) {
    const national = digits.slice(1)
    if (national.length >= 9 && national.length <= 10 && !/^0+$/.test(national)) {
      return `+263${national}`
    }
    return null
  }
  return null
}

export function clientPhoneProblem(phone: string): string | null {
  const trimmed = phone.trim()
  if (!trimmed) return "Phone is required"
  if (isClientPlaceholder(trimmed)) return "Phone cannot be a placeholder"
  const normalized = normalizeClientPhone(trimmed)
  if (!normalized) {
    return "Enter a valid phone number (e.g. 077 123 4567, +27 82 123 4567, or +260 97 123 4567)"
  }
  return null
}

export function clientSiteAddressProblem(address: string): string | null {
  const s = sanitizeClientText(address)
  if (!s) return "Physical address is required"
  if (isClientPlaceholder(s)) return "Address cannot be a placeholder"
  if (s.length < 5) return "Enter a fuller physical address"
  return null
}

export function clientNameProblem(name: string, kind: ClientEntityKind): string | null {
  const s = sanitizeClientText(name)
  if (!s) return kind === "individual" ? "Full name is required" : "Contact name is required"
  if (isClientPlaceholder(s)) return "Name cannot be a placeholder"
  return null
}

export function clientCompanyProblem(company: string, kind: ClientEntityKind): string | null {
  if (kind === "individual") {
    const s = sanitizeClientText(company)
    if (s) return "Leave company blank for an individual"
    return null
  }
  const s = sanitizeClientText(company)
  if (!s) return "Company name is required"
  if (isClientPlaceholder(s)) return "Company name cannot be a placeholder"
  return null
}

/** Field-level errors for new clients; null when OK. */
export function newClientFieldErrors(input: ClientCompleteInput): Record<string, string> | null {
  const errors: Record<string, string> = {}
  const nameErr = clientNameProblem(input.name, input.kind)
  if (nameErr) errors.name = nameErr
  const companyErr = clientCompanyProblem(input.company, input.kind)
  if (companyErr) errors.company = companyErr
  const emailErr = clientEmailProblem(input.email)
  if (emailErr) errors.email = emailErr
  const phoneErr = clientPhoneProblem(input.phone)
  if (phoneErr) errors.phone = phoneErr
  const sites = input.sites.filter((s) => sanitizeClientText(s.address))
  if (sites.length === 0) {
    errors.sites = "At least one physical address is required"
  } else {
    for (let i = 0; i < sites.length; i++) {
      const p = clientSiteAddressProblem(sites[i]!.address)
      if (p) errors[`site_${i}`] = p
    }
  }
  return Object.keys(errors).length ? errors : null
}

/** Normalised payload ready for insert (individual → company null). */
export function normalizeNewClientForDb(input: ClientCompleteInput): {
  name: string
  company: string | null
  email: string
  phone: string
  sites: { name?: string; address: string }[]
} {
  const phone = normalizeClientPhone(input.phone)
  if (!phone) throw new Error("Enter a valid phone number")
  const sites = input.sites
    .map((s) => ({
      ...(sanitizeClientText(s.name ?? "") ? { name: sanitizeClientText(s.name ?? "") } : {}),
      address: sanitizeClientText(s.address),
    }))
    .filter((s) => s.address)
  return {
    name: sanitizeClientText(input.name),
    company: input.kind === "individual" ? null : sanitizeClientText(input.company),
    email: normalizeClientEmails(input.email),
    phone,
    sites,
  }
}

/** Fold name for duplicate detection (letters/digits only, lower case). */
export function normalizeClientNameKey(name: string): string {
  return sanitizeClientText(name)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export type ClientDuplicateMatch = {
  id: string
  name: string
  company: string | null
  email: string
  phone: string | null
  match_on: ("email" | "phone" | "name")[]
}
