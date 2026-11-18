import { NextResponse } from "next/server"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { apiClientError } from "@/lib/api-error-response"

/**
 * NT3: signed-in user inserts a push_test notification for themselves,
 * then invokes /api/push/send (same path as pg_net).
 */
export async function POST() {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return apiClientError(401, "Unauthorized", { log: "warn", logLabel: "push-test" })
  }

  const admin = createAdminClient()
  const { data: note, error } = await admin
    .from("notifications")
    .insert({
      user_id: user.id,
      type: "push_test",
      title: "Test desktop pop-up",
      body: "If this appears as an OS pop-up, Web Push is working.",
      metadata: { href: "/settings", request_number: "TEST" },
    })
    .select("id")
    .single()

  if (error || !note) {
    return apiClientError(500, error?.message ?? "Could not create test notification", {
      log: "error",
      logLabel: "push-test insert",
    })
  }

  const secret = process.env.PUSH_SEND_SECRET?.trim()
  const base =
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.VERIFY_APP_URL?.trim() ||
    "http://localhost:3000"

  if (!secret) {
    return NextResponse.json({
      ok: false,
      notificationId: note.id,
      error: "PUSH_SEND_SECRET not configured",
    })
  }

  const res = await fetch(`${base.replace(/\/$/, "")}/api/push/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ notification_id: note.id }),
  })
  const json = await res.json().catch(() => ({}))
  return NextResponse.json({
    ok: res.ok,
    notificationId: note.id,
    sendStatus: res.status,
    send: json,
  })
}
