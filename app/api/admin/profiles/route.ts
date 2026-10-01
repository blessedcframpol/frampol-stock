import { NextResponse } from "next/server"
import { apiClientError, apiErrorResponse } from "@/lib/api-error-response"
import { requireAdmin } from "@/lib/require-admin"
import { createAdminClient, isAdminApiConfigured } from "@/lib/supabase/admin"

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
