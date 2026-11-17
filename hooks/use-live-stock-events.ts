"use client"

/**
 * RT1: one Realtime event per stock batch → debounce → dashboard + incremental ledger.
 */
import { useEffect, useRef } from "react"
import { getSupabaseClient } from "@/lib/supabase/client"
import { useAuth } from "@/lib/auth-context"
import { announceLiveStockBatches } from "@/lib/realtime-live"

const DEBOUNCE_MS = 1_500

export function useLiveStockEvents(enabled = true) {
  const { user } = useAuth()
  const timerRef = useRef<number | undefined>(undefined)
  const pendingBatchesRef = useRef<Set<string>>(new Set())
  const maxCreatedAtRef = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled || !user?.id) return
    let sb: ReturnType<typeof getSupabaseClient>
    try {
      sb = getSupabaseClient()
    } catch {
      return
    }

    const flush = () => {
      timerRef.current = undefined
      const ids = [...pendingBatchesRef.current]
      const maxCreatedAt = maxCreatedAtRef.current
      pendingBatchesRef.current.clear()
      maxCreatedAtRef.current = null
      if (ids.length > 0) announceLiveStockBatches(ids, maxCreatedAt)
    }

    const queue = (batchId: string | null | undefined, createdAt: string | null | undefined) => {
      const id = typeof batchId === "string" ? batchId.trim() : ""
      if (!id) return
      pendingBatchesRef.current.add(id)
      if (createdAt) {
        const prev = maxCreatedAtRef.current
        if (!prev || Date.parse(createdAt) > Date.parse(prev)) {
          maxCreatedAtRef.current = createdAt
        }
      }
      if (timerRef.current) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(flush, DEBOUNCE_MS)
    }

    const channel = sb
      .channel(`live_stock_events:${user.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "live_stock_events" },
        (payload) => {
          const row = payload.new as { batch_id?: string; created_at?: string }
          queue(row.batch_id, row.created_at)
        },
      )
      .subscribe()

    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current)
      void sb.removeChannel(channel)
    }
  }, [enabled, user?.id])
}
