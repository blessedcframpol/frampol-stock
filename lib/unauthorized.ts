"use client"

import { toast } from "sonner"

export const SESSION_EXPIRED_MESSAGE = "Your session has expired. Please sign in again."

const SESSION_EXPIRED_TOAST_MS = 14_000

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

export function notifySessionExpired() {
  toast.error(SESSION_EXPIRED_MESSAGE, { duration: SESSION_EXPIRED_TOAST_MS })
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
  return isAuthFailure(caught) ? SESSION_EXPIRED_MESSAGE : fallback
}

/**
 * Shared 401 UX for /api/ fetches.
 * Returns true when the caller should stop (do not parse "Unauthorized" or toast a fallback).
 * Pass `{ silent: true }` for fire-and-forget calls that must not interrupt the user.
 */
export function handleUnauthorized(
  status: number,
  options?: { silent?: boolean }
): boolean {
  if (!isUnauthorizedStatus(status)) return false
  if (!options?.silent) {
    notifySessionExpired()
  }
  return true
}
