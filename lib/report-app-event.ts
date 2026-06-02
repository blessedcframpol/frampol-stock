"use client"

import { toast } from "sonner"
import { parseApiErrorBody } from "@/lib/parse-api-error"

export type ReportAppEventInput = {
  severity: "error" | "warn" | "info"
  source: "client"
  context: string
  message: string
  detail?: string
  metadata?: Record<string, unknown>
}

let lastLogFailureToastAt = 0
const LOG_FAILURE_TOAST_DEBOUNCE_MS = 30_000

// Browsers cap the combined body size of in-flight keepalive requests at ~64KB.
// Keep our payload comfortably under that so a large metadata/detail can't make
// the browser silently drop the request.
const MAX_KEEPALIVE_BODY_BYTES = 48_000

/**
 * Best-effort POST to `/api/app-logs`. Never throws; logs a dev warning on failure.
 */
export async function reportAppEvent(input: ReportAppEventInput): Promise<void> {
  try {
    let body = JSON.stringify({
      severity: input.severity,
      source: input.source,
      context: input.context,
      message: input.message,
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    })
    // If the payload is too large for the keepalive quota, drop the heavy fields
    // and keep a preview so the event itself still lands.
    if (body.length > MAX_KEEPALIVE_BODY_BYTES) {
      body = JSON.stringify({
        severity: input.severity,
        source: input.source,
        context: input.context,
        message: input.message,
        metadata: {
          _truncatedClientSide: true,
          _originalBodyBytes: body.length,
          detailPreview: input.detail?.slice(0, 2000) ?? null,
        },
      })
    }
    const res = await fetch("/api/app-logs", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      // keepalive lets the browser finish this fire-and-forget POST even if the
      // calling component unmounts or the page navigates immediately after (e.g.
      // a movement dialog closing on success). Without it the request is aborted
      // on unload and the event is silently lost.
      keepalive: true,
      body,
    })
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      const parsed = parseApiErrorBody(body)
      if (parsed) {
        const now = Date.now()
        if (now - lastLogFailureToastAt > LOG_FAILURE_TOAST_DEBOUNCE_MS) {
          lastLogFailureToastAt = now
          toast.warning("Could not record application log", {
            description: parsed.requestId
              ? `Reference: ${parsed.requestId}${parsed.detail ? `\n${parsed.detail}` : ""}`
              : parsed.detail,
            duration: 10_000,
          })
        }
      }
      console.warn("[reportAppEvent] POST failed", res.status, parsed?.requestId ?? "")
    }
  } catch (e) {
    const now = Date.now()
    if (now - lastLogFailureToastAt > LOG_FAILURE_TOAST_DEBOUNCE_MS) {
      lastLogFailureToastAt = now
      toast.warning("Could not record application log", {
        description: "Network issue while writing app logs.",
        duration: 10_000,
      })
    }
    console.warn("[reportAppEvent] fetch error", e)
  }
}
