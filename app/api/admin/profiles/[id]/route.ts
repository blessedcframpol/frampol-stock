import { NextRequest, NextResponse } from "next/server"
import { apiClientError, apiErrorResponse } from "@/lib/api-error-response"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { createAdminClient, isAdminApiConfigured } from "@/lib/supabase/admin"

function adminConfigError() {
  return apiClientError(
    503,
    "Admin features need SUPABASE_SERVICE_ROLE_KEY in .env.local (Supabase Dashboard → Settings → API → service_role). Restart next dev after adding it."
  )
}

export async function PATCH(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!id) {
      return apiClientError(400, "id required")
    }
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return apiClientError(401, "Unauthorized", { log: "warn" })
    }
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single()
    if (profile?.role !== "admin") {
      return apiClientError(403, "Forbidden", { log: "warn" })
    }
    if (!isAdminApiConfigured()) {
      return adminConfigError()
    }
    const body = await _request.json() as { role?: string; active?: boolean; display_name?: string }
    const updates: {
      role?: string
      active?: boolean
      display_name?: string | null
      updated_at: string
    } = {
      updated_at: new Date().toISOString(),
    }
    const validRoles = ["admin", "sales", "accounts", "technicians"] as const
    if (body.role !== undefined) {
      if (validRoles.includes(body.role as (typeof validRoles)[number])) {
        updates.role = body.role
      }
    }
    if (body.active !== undefined) {
      updates.active = Boolean(body.active)
    }
    if (body.display_name !== undefined) {
      updates.display_name = typeof body.display_name === "string" ? body.display_name.trim() || null : undefined
    }
    const admin = createAdminClient()
    const { data, error } = await admin
      .from("profiles")
      .update(updates)
      .eq("id", id)
      .select("id, email, display_name, role, active, updated_at")
      .single()
    if (error) {
      return apiClientError(400, error.message, { log: "warn", logLabel: "Admin profile update" })
    }
    return NextResponse.json(data)
  } catch (err) {
    return apiErrorResponse(500, "Internal server error", { cause: err, logLabel: "Admin profile PATCH" })
  }
}
