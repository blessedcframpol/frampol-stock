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

/** Shared across dashboard widgets so AdminTodoRow + LatestRequests share one RPC. */
const statusCache = new Map<string, RequestDisplayStatus>()
let pendingRows: Row[] = []
let inflight: Promise<void> | null = null
const COALESCE_MS = 120

function cacheSnapshot(ids: string[]): Record<string, RequestDisplayStatus> {
  const out: Record<string, RequestDisplayStatus> = {}
  for (const id of ids) {
    const hit = statusCache.get(id)
    if (hit) out[id] = hit
  }
  return out
}

async function enqueueStatusFetch(rows: Row[]): Promise<Record<string, RequestDisplayStatus>> {
  const needServer = rows.filter((r) => r.review_state === "submitted")
  const ids = needServer.map((r) => r.id)
  const missing = needServer.filter((r) => !statusCache.has(r.id))
  if (missing.length === 0) {
    return cacheSnapshot(ids)
  }

  pendingRows.push(...missing)
  if (!inflight) {
    inflight = (async () => {
      // Wait briefly so sibling dashboard widgets can enqueue their ids too.
      await new Promise((resolve) => setTimeout(resolve, COALESCE_MS))
      while (pendingRows.length > 0) {
        const batch = pendingRows
        pendingRows = []
        const unique = new Map<string, Row>()
        for (const row of batch) {
          if (!statusCache.has(row.id)) unique.set(row.id, row)
        }
        const toFetch = [...unique.values()]
        if (toFetch.length === 0) continue
        const sb = getSupabaseClient()
        const statuses = await fetchRequestDisplayStatuses(sb, toFetch)
        for (const [id, status] of Object.entries(statuses)) {
          statusCache.set(id, status)
        }
      }
      inflight = null
    })()
  }
  await inflight
  return cacheSnapshot(ids)
}

/** Drop cached statuses (e.g. sign-out). */
export function clearRequestDisplayStatusCache() {
  statusCache.clear()
}

/**
 * Display status per request id. Starts from the review_state mapping so the first
 * paint is never blank, then upgrades `submitted` rows with request_display_statuses.
 * Concurrent dashboard callers share one RPC (AdminTodo + LatestRequests).
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
    void enqueueStatusFetch(rows)
      .then((statuses) => {
        if (!cancelled) setResolved({ key, statuses })
      })
      .catch(() => {
        // Keep the review_state fallback.
      })
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
          : statusCache.get(r.id) ?? displayStatusOrReviewState(null, r.review_state)
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, resolved])
}
