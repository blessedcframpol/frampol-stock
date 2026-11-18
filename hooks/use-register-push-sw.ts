"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { ensurePushServiceWorker } from "@/lib/push-subscribe"

/** Register SW when signed in; handle navigate messages from notificationclick. */
export function useRegisterPushServiceWorker(enabled: boolean) {
  const router = useRouter()

  useEffect(() => {
    if (!enabled) return
    void ensurePushServiceWorker()

    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; href?: string } | null
      if (!data || data.type !== "fram-stock:navigate") return
      if (typeof data.href === "string" && data.href.startsWith("/") && !data.href.startsWith("//")) {
        router.push(data.href)
      }
    }
    navigator.serviceWorker?.addEventListener("message", onMessage)
    return () => {
      navigator.serviceWorker?.removeEventListener("message", onMessage)
    }
  }, [enabled, router])
}
