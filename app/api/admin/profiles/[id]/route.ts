import { NextRequest, NextResponse } from "next/server"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { createAdminClient, isAdminApiConfigured } from "@/lib/supabase/admin"

const adminConfigError = NextResponse.json(
  {
    error:
      "Admin features need SUPABASE_SERVICE_ROLE_KEY in .env.local (Supabase Dashboard → Settings → API → service_role). Restart next dev after adding it.",
  },
  { status: 503 }
)

export async function PATCH(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!id) {
      return NextResponse.json({ error: "id required" }, { status: 400 })
    }
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single()
    if (profile?.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }
    if (!isAdminApiConfigured()) {
      return adminConfigError
    }
    const body = await _request.json() as { role?: string; active?: boolean; display_name?: string }
    const updates: { role?: string; active?: boolean; display_name?: string; updated_at: string } = {
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
      console.error("Admin profile update error:", error)
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    return NextResponse.json(data)
  } catch (err) {
    console.error("Admin profile PATCH error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
