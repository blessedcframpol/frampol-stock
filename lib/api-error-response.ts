import { randomUUID } from "crypto"
import { NextResponse } from "next/server"
import type { ParsedApiError } from "@/lib/parse-api-error"
import { scheduleApiErrorAppEventLog } from "@/lib/app-event-log-server"

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
  options?: { cause?: unknown; logLabel?: string; detail?: string; metadata?: Record<string, unknown> }
): NextResponse<ApiErrorPayload> {
  const requestId = randomUUID()
  const detail =
    options?.detail?.trim() ||
    (options?.cause != null ? causeToDetail(options.cause) : undefined)
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
  scheduleApiErrorAppEventLog({
    status,
    requestId: payload.requestId,
    message,
    detail,
    logLabel: options?.logLabel,
    metadata: options?.metadata,
  })
  return NextResponse.json(payload, { status })
}

/**
 * Validation, auth, missing config: stable `error` copy; always includes `requestId` for support.
 */
export function apiClientError(
  status: number,
  message: string,
  options?: { log?: "warn" | "error" | "none"; logLabel?: string; detail?: string; metadata?: Record<string, unknown> }
): NextResponse<ApiErrorPayload> {
  const requestId = randomUUID()
  const log = options?.log ?? "warn"
  const label = options?.detail?.trim() || options?.logLabel || message
  if (log === "warn") console.warn(`[${requestId}] HTTP ${status}:`, label)
  else if (log === "error") console.error(`[${requestId}] HTTP ${status}:`, label)
  if (log !== "none") {
    scheduleApiErrorAppEventLog({
      status,
      requestId,
      message,
      detail: label,
      logLabel: options?.logLabel,
      metadata: options?.metadata,
    })
  }
  return NextResponse.json(
    {
      error: message,
      requestId,
      ...(options?.detail?.trim() && options.detail.trim() !== message ? { detail: options.detail.trim() } : {}),
    },
    { status }
  )
}
