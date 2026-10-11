"use client"

import { useEffect, useMemo, useState } from "react"
import { getSupabaseClient } from "@/lib/supabase/client"
import { fetchRequestDisplayStatuses } from "@/lib/supabase/stock-requests-db"
import {
  displayStatusOrReviewState,
  type RequestDisplayStatus,
  type StockRequestReviewState,
} from "@/lib/stock-request-statuses"

type Row = { id: string; review_state: StockRequestReviewState }

/**
 * Display status per request id. Starts from the review_state mapping so the first
 * paint is never blank, then upgrades `submitted` rows with request_display_status.
 */
export function useRequestDisplayStatuses(rows: Row[]): Record<string, RequestDisplayStatus> {
  const key = useMemo(() => rows.map((r) => `${r.id}:${r.review_state}`).join("|"), [rows])
  const [resolved, setResolved] = useState<{ key: string; statuses: Record<string, RequestDisplayStatus> }>({
    key: "",
    statuses: {},
  })

  useEffect(() => {
    if (!key) return
    let cancelled = false
    void (async () => {
      try {
        const sb = getSupabaseClient()
        const statuses = await fetchRequestDisplayStatuses(
          sb,
          rows.map((r) => ({ id: r.id, review_state: r.review_state }))
        )
        if (!cancelled) setResolved({ key, statuses })
      } catch {
        // Keep the review_state fallback.
      }
    })()
    return () => {
      cancelled = true
    }
    // `rows` is represented by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return useMemo(() => {
    const out: Record<string, RequestDisplayStatus> = {}
    for (const r of rows) {
      out[r.id] =
        resolved.key === key && resolved.statuses[r.id]
          ? resolved.statuses[r.id]
          : displayStatusOrReviewState(null, r.review_state)
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, resolved])
}
