import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "./database.types"
import { getSupabaseClient } from "@/lib/supabase/client"
import type { StockTakeRecord, StockTakeSnapshot } from "@/lib/data"

function getClient(serverClient?: SupabaseClient<Database> | null) {
  return serverClient ?? getSupabaseClient()
}

function rowToRecord(row: { id: string; completed_at: string; result_snapshot: unknown }): StockTakeRecord {
  const snapshot = row.result_snapshot as StockTakeSnapshot
  return {
    id: row.id,
    completedAt: row.completed_at,
    resultSnapshot: snapshot,
  }
}

/** True when the stock_takes table does not exist yet (migration not run). */
function isTableNotFound(error: { code?: string; message?: string } | null): boolean {
  return (error?.code === "PGRST205") || (error?.message?.includes("Could not find the table") ?? false)
}

export async function getAllStockTakes(serverClient?: SupabaseClient<Database> | null): Promise<StockTakeRecord[]> {
  const supabase = getClient(serverClient)
  const { data, error } = await supabase
    .from("stock_takes")
    .select("id, completed_at, result_snapshot")
    .order("completed_at", { ascending: false })
  if (error) {
    if (isTableNotFound(error)) return []
    throw error
  }
  return (data ?? []).map(rowToRecord)
}

export async function getStockTakeById(id: string, serverClient?: SupabaseClient<Database> | null): Promise<StockTakeRecord | null> {
  const supabase = getClient(serverClient)
  const { data, error } = await supabase
    .from("stock_takes")
    .select("id, completed_at, result_snapshot")
    .eq("id", id)
    .single()
  if (error) {
    if (isTableNotFound(error)) return null
    throw error
  }
  if (!data) return null
  return rowToRecord(data)
}

export function isStockTakesTableMissingError(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null
  return (e?.code === "PGRST205") || (e?.message?.includes("Could not find the table") ?? false)
}

export async function createStockTake(snapshot: StockTakeSnapshot, serverClient?: SupabaseClient<Database> | null): Promise<StockTakeRecord> {
  const supabase = getClient(serverClient)
  const id = `ST-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const completedAt = new Date().toISOString()
  const { data, error } = await supabase
    .from("stock_takes")
    .insert({ id, completed_at: completedAt, result_snapshot: snapshot as unknown })
    .select("id, completed_at, result_snapshot")
    .single()
  if (error) throw error
  return rowToRecord(data)
}
