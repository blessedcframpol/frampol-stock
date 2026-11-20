"use client"

import { toast } from "sonner"

export const SESSION_EXPIRED_MESSAGE = "Your session has expired. Please sign in again."
export const NETWORK_UNAVAILABLE_MESSAGE =
  "Can't reach Fram Stock right now. Check your connection and try again."

const SESSION_EXPIRED_TOAST_MS = 14_000
const NETWORK_TOAST_MS = 14_000

export function isUnauthorizedStatus(status: number): boolean {
  return status === 401
}

/**
 * PostgREST / supabase-js errors that mean the JWT or session is gone.
 * Direct `.from()` calls do not go through proxy.ts, so there is no HTTP 401
 * from our API — these codes/messages are the real signal.
 */
export function isAuthFailure(caught: unknown): boolean {
  if (!caught || typeof caught !== "object") return false
  const o = caught as {
    status?: unknown
    code?: unknown
    name?: unknown
    message?: unknown
  }
  if (o.status === 401) return true
  if (typeof o.code === "string" && (o.code === "401" || o.code === "PGRST301")) return true
  if (o.name === "AuthSessionMissingError") return true
  const msg = typeof o.message === "string" ? o.message : ""
  return (
    /jwt expired/i.test(msg) ||
    /invalid jwt/i.test(msg) ||
    /auth session missing/i.test(msg)
  )
}

/** Network / unreachable / 5xx — not a signed-out session. */
export function isNetworkFailure(caught: unknown): boolean {
  if (caught == null) return false

  if (typeof caught === "number") {
    return caught >= 500 && caught < 600
  }

  if (typeof caught === "string") {
    return isNetworkFailureMessage(caught)
  }

  if (typeof caught !== "object") return false
  const o = caught as {
    status?: unknown
    statusCode?: unknown
    name?: unknown
    message?: unknown
    cause?: unknown
  }

  const status =
    typeof o.status === "number"
      ? o.status
      : typeof o.statusCode === "number"
        ? o.statusCode
        : null
  if (status != null && status >= 500 && status < 600) return true

  if (o.name === "TypeError" || o.name === "AbortError" || o.name === "TimeoutError") {
    return true
  }

  const msg = typeof o.message === "string" ? o.message : ""
  if (isNetworkFailureMessage(msg)) return true

  if (o.cause) return isNetworkFailure(o.cause)
  return false
}

function isNetworkFailureMessage(msg: string): boolean {
  return (
    /failed to fetch/i.test(msg) ||
    /networkerror/i.test(msg) ||
    /network request failed/i.test(msg) ||
    /load failed/i.test(msg) ||
    /fetch failed/i.test(msg) ||
    /econnrefused/i.test(msg) ||
    /enotfound/i.test(msg) ||
    /etimedout/i.test(msg) ||
    /timeout/i.test(msg) ||
    /offline/i.test(msg) ||
    /err_network/i.test(msg)
  )
}

export type ClassifiedFailure =
  | { kind: "auth"; message: typeof SESSION_EXPIRED_MESSAGE }
  | { kind: "network"; message: typeof NETWORK_UNAVAILABLE_MESSAGE }
  | { kind: "other"; message: string }

/** Prefer auth over network when both could match (e.g. 401). */
export function classifyFailure(caught: unknown, fallback: string): ClassifiedFailure {
  if (isAuthFailure(caught)) {
    return { kind: "auth", message: SESSION_EXPIRED_MESSAGE }
  }
  if (isNetworkFailure(caught)) {
    return { kind: "network", message: NETWORK_UNAVAILABLE_MESSAGE }
  }
  return { kind: "other", message: fallback }
}

export function notifySessionExpired() {
  toast.error(SESSION_EXPIRED_MESSAGE, {
    duration: SESSION_EXPIRED_TOAST_MS,
    action: {
      label: "Sign in",
      onClick: () => {
        if (typeof window !== "undefined") {
          const next = window.location.pathname || "/"
          window.location.assign(`/login?redirectTo=${encodeURIComponent(next)}`)
        }
      },
    },
  })
}

/**
 * Network / unreachable toast. Pass `onRetry` for idempotent reads only.
 * Writes should omit onRetry (message only, no auto-retry).
 */
export function notifyNetworkUnavailable(options?: { onRetry?: () => void }) {
  toast.error(NETWORK_UNAVAILABLE_MESSAGE, {
    duration: NETWORK_TOAST_MS,
    ...(options?.onRetry
      ? {
          action: {
            label: "Retry",
            onClick: () => options.onRetry?.(),
          },
        }
      : {}),
  })
}

/**
 * After a successful query that returned no row: if there is no user, this is
 * RLS-empty-because-signed-out, not a genuine absence. Returns the session
 * message (and toasts) or null when a session is present.
 */
export async function signedOutLoadError(sb: {
  auth: { getUser: () => Promise<{ data: { user: unknown } }> }
}): Promise<string | null> {
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (user) return null
  notifySessionExpired()
  return SESSION_EXPIRED_MESSAGE
}

export function loadErrorFromCaught(caught: unknown, fallback: string): string {
  return classifyFailure(caught, fallback).message
}

/**
 * Toast the right UX for a caught failure.
 * `onRetry` is only attached for network failures (caller should pass only for reads).
 */
export function notifyClassifiedFailure(
  caught: unknown,
  fallback: string,
  options?: { onRetry?: () => void },
): ClassifiedFailure {
  const classified = classifyFailure(caught, fallback)
  if (classified.kind === "auth") {
    notifySessionExpired()
  } else if (classified.kind === "network") {
    notifyNetworkUnavailable(options?.onRetry ? { onRetry: options.onRetry } : undefined)
  } else {
    toast.error(classified.message, { duration: SESSION_EXPIRED_TOAST_MS })
  }
  return classified
}

/**
 * Shared 401 UX for /api/ fetches.
 * Returns true when the caller should stop (do not parse "Unauthorized" or toast a fallback).
 * Pass `{ silent: true }` for fire-and-forget calls that must not interrupt the user.
 */
export function handleUnauthorized(
  status: number,
  options?: { silent?: boolean },
): boolean {
  if (!isUnauthorizedStatus(status)) return false
  if (!options?.silent) {
    notifySessionExpired()
  }
  return true
}

/** Treat 5xx from /api/ as network/unavailable (not session). */
export function handleApiTransportStatus(
  status: number,
  options?: { onRetry?: () => void; silent?: boolean },
): "auth" | "network" | null {
  if (isUnauthorizedStatus(status)) {
    if (!options?.silent) notifySessionExpired()
    return "auth"
  }
  if (status >= 500 && status < 600) {
    if (!options?.silent) {
      notifyNetworkUnavailable(options?.onRetry ? { onRetry: options.onRetry } : undefined)
    }
    return "network"
  }
  return null
}
