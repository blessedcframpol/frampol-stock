import type { AppSupabaseClient } from "@/lib/supabase/app-client"
import {
  type ClientCompleteInput,
  type ClientDuplicateMatch,
  newClientFieldErrors,
  normalizeNewClientForDb,
} from "@/lib/client-complete"
import { insertClient, type InsertClientInput } from "@/lib/supabase/clients-db"
import type { Client } from "@/lib/data"

export async function fetchClientDuplicateCandidates(
  sb: AppSupabaseClient,
  input: Pick<ClientCompleteInput, "email" | "phone" | "name">,
): Promise<ClientDuplicateMatch[]> {
  const { data, error } = await sb.rpc("find_client_duplicate_candidates", {
    p_email: input.email.trim(),
    p_phone: input.phone.trim(),
    p_name: input.name.trim(),
  })
  if (error) throw error
  return (data ?? []) as ClientDuplicateMatch[]
}

export function clientCompleteToInsert(
  input: ClientCompleteInput & { duplicateOverrideReason?: string },
): InsertClientInput {
  const normalized = normalizeNewClientForDb(input)
  const override = input.duplicateOverrideReason?.trim()
  return {
    kind: input.kind,
    name: normalized.name,
    company: normalized.company ?? "",
    email: normalized.email,
    phone: normalized.phone,
    sites: normalized.sites,
    ...(override ? { duplicateOverrideReason: override } : {}),
  }
}

export async function createClientFromCompleteInput(
  sb: AppSupabaseClient,
  input: ClientCompleteInput & { duplicateOverrideReason?: string },
): Promise<Client> {
  const errors = newClientFieldErrors(input)
  if (errors) {
    const first = Object.values(errors)[0]
    throw new Error(first ?? "Client details are incomplete")
  }
  try {
    return await insertClient(clientCompleteToInsert(input))
  } catch (e) {
    const msg =
      e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string"
        ? (e as { message: string }).message
        : e instanceof Error
          ? e.message
          : String(e)
    throw new Error(msg)
  }
}
