import { randomUUID } from "crypto"
import { NextResponse } from "next/server"
import type { ParsedApiError } from "@/lib/parse-api-error"

export type ApiErrorPayload = ParsedApiError & { error: string; requestId: string }

function causeToDetail(cause: unknown): string | undefined {
  if (cause == null) return undefined
  if (cause instanceof Error) {
    const m = cause.message?.trim()
    return m || undefined
  }
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const m = (cause as { message?: unknown }).message
    if (typeof m === "string" && m.trim()) return m.trim()
  }
  const s = String(cause).trim()
  return s || undefined
}

/**
 * Server / dependency failures: includes optional technical `detail` for bug reports.
 */
export function apiErrorResponse(
  status: number,
  message: string,
  options?: { cause?: unknown; logLabel?: string }
): NextResponse<ApiErrorPayload> {
  const requestId = randomUUID()
  const detail = options?.cause != null ? causeToDetail(options.cause) : undefined
  const payload: ApiErrorPayload = {
    error: message,
    requestId,
    ...(detail && detail !== message ? { detail } : {}),
  }
  const logMsg = options?.logLabel
    ? `[${requestId}] ${options.logLabel}`
    : `[${requestId}] HTTP ${status}`
  if (options?.cause !== undefined) console.error(logMsg, options.cause)
  else console.error(logMsg)
  return NextResponse.json(payload, { status })
}

/**
 * Validation, auth, missing config: stable `error` copy; always includes `requestId` for support.
 */
export function apiClientError(
  status: number,
  message: string,
  options?: { log?: "warn" | "error" | "none"; logLabel?: string }
): NextResponse<ApiErrorPayload> {
  const requestId = randomUUID()
  const log = options?.log ?? "warn"
  const label = options?.logLabel ?? message
  if (log === "warn") console.warn(`[${requestId}] HTTP ${status}:`, label)
  else if (log === "error") console.error(`[${requestId}] HTTP ${status}:`, label)
  return NextResponse.json({ error: message, requestId }, { status })
}
