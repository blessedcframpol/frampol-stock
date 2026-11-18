/** NT3 — Web Push helpers (types, labels, VAPID). Server + client safe labels. */

export const DESKTOP_PUSH_TYPE_GROUPS = [
  "new_requests",
  "reminders",
  "my_request_updated",
] as const

export type DesktopPushTypeGroup = (typeof DESKTOP_PUSH_TYPE_GROUPS)[number]

const NEW_REQUEST_TYPES = new Set(["request_submitted", "request_resubmitted"])
const REMINDER_TYPES = new Set(["request_unclaimed_reminder"])
const MY_REQUEST_TYPES = new Set([
  "request_units_issued",
  "request_rejected",
  "request_cancelled",
  "request_serviced",
  "request_closed",
  "atlas_link_restored",
])

export function desktopPushGroupForType(type: string): DesktopPushTypeGroup | null {
  if (NEW_REQUEST_TYPES.has(type)) return "new_requests"
  if (REMINDER_TYPES.has(type)) return "reminders"
  if (MY_REQUEST_TYPES.has(type)) return "my_request_updated"
  return null
}

/** Short label for OS pop-up (no client details). */
export function desktopPushTypeLabel(type: string): string {
  switch (type) {
    case "request_submitted":
      return "New request"
    case "request_resubmitted":
      return "Request resubmitted"
    case "request_unclaimed_reminder":
      return "Unclaimed request reminder"
    case "request_units_issued":
      return "Units issued"
    case "request_rejected":
      return "Request rejected"
    case "request_cancelled":
      return "Request cancelled"
    case "request_serviced":
      return "Request serviced"
    case "request_closed":
      return "Request closed"
    case "atlas_link_restored":
      return "Atlas link needed"
    case "push_test":
      return "Test pop-up"
    default:
      return "Notification"
  }
}

export type DesktopPushPrefs = {
  enabled: boolean
  newRequests: boolean
  reminders: boolean
  myRequestUpdated: boolean
}

export function prefsAllowType(prefs: DesktopPushPrefs, type: string): boolean {
  if (!prefs.enabled) return false
  if (type === "push_test") return true
  const group = desktopPushGroupForType(type)
  if (!group) return false
  if (group === "new_requests") return prefs.newRequests
  if (group === "reminders") return prefs.reminders
  return prefs.myRequestUpdated
}

export function buildPushPayload(input: {
  notificationId: string
  type: string
  requestNumber?: string | null
  requestId?: string | null
  href?: string | null
}): {
  title: string
  body: string
  href: string
  notificationId: string
  tag: string
} {
  const label = desktopPushTypeLabel(input.type)
  const num =
    typeof input.requestNumber === "string" && input.requestNumber.trim()
      ? input.requestNumber.trim()
      : null
  const title = num ? `${num} — ${label}` : label
  const href =
    (typeof input.href === "string" && input.href.startsWith("/") && !input.href.startsWith("//")
      ? input.href
      : null) ||
    (input.requestId ? `/requests/${input.requestId}` : "/requests")
  return {
    title,
    body: label,
    href,
    notificationId: input.notificationId,
    tag: `fram-stock:${input.notificationId}`,
  }
}
