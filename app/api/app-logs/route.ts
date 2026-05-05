import { NextRequest, NextResponse } from "next/server"
import { apiClientError, apiErrorResponse } from "@/lib/api-error-response"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { insertAppEventLogRow, type AppEventSeverity, type AppEventSource } from "@/lib/app-event-log-server"

const SEVERITIES = new Set<string>(["error", "warn", "info"])
const SOURCES = new Set<string>(["client", "api"])
const MAX_METADATA_BYTES = 32_000

function parseMetadata(raw: unknown): Record<string, unknown> | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== "object" || Array.isArray(raw)) return null
  const s = JSON.stringify(raw)
  if (s.length > MAX_METADATA_BYTES) {
    return {
      _truncated: true,
      _originalLength: s.length,
      preview: s.slice(0, 4000),
    }
  }
  return raw as Record<string, unknown>
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      return apiClientError(401, "Unauthorized", { log: "warn", logLabel: "app-logs POST" })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return apiClientError(400, "Invalid JSON body", { log: "warn", logLabel: "app-logs POST" })
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return apiClientError(400, "Expected JSON object", { log: "warn", logLabel: "app-logs POST" })
    }
    const o = body as Record<string, unknown>
    const severity = o.severity
    const source = o.source
    const context = o.context
    const message = o.message
    if (typeof severity !== "string" || !SEVERITIES.has(severity)) {
      return apiClientError(400, "Invalid severity", { log: "warn", logLabel: "app-logs POST" })
    }
    if (typeof source !== "string" || !SOURCES.has(source)) {
      return apiClientError(400, "Invalid source", { log: "warn", logLabel: "app-logs POST" })
    }
    if (typeof context !== "string" || !context.trim()) {
      return apiClientError(400, "context is required", { log: "warn", logLabel: "app-logs POST" })
    }
    if (typeof message !== "string" || !message.trim()) {
      return apiClientError(400, "message is required", { log: "warn", logLabel: "app-logs POST" })
    }
    const detail = typeof o.detail === "string" ? o.detail : null
    const requestId = typeof o.request_id === "string" ? o.request_id : null
    const metadata = parseMetadata(o.metadata)

    const ok = await insertAppEventLogRow(supabase, {
      severity: severity as AppEventSeverity,
      source: source as AppEventSource,
      context: context.trim(),
      message: message.trim(),
      detail,
      metadata,
      requestId,
      userId: user.id,
    })
    if (!ok) {
      return apiErrorResponse(500, "Failed to persist event log", { logLabel: "app-logs POST insert" })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return apiErrorResponse(500, "Failed to record event", { cause: err, logLabel: "app-logs POST" })
  }
}

export async function GET(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      return apiClientError(401, "Unauthorized", { log: "warn", logLabel: "app-logs GET" })
    }
    const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single()
    if (profile?.role !== "admin") {
      return apiClientError(403, "Forbidden", { log: "warn", logLabel: "app-logs GET" })
    }

    const { searchParams } = new URL(request.url)
    const limitRaw = searchParams.get("limit")
    const limit = Math.min(200, Math.max(1, Number(limitRaw) || 50))
    const before = searchParams.get("before")
    const severityFilter = searchParams.get("severity")
    const contextPrefix = searchParams.get("context")

    let q = supabase.from("app_event_logs").select("*")
    if (before) {
      q = q.lt("created_at", before)
    }
    if (severityFilter && SEVERITIES.has(severityFilter)) {
      q = q.eq("severity", severityFilter)
    }
    if (contextPrefix?.trim()) {
      q = q.ilike("context", `${contextPrefix.trim()}%`)
    }
    const { data, error } = await q.order("created_at", { ascending: false }).limit(limit)
    if (error) {
      return apiErrorResponse(500, "Failed to load logs", { cause: error, logLabel: "app-logs GET" })
    }
    return NextResponse.json(data ?? [])
  } catch (err) {
    return apiErrorResponse(500, "Failed to load logs", { cause: err, logLabel: "app-logs GET" })
  }
}
