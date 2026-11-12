"use client"

import { useEffect, useMemo, useState } from "react"
import { getSupabaseClient } from "@/lib/supabase/client"
import { fetchRequestDisplayStatuses } from "@/lib/supabase/stock-requests-db"
import { REQUEST_QUEUES_REFRESH_EVENT } from "@/lib/notifications-live"
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
 *
 * NT2: stock_requests Realtime can change display status without changing review_state
 * (still "submitted" after a full issue). Drop cache + re-fetch on queue refresh.
 */
export function useRequestDisplayStatuses(rows: Row[]): Record<string, RequestDisplayStatus> {
  const idsKey = useMemo(() => rows.map((r) => `${r.id}:${r.review_state}`).join("|"), [rows])
  const [epoch, setEpoch] = useState(0)
  const key = `${idsKey}|e${epoch}`
  const [resolved, setResolved] = useState<{ key: string; statuses: Record<string, RequestDisplayStatus> }>({
    key: "",
    statuses: {},
  })

  useEffect(() => {
    const onQueues = () => {
      for (const r of rows) statusCache.delete(r.id)
      setEpoch((n) => n + 1)
    }
    window.addEventListener(REQUEST_QUEUES_REFRESH_EVENT, onQueues)
    return () => window.removeEventListener(REQUEST_QUEUES_REFRESH_EVENT, onQueues)
    // rows identity changes often; idsKey covers membership.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey])

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
