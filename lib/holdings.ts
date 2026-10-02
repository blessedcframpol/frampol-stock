import { getSupabaseClient } from "@/lib/supabase/client"

export async function extendHolding(itemId: string, newDate: string, reason: string): Promise<void> {
  const { error } = await getSupabaseClient().rpc("extend_holding", {
    p_item_id: itemId,
    p_new_date: newDate,
    p_reason: reason,
  })
  if (error) throw new Error(error.message)
}

export async function cancelHoldingExtension(extensionId: string, reason: string): Promise<void> {
  const { error } = await getSupabaseClient().rpc("cancel_holding_extension", {
    p_extension_id: extensionId,
    p_reason: reason,
  })
  if (error) throw new Error(error.message)
}
