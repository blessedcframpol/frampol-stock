import { getSupabaseClient } from "@/lib/supabase/client"

/** One row from public.stock_availability: counts only, never serials or locations. */
export type StockAvailabilityRow = {
  product_id: string
  product_name: string
  vendor: string | null
  available_count: number
  reorder_level: number
  is_low: boolean
}

/** Available sale-pool units per product, optionally filtered by product or vendor text. */
export async function fetchStockAvailability(query?: string | null): Promise<StockAvailabilityRow[]> {
  const q = query?.trim()
  const { data, error } = await getSupabaseClient().rpc("stock_availability", {
    p_query: q ? q : null,
  })
  if (error) throw error
  return (data ?? []) as StockAvailabilityRow[]
}

/** product_id → available count. */
export function availabilityByProductId(rows: StockAvailabilityRow[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const row of rows) out[row.product_id] = row.available_count
  return out
}

/** Soft warning (never blocks) when a request asks for more than is in stock. */
export function overRequestWarning(quantity: number, available: number | null | undefined): string | null {
  if (available == null || !Number.isFinite(quantity)) return null
  if (quantity <= available) return null
  return `Only ${available} in stock — the rest may be issued later.`
}
