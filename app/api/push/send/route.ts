import { timingSafeEqual } from "crypto"
import { NextRequest, NextResponse } from "next/server"
import { sendNotification, setVapidDetails } from "web-push"
import { createAdminClient } from "@/lib/supabase/admin"
import { insertAppEventLogRow } from "@/lib/app-event-log-server"
import {
  buildPushPayload,
  prefsAllowType,
  type DesktopPushPrefs,
} from "@/lib/web-push"

export const runtime = "nodejs"

function safeEqual(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a)
    const bb = Buffer.from(b)
    if (ba.length !== bb.length) return false
    return timingSafeEqual(ba, bb)
  } catch {
    return false
  }
}

function authorize(req: NextRequest): boolean {
  const expected = process.env.PUSH_SEND_SECRET?.trim()
  if (!expected) return false
  const header = req.headers.get("authorization") || ""
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
  const alt = req.headers.get("x-push-send-secret")?.trim() || ""
  return (bearer.length > 0 && safeEqual(bearer, expected)) || (alt.length > 0 && safeEqual(alt, expected))
}

function configureVapid(): boolean {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim()
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim()
  const subject = process.env.VAPID_SUBJECT?.trim() || "mailto:ops@frampolafrica.com"
  if (!publicKey || !privateKey) return false
  setVapidDetails(subject, publicKey, privateKey)
  return true
}

async function logPush(
  admin: ReturnType<typeof createAdminClient>,
  input: {
    severity: "error" | "warn" | "info"
    message: string
    metadata?: Record<string, unknown>
    userId: string
  },
) {
  try {
    await insertAppEventLogRow(admin, {
      severity: input.severity,
      source: "api",
      context: "push_send",
      message: input.message,
      metadata: input.metadata ?? null,
      userId: input.userId,
    })
  } catch {
    // ignore
  }
}

export async function POST(request: NextRequest) {
  if (!authorize(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  if (!configureVapid()) {
    return NextResponse.json({ error: "VAPID not configured" }, { status: 503 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  const notificationId =
    typeof body === "object" &&
    body !== null &&
    typeof (body as { notification_id?: unknown }).notification_id === "string"
      ? (body as { notification_id: string }).notification_id.trim()
      : ""
  if (!notificationId) {
    return NextResponse.json({ error: "notification_id required" }, { status: 400 })
  }

  const admin = createAdminClient()

  const { data: note, error: noteErr } = await admin
    .from("notifications")
    .select("id, user_id, type, title, body, metadata")
    .eq("id", notificationId)
    .maybeSingle()

  if (noteErr || !note) {
    return NextResponse.json({ ok: true, skipped: "missing" })
  }

  const { data: profile } = await admin
    .from("profiles")
    .select(
      "desktop_push_enabled, desktop_push_new_requests, desktop_push_reminders, desktop_push_my_request_updated",
    )
    .eq("id", note.user_id)
    .maybeSingle()

  const prefs: DesktopPushPrefs = {
    enabled: profile?.desktop_push_enabled === true,
    newRequests: profile?.desktop_push_new_requests !== false,
    reminders: profile?.desktop_push_reminders !== false,
    myRequestUpdated: profile?.desktop_push_my_request_updated !== false,
  }

  if (!prefsAllowType(prefs, note.type) && note.type !== "push_test") {
    return NextResponse.json({ ok: true, skipped: "prefs" })
  }
  // push_test always allowed when enabled
  if (note.type === "push_test" && !prefs.enabled) {
    return NextResponse.json({ ok: true, skipped: "prefs" })
  }

  const meta = (note.metadata ?? {}) as Record<string, unknown>
  const requestId = typeof meta.request_id === "string" ? meta.request_id : null
  const requestNumber =
    typeof meta.request_number === "string"
      ? meta.request_number
      : typeof meta.request_number === "number"
        ? String(meta.request_number)
        : null
  const href = typeof meta.href === "string" ? meta.href : null

  const payload = buildPushPayload({
    notificationId: note.id,
    type: note.type,
    requestNumber,
    requestId,
    href,
  })

  const { data: subs, error: subErr } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", note.user_id)

  if (subErr) {
    await logPush(admin, {
      severity: "error",
      message: "failed to load subscriptions",
      metadata: { reason: "subs_query" },
      userId: note.user_id,
    })
    return NextResponse.json({ error: "subs" }, { status: 500 })
  }

  if (!subs || subs.length === 0) {
    return NextResponse.json({ ok: true, sent: 0 })
  }

  let sent = 0
  let dead = 0
  for (const row of subs) {
    try {
      await sendNotification(
        {
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth },
        },
        JSON.stringify(payload),
        { TTL: 60 * 60 },
      )
      sent += 1
      await admin
        .from("push_subscriptions")
        .update({ last_success_at: new Date().toISOString() })
        .eq("id", row.id)
    } catch (err: unknown) {
      const statusCode =
        typeof err === "object" && err !== null && "statusCode" in err
          ? Number((err as { statusCode: number }).statusCode)
          : 0
      if (statusCode === 404 || statusCode === 410) {
        await admin.from("push_subscriptions").delete().eq("id", row.id)
        dead += 1
        await logPush(admin, {
          severity: "info",
          message: "removed dead subscription",
          metadata: { reason: "gone", statusCode },
          userId: note.user_id,
        })
      } else {
        await logPush(admin, {
          severity: "warn",
          message: "push send failed",
          metadata: {
            reason: "send_error",
            statusCode: statusCode || null,
          },
          userId: note.user_id,
        })
      }
    }
  }

  return NextResponse.json({ ok: true, sent, dead })
}
