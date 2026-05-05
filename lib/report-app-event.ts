"use client"

export type ReportAppEventInput = {
  severity: "error" | "warn" | "info"
  source: "client"
  context: string
  message: string
  detail?: string
  metadata?: Record<string, unknown>
}

/**
 * Best-effort POST to `/api/app-logs`. Never throws; logs a dev warning on failure.
 */
export async function reportAppEvent(input: ReportAppEventInput): Promise<void> {
  try {
    const res = await fetch("/api/app-logs", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        severity: input.severity,
        source: input.source,
        context: input.context,
        message: input.message,
        ...(input.detail ? { detail: input.detail } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      }),
    })
    if (!res.ok && process.env.NODE_ENV === "development") {
      const text = await res.text().catch(() => "")
      console.warn("[reportAppEvent] POST failed", res.status, text.slice(0, 200))
    }
  } catch (e) {
    if (process.env.NODE_ENV === "development") {
      console.warn("[reportAppEvent] fetch error", e)
    }
  }
}
