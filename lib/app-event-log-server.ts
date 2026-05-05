import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database, Json } from "@/lib/supabase/database.types"

export type AppEventSeverity = "error" | "warn" | "info"
export type AppEventSource = "client" | "api"

export type InsertAppEventInput = {
  severity: AppEventSeverity
  source: AppEventSource
  context: string
  message: string
  detail?: string | null
  metadata?: Json | Record<string, unknown> | null
  requestId?: string | null
  userId: string
}

const MAX_METADATA_BYTES = 32_000

function truncateMetadata(meta: InsertAppEventInput["metadata"]): Json | null {
  if (meta == null) return null
  const s = JSON.stringify(meta)
  if (s.length <= MAX_METADATA_BYTES) return meta as Json
  return {
    _truncated: true,
    _originalLength: s.length,
    preview: s.slice(0, Math.min(4000, MAX_METADATA_BYTES - 200)),
  } as Json
}

/** Insert one row. Returns false on DB error (logs to console). */
export async function insertAppEventLogRow(
  supabase: SupabaseClient<Database>,
  input: InsertAppEventInput
): Promise<boolean> {
  const { error } = await supabase.from("app_event_logs").insert({
    severity: input.severity,
    source: input.source,
    context: input.context.slice(0, 512),
    message: input.message.slice(0, 8000),
    detail: input.detail?.slice(0, 16000) ?? null,
    metadata: truncateMetadata(input.metadata),
    request_id: input.requestId?.slice(0, 128) ?? null,
    user_id: input.userId,
  })
  if (error) {
    console.error("[app_event_logs insert]", error.message)
    return false
  }
  return true
}

/** Non-blocking: log a server 5xx response to `app_event_logs` (skips if unauthenticated or self app-logs route). */
export function scheduleApiErrorAppEventLog(input: {
  status: number
  requestId: string
  message: string
  detail?: string | undefined
  logLabel?: string | undefined
}): void {
  if (input.status < 500) return
  const label = input.logLabel ?? ""
  if (label.startsWith("app-logs")) return

  void (async () => {
    try {
      const { createServerSupabaseClient } = await import("@/lib/supabase/server")
      const supabase = await createServerSupabaseClient()
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) return
      await insertAppEventLogRow(supabase, {
        severity: "error",
        source: "api",
        context: label ? label.slice(0, 512) : "api_error",
        message: input.message.slice(0, 8000),
        detail: input.detail ?? null,
        metadata: { httpStatus: input.status } as Json,
        requestId: input.requestId,
        userId: user.id,
      })
    } catch {
      /* never throw from background log */
    }
  })()
}
