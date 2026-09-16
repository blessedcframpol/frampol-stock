import { NextRequest, NextResponse } from "next/server"
import { apiClientError, apiErrorResponse } from "@/lib/api-error-response"
import { requireAdmin } from "@/lib/require-admin"
import { createAdminClient, isAdminApiConfigured } from "@/lib/supabase/admin"

const MIN_PASSWORD_LENGTH = 12

function adminConfigError() {
  return apiClientError(
    503,
    "Admin features need SUPABASE_SERVICE_ROLE_KEY on the server (Supabase Dashboard → Project Settings → API → service_role). Add it to .env.local for local, or your host’s environment variables for production, then redeploy/restart."
  )
}

export async function GET() {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response
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
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response
    if (!isAdminApiConfigured()) {
      return adminConfigError()
    }
    const body = await request.json() as { email: string; password: string; display_name?: string; role?: string }
    const { email, display_name, role } = body
    const password = typeof body.password === "string" ? body.password : ""
    if (!email?.trim() || !password.trim()) {
      return apiClientError(400, "email and password required")
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return apiClientError(400, `password must be at least ${MIN_PASSWORD_LENGTH} characters`)
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
