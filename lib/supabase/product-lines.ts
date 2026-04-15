import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "./database.types"

type SB = SupabaseClient<Database>

/** Resolves or creates a product_lines row; matches migration normalization (empty vendor → General). */
export async function ensureProductLine(sb: SB, productName: string, vendor?: string | null): Promise<string> {
  const { data, error } = await sb.rpc("ensure_product_line", {
    p_product_name: productName,
    p_vendor: vendor ?? "",
  })
  if (error) throw error
  if (!data || typeof data !== "string") throw new Error("ensure_product_line returned no id")
  return data
}
