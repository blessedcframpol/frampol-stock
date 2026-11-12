"use client"

/**
 * NT2 P2: Realtime on stock_requests (RLS-scoped) drives queue soft-refresh.
 * Notification INSERT remains a fallback via REQUEST_QUEUES_REFRESH_EVENT.
 */
import { useEffect, useRef } from "react"
import { getSupabaseClient } from "@/lib/supabase/client"
import { useAuth } from "@/lib/auth-context"
import { announceRequestQueuesRefresh } from "@/lib/notifications-live"

const DEBOUNCE_MS = 400

export function useStockRequestsRealtime(enabled = true) {
  const { user } = useAuth()
  const timerRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!enabled || !user?.id) return
    let sb: ReturnType<typeof getSupabaseClient>
    try {
      sb = getSupabaseClient()
    } catch {
      return
    }

    const bump = () => {
      if (timerRef.current) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => {
        announceRequestQueuesRefresh()
      }, DEBOUNCE_MS)
    }

    const channel = sb
      .channel(`stock_requests:live:${user.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "stock_requests" },
        () => bump(),
      )
      .subscribe()

    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current)
      void sb.removeChannel(channel)
    }
  }, [enabled, user?.id])
}
