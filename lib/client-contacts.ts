/**
 * CT1 — client contact (person) helpers. Email/phone rules reuse NC1 single-address checks.
 */

import {
  isClientPlaceholder,
  normalizeClientPhone,
  sanitizeClientText,
} from "@/lib/client-complete"

export const CLIENT_CONTACT_ROLES = ["buyer", "collector", "accounts", "other"] as const
export type ClientContactRole = (typeof CLIENT_CONTACT_ROLES)[number]

export const CLIENT_CONTACT_ROLE_LABELS: Record<ClientContactRole, string> = {
  buyer: "Buyer",
  collector: "Collector",
  accounts: "Accounts",
  other: "Other",
}

export type ClientContactInput = {
  name: string
  role: ClientContactRole | ""
  email: string
  phone: string
  notes?: string
  isPrimary?: boolean
}

function oneEmailProblem(raw: string): string | null {
  if (!raw) return "Email is required"
  if (isClientPlaceholder(raw)) return "Email cannot be a placeholder"
  if (/\s/.test(raw)) return "Email cannot contain spaces"
  const at = raw.indexOf("@")
  if (at <= 0 || at === raw.length - 1) return "Enter a valid email address"
  const domain = raw.slice(at + 1)
  if (!domain.includes(".")) return "Enter a valid email address"
  return null
}

/** Single address only (no ; or ,). Empty string → null (optional when phone present). */
export function clientContactEmailProblem(email: string): string | null {
  const raw = email.trim()
  if (!raw) return null
  if (raw.includes(";") || raw.includes(",")) return "Contact email must be a single address"
  return oneEmailProblem(raw)
}

/** Empty → null (optional when email present). */
export function clientContactPhoneProblem(phone: string): string | null {
  const trimmed = phone.trim()
  if (!trimmed) return null
  if (isClientPlaceholder(trimmed)) return "Phone cannot be a placeholder"
  if (!normalizeClientPhone(trimmed)) {
    return "Enter a valid phone number (e.g. 077 123 4567, +27 82 123 4567, or +260 97 123 4567)"
  }
  return null
}

export function clientContactNameProblem(name: string): string | null {
  const s = sanitizeClientText(name)
  if (!s) return "Contact name is required"
  if (isClientPlaceholder(s)) return "Contact name cannot be a placeholder"
  return null
}

export function clientContactFieldErrors(input: ClientContactInput): Record<string, string> | null {
  const errors: Record<string, string> = {}
  const nameErr = clientContactNameProblem(input.name)
  if (nameErr) errors.name = nameErr
  if (!input.role || !CLIENT_CONTACT_ROLES.includes(input.role)) {
    errors.role = "Pick a role"
  }
  const emailErr = clientContactEmailProblem(input.email)
  if (emailErr) errors.email = emailErr
  const phoneErr = clientContactPhoneProblem(input.phone)
  if (phoneErr) errors.phone = phoneErr
  if (!input.email.trim() && !input.phone.trim()) {
    errors.email = "Email or phone is required"
    errors.phone = "Email or phone is required"
  }
  return Object.keys(errors).length ? errors : null
}

export function normalizeClientContactForDb(input: ClientContactInput): {
  name: string
  role: ClientContactRole
  email: string | null
  phone: string | null
  notes: string | null
  is_primary: boolean
} {
  const errors = clientContactFieldErrors(input)
  if (errors) throw new Error(Object.values(errors)[0] ?? "Invalid contact")
  const phone = input.phone.trim() ? normalizeClientPhone(input.phone) : null
  return {
    name: sanitizeClientText(input.name),
    role: input.role as ClientContactRole,
    email: input.email.trim() ? input.email.trim().toLowerCase() : null,
    phone,
    notes: input.notes?.trim() ? input.notes.trim() : null,
    is_primary: Boolean(input.isPrimary),
  }
}

export function formatClientContactLabel(contact: {
  name: string
  role?: string | null
  email?: string | null
  phone?: string | null
  active?: boolean | null
}): string {
  const name =
    contact.active === false ? `${contact.name} (archived)` : contact.name
  const bits = [name]
  if (contact.role && contact.role in CLIENT_CONTACT_ROLE_LABELS && contact.role !== "buyer") {
    bits.push(CLIENT_CONTACT_ROLE_LABELS[contact.role as ClientContactRole])
  }
  const reach = contact.email?.trim() || contact.phone?.trim()
  if (reach) bits.push(reach)
  return bits.join(" · ")
}

/** Request header line: "Buyer: Name · email-or-phone" (no repeated Buyer / role). */
export function formatBuyerHeader(contact: {
  name: string
  email?: string | null
  phone?: string | null
  active?: boolean | null
}): string {
  const name =
    contact.active === false ? `${contact.name} (archived)` : contact.name
  const reach = contact.email?.trim() || contact.phone?.trim()
  return reach ? `Buyer: ${name} · ${reach}` : `Buyer: ${name}`
}
