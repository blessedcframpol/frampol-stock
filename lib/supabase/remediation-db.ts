import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "./database.types"

type SB = SupabaseClient<Database>

export type RemediationProviderRow = Database["public"]["Tables"]["remediation_providers"]["Row"]
export type RemediationCaseRow = Database["public"]["Tables"]["remediation_cases"]["Row"]

export async function fetchRemediationProviders(sb: SB): Promise<RemediationProviderRow[]> {
  const { data, error } = await sb.from("remediation_providers").select("*").order("display_name")
  if (error) throw error
  return data ?? []
}

export async function fetchRemediationCases(sb: SB): Promise<RemediationCaseRow[]> {
  const { data, error } = await sb.from("remediation_cases").select("*").order("created_at", { ascending: false })
  if (error) throw error
  return data ?? []
}

export async function createRemediationCase(
  sb: SB,
  input: {
    providerId: string
    faultyInventoryItemId: string
    faultySerial: string
    notes?: string
    createdBy?: string | null
  }
): Promise<RemediationCaseRow> {
  const { data, error } = await sb
    .from("remediation_cases")
    .insert({
      provider_id: input.providerId,
      faulty_inventory_item_id: input.faultyInventoryItemId,
      faulty_serial: input.faultySerial.trim(),
      status: "pending",
      notes: input.notes?.trim() || null,
      created_by: input.createdBy ?? null,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updateRemediationCase(
  sb: SB,
  id: string,
  patch: Partial<{
    status: string
    date_sent_to_provider: string | null
    date_replacement_received: string | null
    tracking_reference: string | null
    notes: string | null
    provider_replacement_serial: string | null
    provider_replacement_inventory_item_id: string | null
  }>
): Promise<void> {
  const { error } = await sb
    .from("remediation_cases")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
  if (error) throw error
}
