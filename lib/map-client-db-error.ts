/** Map Postgres NC1 trigger / check messages to form field keys. */
export function mapClientDbError(message: string): Record<string, string> {
  const m = message.trim()
  const lower = m.toLowerCase()

  if (lower.includes("email")) {
    if (lower.includes("one email")) return { email: "Use one email address only" }
    if (lower.includes("placeholder")) return { email: "Email cannot be a placeholder" }
    if (lower.includes("required")) return { email: "Email is required" }
    if (lower.includes("valid") || lower.includes("spaces")) return { email: "Enter a valid email address" }
    return { email: m }
  }
  if (lower.includes("phone") || lower.includes("mobile") || lower.includes("zimbabwe")) {
    if (lower.includes("placeholder")) return { phone: "Phone cannot be a placeholder" }
    if (lower.includes("required")) return { phone: "Phone is required" }
    return { phone: "Enter a valid phone number (e.g. 077 123 4567 or +27…)" }
  }
  if (lower.includes("company")) {
    if (lower.includes("placeholder")) return { company: "Company name cannot be a placeholder" }
    if (lower.includes("required")) return { company: "Company name is required" }
    if (lower.includes("blank for an individual")) return { company: "Leave company blank for an individual" }
    return { company: m }
  }
  if (lower.includes("address") || lower.includes("physical") || lower.includes("site")) {
    if (lower.includes("at least one")) return { sites: "At least one physical address is required" }
    if (lower.includes("placeholder")) return { sites: "Address cannot be a placeholder" }
    if (lower.includes("fuller")) return { sites: "Enter a fuller physical address" }
    return { sites: m }
  }
  if (lower.includes("name")) {
    if (lower.includes("placeholder")) return { name: "Name cannot be a placeholder" }
    return { name: m }
  }
  return { _form: m }
}
