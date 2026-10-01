import { getSupabaseClient } from "@/lib/supabase/client"
import type { Transaction } from "@/lib/data"
import { rowToTransaction } from "@/lib/supabase/inventory-db"

/** Sale dispatches for one directory client, counted in SQL. */
export type ClientDispatchCount = {
  orders: number | null
  units: number | null
  reliable: boolean
}

/**
 * A missing row is a real zero: that client has no matched sale.
 * An unreliable row has no number — the sale text matched more than one client,
 * or one batch resolved to more than one client.
 */
export function dispatchCell(
  row: ClientDispatchCount | undefined,
  field: "orders" | "units",
  ready: boolean,
  failed: boolean,
): string {
  if (!ready) return "…"
  if (failed) return "—"
  return dispatchCountLabel(row, field)
}

export function dispatchCountLabel(
  row: ClientDispatchCount | undefined,
  field: "orders" | "units",
): string {
  if (row && !row.reliable) return "Unmatched"
  const value = row?.[field]
  return String(value ?? 0)
}

/** Higher counts first. Unmatched clients sort after every number. */
export function compareDispatchCount(
  left: ClientDispatchCount | undefined,
  right: ClientDispatchCount | undefined,
  field: "orders" | "units",
): number {
  const rank = (row: ClientDispatchCount | undefined): number | null => {
    if (row && !row.reliable) return null
    return row?.[field] ?? 0
  }
  const a = rank(left)
  const b = rank(right)
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  return b - a
}

export async function fetchClientSaleDispatchCounts(): Promise<Map<string, ClientDispatchCount>> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase.rpc("client_sale_dispatch_counts")
  if (error) throw new Error(error.message)
  const counts = new Map<string, ClientDispatchCount>()
  for (const row of data ?? []) {
    counts.set(row.client_id, {
      orders: row.orders,
      units: row.units,
      reliable: row.reliable,
    })
  }
  return counts
}

export type ResolvedClientTransaction = Transaction & { batchKey: string }

/** Every transaction the resolution view assigns to this directory client. */
export async function fetchClientTransactions(clientId: string): Promise<ResolvedClientTransaction[]> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase.rpc("client_transactions", { p_client_id: clientId })
  if (error) throw new Error(error.message)
  return (data ?? []).map((row) => ({
    ...rowToTransaction(row),
    batchKey: row.batch_key,
  }))
}

/** Latest business date per client, from client_last_activity(). */
export async function fetchClientLastActivity(): Promise<Map<string, string>> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase.rpc("client_last_activity")
  if (error) throw new Error(error.message)
  const last = new Map<string, string>()
  for (const row of data ?? []) {
    if (row.client_id && row.last_activity_date) last.set(row.client_id, row.last_activity_date)
  }
  return last
}
