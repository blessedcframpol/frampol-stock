import { loadBatchRequestContext, type BatchRequestContext } from "@/lib/batch-request-context"
import { getSupabaseClient } from "@/lib/supabase/client"
import { fetchAllPages } from "@/lib/supabase/postgrest-page"

/** Max ids per `.in()` so the request URL stays under PostgREST/proxy limits. */
const TXN_ID_CHUNK = 500

export type KitPlacementChange = {
  from: string
  to: string
  at: string
  at_label: string
}

export type KitPlacement = {
  client: string | null
  location: string | null
  kind: string
  start: string
  start_label: string
  end: string
  end_label: string
  duration_days: number | null
  duration_label: string | null
  changes: KitPlacementChange[]
}

export type KitTimelineNote = {
  reason: string | null
  who: string | null
  when: string | null
}

export type KitInvoiceState = {
  status: string
  invoice_number: string | null
  approval: string | null
}

export type KitTimelineEntry = {
  id: string
  sort_at: string
  date_label: string
  kind: string
  title: string
  detail: string | null
  who: string | null
  reversed: boolean
  voided: boolean
  reversal: KitTimelineNote | null
  restore: KitTimelineNote | null
  invoice: KitInvoiceState | null
  requestContext?: BatchRequestContext | null
}

export type KitHistoryLink = {
  label: string
  href: string
}

export type KitHistory = {
  found: boolean
  item_id?: string
  serial?: string
  product?: string | null
  status?: string
  summary?: string
  tags?: string[]
  placements?: KitPlacement[]
  timeline?: KitTimelineEntry[]
  links?: KitHistoryLink[]
}

const historyCache = new Map<string, KitHistory>()
const inflight = new Map<string, Promise<KitHistory | null>>()

export function fetchKitHistory(itemId: string): Promise<KitHistory | null> {
  const cached = historyCache.get(itemId)
  if (cached) return Promise.resolve(cached)
  const pending = inflight.get(itemId)
  if (pending) return pending
  const request = Promise.resolve(getSupabaseClient().rpc("kit_history", { p_item_id: itemId }))
    .then(async ({ data, error }) => {
      inflight.delete(itemId)
      if (error) throw error
      const history = (data ?? { found: false }) as unknown as KitHistory
      if (history.found) {
        const enriched = await attachRequestContext(history)
        historyCache.set(itemId, enriched)
        return enriched
      }
      return history
    })
    .catch((error: unknown) => {
      inflight.delete(itemId)
      throw error
    })
  inflight.set(itemId, request)
  return request
}

async function attachRequestContext(history: KitHistory): Promise<KitHistory> {
  const timeline = history.timeline ?? []
  if (timeline.length === 0) return history
  const supabase = getSupabaseClient()
  // Timeline entry ids that are transaction ids (case/audit synthetic ids are skipped by the join).
  const txnIds = [...new Set(timeline.map((entry) => entry.id).filter(Boolean))]
  const batchByTxn = new Map<string, string>()
  for (let index = 0; index < txnIds.length; index += TXN_ID_CHUNK) {
    const chunk = txnIds.slice(index, index + TXN_ID_CHUNK)
    // Scoped by id list (not a full-table scan). fetchAllPages + unique order so >1000 ids
    // in one chunk cannot truncate mid-page.
    const rows = await fetchAllPages((from, to) =>
      supabase
        .from("transactions")
        .select("id, batch_id")
        .in("id", chunk)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    )
    for (const row of rows) {
      batchByTxn.set(row.id, row.batch_id?.trim() || row.id)
    }
  }
  const requestByBatch = await loadBatchRequestContext(supabase, batchByTxn.values())
  return {
    ...history,
    timeline: timeline.map((entry) => {
      const batchId = batchByTxn.get(entry.id)
      if (!batchId) return entry
      return {
        ...entry,
        requestContext: requestByBatch.get(batchId) ?? null,
      }
    }),
  }
}

export async function fetchKitHistoryBySerial(serial: string): Promise<KitHistory | null> {
  const trimmed = serial.trim()
  if (!trimmed) return null
  const { data, error } = await getSupabaseClient()
    .from("inventory_items")
    .select("id")
    .eq("serial_number", trimmed)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (!data?.id) return { found: false }
  return fetchKitHistory(data.id)
}
