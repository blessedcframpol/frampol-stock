import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/supabase/database.types"

/** Names for people who recorded rows the caller can already see. */
export async function loadProfileLabels(
  supabase: SupabaseClient<Database>,
  ids: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id && id.trim())))]
  const labels = new Map<string, string>()
  if (unique.length === 0) return labels
  const { data, error } = await supabase.rpc("profile_display_labels", { p_ids: unique })
  if (error || !data) return labels
  for (const row of data) {
    const label = row.label?.trim()
    if (row.id && label) labels.set(row.id, label)
  }
  return labels
}
