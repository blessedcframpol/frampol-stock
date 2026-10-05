import { getSupabaseClient } from "@/lib/supabase/client"

export async function changeStockPool(itemId: string, pool: "sale" | "rental" | "demo", reason: string): Promise<void> {
  const { error } = await getSupabaseClient().rpc("change_stock_pool", {
    p_item_id: itemId,
    p_pool: pool,
    p_reason: reason,
  })
  if (error) throw new Error(error.message)
}

export async function changeStockPools(
  itemIds: string[],
  pool: "sale" | "rental" | "demo",
  reason: string,
): Promise<void> {
  const { error } = await getSupabaseClient().rpc("change_stock_pools", {
    p_item_ids: itemIds,
    p_pool: pool,
    p_reason: reason,
  })
  if (error) throw new Error(error.message)
}

export type StockPoolChange = {
  id: string
  fromPool: string
  toPool: string
  reason: string
  changedAt: string
}

export async function loadStockPoolChanges(itemId: string): Promise<StockPoolChange[]> {
  const { data, error } = await getSupabaseClient()
    .from("stock_pool_changes")
    .select("id, from_pool, to_pool, reason, changed_at")
    .eq("inventory_item_id", itemId)
    .order("changed_at", { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []).map((row) => ({
    id: row.id,
    fromPool: row.from_pool,
    toPool: row.to_pool,
    reason: row.reason,
    changedAt: row.changed_at,
  }))
}
