import { NextRequest, NextResponse } from "next/server"
import { apiClientError, apiErrorResponse } from "@/lib/api-error-response"
import { createServerSupabaseClient } from "@/lib/supabase/server"

function clientIp(request: NextRequest): string | null {
  const forwarded = request.headers.get("x-forwarded-for")
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim()
    if (first) return first.slice(0, 128)
  }
  const realIp = request.headers.get("x-real-ip")?.trim()
  return realIp ? realIp.slice(0, 128) : null
}

/** One audit_log sign_in row after Microsoft OAuth (auth callback). Not for page loads or token refresh. */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      return apiClientError(401, "Unauthorized", { log: "warn", logLabel: "audit sign-in POST" })
    }

    const ua = request.headers.get("user-agent")?.trim().slice(0, 512) || null
    const ip = clientIp(request)

    const { data, error } = await supabase.rpc("record_sign_in", {
      p_ip: ip,
      p_user_agent: ua,
    })
    if (error) {
      return apiErrorResponse(500, error.message || "Could not record sign-in", {
        cause: error,
        logLabel: "audit sign-in POST",
      })
    }

    return NextResponse.json({ ok: true, id: data })
  } catch (cause) {
    return apiErrorResponse(500, "Could not record sign-in", {
      cause,
      logLabel: "audit sign-in POST",
    })
  }
}
