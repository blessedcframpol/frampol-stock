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

export async function GET() {
  try {
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
    const admin = createAdminClient()
    const { data: profiles, error } = await admin
      .from("profiles")
      .select("id, email, display_name, role, active, created_at")
      .order("email")
    if (error) {
      console.error("Admin profiles list error:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json(profiles ?? [])
  } catch (err) {
    console.error("Admin profiles GET error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
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
    const body = await request.json() as { email: string; password: string; display_name?: string; role?: string }
    const { email, password, display_name, role } = body
    if (!email?.trim() || !password) {
      return NextResponse.json({ error: "email and password required" }, { status: 400 })
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
      user_metadata: { display_name: display_name?.trim() || null, role: appRole },
    })
    if (createError) {
      console.error("Admin create user error:", createError)
      return NextResponse.json({ error: createError.message }, { status: 400 })
    }
    if (!newUser.user) {
      return NextResponse.json({ error: "User not created" }, { status: 500 })
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
      console.error("Admin profile update after create error:", profileError)
      return NextResponse.json({ error: profileError.message }, { status: 500 })
    }
    const { data: updatedProfile } = await admin
      .from("profiles")
      .select("id, email, display_name, role, active, created_at")
      .eq("id", newUser.user.id)
      .single()
    return NextResponse.json(updatedProfile ?? { id: newUser.user.id, email: newUser.user.email, role: appRole, active: true }, { status: 201 })
  } catch (err) {
    console.error("Admin profiles POST error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
