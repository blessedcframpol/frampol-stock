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

export async function GET() {
  try {
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
    const admin = createAdminClient()
    const { data: profiles, error } = await admin
      .from("profiles")
      .select("id, email, display_name, role, active, created_at")
      .order("email")
    if (error) {
      return apiErrorResponse(500, "Could not load user list", {
        cause: error,
        logLabel: "Admin profiles list",
      })
    }
    return NextResponse.json(profiles ?? [])
  } catch (err) {
    return apiErrorResponse(500, "Internal server error", { cause: err, logLabel: "Admin profiles GET" })
  }
}

export async function POST(request: NextRequest) {
  try {
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
    const body = await request.json() as { email: string; password: string; display_name?: string; role?: string }
    const { email, password, display_name, role } = body
    if (!email?.trim() || !password) {
      return apiClientError(400, "email and password required")
    }
    const validRoles = ["admin", "sales", "accounts", "technicians"] as const
    const appRole = role && validRoles.includes(role as (typeof validRoles)[number])
      ? (role as (typeof validRoles)[number])
      : "technicians"
    const admin = createAdminClient()
    const { data: newUser, error: createError } = await admin.auth.admin.createUser({
      email: email.trim(),
      password,
      email_confirm: true,
      user_metadata: { display_name: display_name?.trim() || null },
    })
    if (createError) {
      return apiClientError(400, createError.message, { log: "warn", logLabel: "Admin create user" })
    }
    if (!newUser.user) {
      return apiErrorResponse(500, "User not created", { logLabel: "Admin create user: no user in response" })
    }
    const { error: profileError } = await admin
      .from("profiles")
      .update({
        display_name: display_name?.trim() || null,
        role: appRole,
        updated_at: new Date().toISOString(),
      })
      .eq("id", newUser.user.id)
    if (profileError) {
      return apiErrorResponse(500, "User was created but profile could not be updated", {
        cause: profileError,
        logLabel: "Admin profile update after create",
      })
    }
    const { data: updatedProfile } = await admin
      .from("profiles")
      .select("id, email, display_name, role, active, created_at")
      .eq("id", newUser.user.id)
      .single()
    return NextResponse.json(updatedProfile ?? { id: newUser.user.id, email: newUser.user.email, role: appRole, active: true }, { status: 201 })
  } catch (err) {
    return apiErrorResponse(500, "Internal server error", { cause: err, logLabel: "Admin profiles POST" })
  }
}
