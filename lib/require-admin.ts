import type { User } from "@supabase/supabase-js"
import type { NextResponse } from "next/server"
import { apiClientError } from "@/lib/api-error-response"
import { ADMIN } from "@/lib/permissions"
import { createServerSupabaseClient, type AppSupabaseClient } from "@/lib/supabase/server"

export type AdminGateProfile = {
  role: string | null
  active: boolean
}

export type RequireAdminResult =
  | { ok: true; user: User; profile: AdminGateProfile; supabase: AppSupabaseClient }
  | { ok: false; response: NextResponse }

/**
 * Resolve the current session and require an active admin.
 *
 * Status / body (same as the previous route preambles):
 * - no session → 401 `{ error: "Unauthorized", requestId }`
 * - missing / inactive / non-admin profile → 403 `{ error: forbiddenMessage, requestId }`
 *
 * `get_my_role()` returns NULL unless `active = true`; this helper matches that.
 */
export async function requireAdmin(options?: {
  logLabel?: string
  forbiddenMessage?: string
}): Promise<RequireAdminResult> {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      ok: false,
      response: apiClientError(401, "Unauthorized", {
        log: "warn",
        ...(options?.logLabel ? { logLabel: options.logLabel } : {}),
      }),
    }
  }

  const { data: profileRow } = await supabase
    .from("profiles")
    .select("role, active")
    .eq("id", user.id)
    .single()

  const profile = profileRow as AdminGateProfile | null
  if (!profile?.active || profile.role !== ADMIN) {
    return {
      ok: false,
      response: apiClientError(403, options?.forbiddenMessage ?? "Forbidden", {
        log: "warn",
        ...(options?.logLabel ? { logLabel: options.logLabel } : {}),
      }),
    }
  }

  return { ok: true, user, profile, supabase }
}
