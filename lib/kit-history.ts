import { getSupabaseClient } from "@/lib/supabase/client"

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
  const request = getSupabaseClient()
    .rpc("kit_history", { p_item_id: itemId })
    .then(({ data, error }: { data: KitHistory | null; error: { message: string } | null }) => {
      inflight.delete(itemId)
      if (error) throw error
      const history = (data ?? { found: false }) as KitHistory
      if (history.found) historyCache.set(itemId, history)
      return history
    })
    .catch((error: unknown) => {
      inflight.delete(itemId)
      throw error
    })
  inflight.set(itemId, request)
  return request
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
