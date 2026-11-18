"use client"

/**
 * NT3 — register SW, subscribe PushManager, upsert push_subscriptions.
 */
import { getSupabaseClient } from "@/lib/supabase/client"

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/")
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export async function ensurePushServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return null
  try {
    return await navigator.serviceWorker.register("/sw.js", { scope: "/" })
  } catch {
    return null
  }
}

export function vapidPublicKeyFromEnv(): string | null {
  const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim()
  return key || null
}

export async function subscribeDesktopPush(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const vapid = vapidPublicKeyFromEnv()
  if (!vapid) return { ok: false, error: "Push is not configured (missing public key)." }
  if (!("Notification" in window) || !("PushManager" in window)) {
    return { ok: false, error: "This browser does not support desktop pop-ups." }
  }
  const permission = await Notification.requestPermission()
  if (permission !== "granted") {
    return { ok: false, error: "Permission denied — allow notifications in the browser." }
  }
  const reg = await ensurePushServiceWorker()
  if (!reg) return { ok: false, error: "Could not register the service worker." }
  await navigator.serviceWorker.ready

  let sub: PushSubscription
  try {
    sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid) as BufferSource,
      }))
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Could not subscribe to push",
    }
  }

  const json = sub.toJSON()
  const endpoint = json.endpoint
  const p256dh = json.keys?.p256dh
  const auth = json.keys?.auth
  if (!endpoint || !p256dh || !auth) {
    return { ok: false, error: "Subscription keys missing." }
  }

  try {
    const sb = getSupabaseClient()
    const {
      data: { user },
    } = await sb.auth.getUser()
    if (!user) return { ok: false, error: "Not signed in." }

    const { error } = await sb.from("push_subscriptions").upsert(
      {
        user_id: user.id,
        endpoint,
        p256dh,
        auth,
        user_agent: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 500) : null,
      },
      { onConflict: "endpoint" },
    )
    if (error) return { ok: false, error: error.message }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Save failed" }
  }
}

export async function unsubscribeDesktopPush(): Promise<void> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    const sub = await reg?.pushManager.getSubscription()
    const endpoint = sub?.endpoint
    if (sub) await sub.unsubscribe()
    if (endpoint) {
      const sb = getSupabaseClient()
      await sb.from("push_subscriptions").delete().eq("endpoint", endpoint)
    }
  } catch {
    // ignore
  }
}

export async function hasActivePushSubscription(): Promise<boolean> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return false
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    const sub = await reg?.pushManager.getSubscription()
    return Boolean(sub)
  } catch {
    return false
  }
}
