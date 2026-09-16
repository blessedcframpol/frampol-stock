"use client"

import { toast } from "sonner"
import {
  asDbErrorLike,
  humanizeStockDbError,
  parseApiErrorBody,
  type ParsedApiError,
} from "@/lib/parse-api-error"
import { reportAppEvent } from "@/lib/report-app-event"
import { handleUnauthorized } from "@/lib/unauthorized"

const REPORTABLE_TOAST_MS = 14_000

export function reportableErrorDescription(parsed: ParsedApiError): string | undefined {
  const parts: string[] = []
  if (parsed.detail && parsed.detail !== parsed.error) parts.push(parsed.detail)
  if (parsed.requestId) parts.push(`Reference: ${parsed.requestId}`)
  return parts.length ? parts.join("\n") : undefined
}

export function toastReportableApiError(parsed: ParsedApiError) {
  toast.error(parsed.error, {
    description: reportableErrorDescription(parsed),
    duration: REPORTABLE_TOAST_MS,
  })
  void reportAppEvent({
    severity: "error",
    source: "client",
    context: "ui_api_error",
    message: parsed.error,
    detail: parsed.detail,
    metadata: parsed.requestId ? { requestId: parsed.requestId } : undefined,
  })
}

export function toastFromApiErrorBody(body: unknown, fallback: string, status?: number) {
  if (status != null && handleUnauthorized(status)) return
  const parsed = parseApiErrorBody(body)
  if (parsed) toastReportableApiError(parsed)
  else {
    toast.error(fallback, { duration: REPORTABLE_TOAST_MS })
    void reportAppEvent({
      severity: "error",
      source: "client",
      context: "ui_api_error_unparsed",
      message: fallback,
      metadata: {
        bodyType: body == null ? String(body) : typeof body,
      },
    })
  }
}

export function toastFromCaughtError(caught: unknown, fallback: string) {
  const friendly = humanizeStockDbError(asDbErrorLike(caught))
  const raw =
    caught instanceof Error
      ? caught.message.trim()
      : typeof caught === "string"
        ? caught.trim()
        : typeof (caught as { message?: unknown })?.message === "string"
          ? String((caught as { message: string }).message).trim()
          : ""
  const primary = friendly ?? fallback
  const description =
    friendly || !raw || raw === primary || raw === fallback ? undefined : raw
  toast.error(primary, {
    description,
    duration: REPORTABLE_TOAST_MS,
  })
  void reportAppEvent({
    severity: "error",
    source: "client",
    context: "ui_caught_error",
    message: primary,
    detail: description ?? (raw || undefined),
    metadata: {
      caughtType:
        caught instanceof Error
          ? caught.name || "Error"
          : caught == null
            ? String(caught)
            : typeof caught,
      friendly: Boolean(friendly),
    },
  })
}
