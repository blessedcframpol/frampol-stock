import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "./database.types"

/** Record that a transaction batch was reversed (admin audit). */
export async function insertBatchReversal(
  supabase: SupabaseClient<Database>,
  batchId: string,
  reason: string,
  reversedByUserId: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const now = new Date().toISOString()
  const { error } = await supabase.from("batch_reversals").upsert(
    {
      batch_id: batchId,
      reversed_at: now,
      reversal_reason: reason,
      reversed_by: reversedByUserId,
    },
    { onConflict: "batch_id" }
  )
  if (error) return { ok: false, message: error.message }
  return { ok: true }
}
