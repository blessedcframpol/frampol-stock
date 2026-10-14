import type { AppNotificationRow } from "@/lib/supabase/stock-requests-db"

/** Fired when the signed-in user's notification inbox should reload (realtime, focus, poll). */
export const NOTIFICATIONS_INBOX_EVENT = "fram-stock:notifications-inbox"

/** Fired when request / invoice queues should soft-refresh without losing scroll. */
export const REQUEST_QUEUES_REFRESH_EVENT = "fram-stock:request-queues-refresh"

export function announceNotificationsInbox(): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new Event(NOTIFICATIONS_INBOX_EVENT))
}

export function announceRequestQueuesRefresh(): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new Event(REQUEST_QUEUES_REFRESH_EVENT))
}

export function notificationHref(n: AppNotificationRow): string {
  const meta = n.metadata as { request_id?: string; href?: string } | null
  if (typeof meta?.href === "string" && meta.href.startsWith("/") && !meta.href.startsWith("//")) {
    return meta.href
  }
  if (meta?.request_id) return `/requests/${meta.request_id}`
  return n.type === "pending_role" ? "/users" : "/requests"
}

const BROWSER_NOTIFY_KEY = "fram-stock.browser-notifications.asked"

export function browserNotificationsAsked(): boolean {
  try {
    return window.localStorage.getItem(BROWSER_NOTIFY_KEY) === "1"
  } catch {
    return false
  }
}

export function markBrowserNotificationsAsked(): void {
  try {
    window.localStorage.setItem(BROWSER_NOTIFY_KEY, "1")
  } catch {
    // ignore
  }
}

export async function requestBrowserNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported"
  markBrowserNotificationsAsked()
  if (Notification.permission === "granted") return "granted"
  if (Notification.permission === "denied") return "denied"
  return Notification.requestPermission()
}

export function showBrowserNotification(title: string, body?: string, href?: string): void {
  if (typeof window === "undefined" || !("Notification" in window)) return
  if (Notification.permission !== "granted") return
  if (!document.hidden) return
  try {
    const n = new Notification(title, { body: body?.slice(0, 240), tag: "fram-stock-inbox" })
    n.onclick = () => {
      window.focus()
      if (href) window.location.assign(href)
      n.close()
    }
  } catch {
    // ignore
  }
}
