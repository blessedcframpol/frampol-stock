/** Matches DB `interval '3 minutes'` for stock_request_issue_lock_is_fresh. */
export const ISSUE_LOCK_FRESH_MS = 3 * 60 * 1000

/** Stop touching and end lock after this much idle time on the fulfill screen. */
export const ISSUE_LOCK_IDLE_RELEASE_MS = 10 * 60 * 1000

export const ISSUE_LOCK_TOUCH_INTERVAL_MS = 45 * 1000

export function formatIssueLockAge(sinceIso: string, nowMs = Date.now()): string {
  const sinceMs = Date.parse(sinceIso)
  if (!Number.isFinite(sinceMs)) return ""
  const minutes = Math.max(0, Math.floor((nowMs - sinceMs) / 60_000))
  if (minutes < 1) return "just now"
  if (minutes === 1) return "1 min ago"
  return `${minutes} min ago`
}
