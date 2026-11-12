/** Inbox filter chips for NT2. */

export type NotificationChip = "all" | "requests" | "fulfilment" | "other"

export const NOTIFICATION_CHIP_LABELS: Record<NotificationChip, string> = {
  all: "All",
  requests: "Requests",
  fulfilment: "Fulfilment",
  other: "Other",
}

const REQUEST_TYPES = new Set([
  "request_submitted",
  "request_resubmitted",
  "request_awaiting_approval",
  "request_rejected",
  "request_cancelled",
  "request_closed",
  "request_awaiting_invoice_reminder",
  "request_unclaimed_reminder",
  "atlas_link_restored",
])

const FULFILMENT_TYPES = new Set(["request_units_issued"])

export function notificationChip(type: string): Exclude<NotificationChip, "all"> {
  if (FULFILMENT_TYPES.has(type)) return "fulfilment"
  if (REQUEST_TYPES.has(type) || type.startsWith("request_")) return "requests"
  return "other"
}

export function matchesNotificationChip(type: string, chip: NotificationChip): boolean {
  if (chip === "all") return true
  return notificationChip(type) === chip
}
