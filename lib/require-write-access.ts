import type { User } from "@supabase/supabase-js"
import type { NextResponse } from "next/server"
import { apiClientError } from "@/lib/api-error-response"
import {
  ACCOUNTS,
  ADMIN,
  SALES,
  TECHNICIANS,
  type AppRole,
} from "@/lib/permissions"
import {
  createServerSupabaseClient,
  type AppSupabaseClient,
} from "@/lib/supabase/server"

const WRITE_ROLES: readonly AppRole[] = [
  ADMIN,
  SALES,
  ACCOUNTS,
  TECHNICIANS,
]

export type RequireWriteAccessResult =
  | { ok: true; user: User; role: AppRole; supabase: AppSupabaseClient }
  | { ok: false; response: NextResponse }

/** Reject inactive, unassigned, and viewer accounts before any API mutation. */
export async function requireWriteAccess(
  logLabel: string
): Promise<RequireWriteAccessResult> {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      ok: false,
      response: apiClientError(401, "Unauthorized", { log: "warn", logLabel }),
    }
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, active")
    .eq("id", user.id)
    .single()
  const role = profile?.active ? (profile.role as AppRole | null) : null
  if (!role || !WRITE_ROLES.includes(role)) {
    return {
      ok: false,
      response: apiClientError(403, "Read-only accounts cannot perform this action", {
        log: "warn",
        logLabel,
      }),
    }
  }

  return { ok: true, user, role, supabase }
}
