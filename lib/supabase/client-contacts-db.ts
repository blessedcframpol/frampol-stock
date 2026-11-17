import type { Database } from "./database.types"
import type { AppSupabaseClient } from "./app-client"
import {
  normalizeClientContactForDb,
  type ClientContactInput,
  type ClientContactRole,
} from "@/lib/client-contacts"

type SB = AppSupabaseClient
type ContactRow = Database["public"]["Tables"]["client_contacts"]["Row"]

export type ClientContact = {
  id: string
  clientId: string
  name: string
  role: ClientContactRole
  email: string | null
  phone: string | null
  isPrimary: boolean
  active: boolean
  notes: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export function rowToClientContact(row: ContactRow): ClientContact {
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    role: row.role as ClientContactRole,
    email: row.email,
    phone: row.phone,
    isPrimary: row.is_primary,
    active: row.active,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function fetchClientContacts(
  sb: SB,
  clientId: string,
  options?: { includeInactive?: boolean }
): Promise<ClientContact[]> {
  let q = sb
    .from("client_contacts")
    .select("*")
    .eq("client_id", clientId)
    .order("is_primary", { ascending: false })
    .order("name", { ascending: true })
  if (!options?.includeInactive) q = q.eq("active", true)
  const { data, error } = await q
  if (error) throw error
  return (data ?? []).map(rowToClientContact)
}

export async function fetchClientContactById(sb: SB, id: string): Promise<ClientContact | null> {
  const { data, error } = await sb.from("client_contacts").select("*").eq("id", id).maybeSingle()
  if (error) throw error
  return data ? rowToClientContact(data) : null
}

export async function fetchClientContactsByIds(sb: SB, ids: string[]): Promise<Map<string, ClientContact>> {
  const unique = [...new Set(ids.filter(Boolean))]
  const out = new Map<string, ClientContact>()
  if (unique.length === 0) return out
  const { data, error } = await sb.from("client_contacts").select("*").in("id", unique)
  if (error) throw error
  for (const row of data ?? []) out.set(row.id, rowToClientContact(row))
  return out
}

export type ContactSearchMatch = { clientId: string; contactName: string }

/** Targeted search for global search — only when query is non-empty (PF1a). */
export async function fetchClientIdsMatchingContacts(
  sb: SB,
  query: string,
  limit = 40
): Promise<ContactSearchMatch[]> {
  const q = query.trim()
  if (!q) return []
  const safe = q.replace(/[%_,."\\()]/g, " ").replace(/\s+/g, " ").trim()
  if (!safe) return []
  const pattern = `%${safe}%`
  const { data, error } = await sb
    .from("client_contacts")
    .select("client_id, name")
    .eq("active", true)
    .or(`name.ilike."${pattern}",email.ilike."${pattern}",phone.ilike."${pattern}"`)
    .limit(limit)
  if (error) throw error
  const byClient = new Map<string, string>()
  for (const row of data ?? []) {
    if (!row.client_id || byClient.has(row.client_id)) continue
    byClient.set(row.client_id, row.name)
  }
  return [...byClient.entries()].map(([clientId, contactName]) => ({ clientId, contactName }))
}

export async function createClientContact(
  sb: SB,
  clientId: string,
  input: ClientContactInput
): Promise<ClientContact> {
  const normalized = normalizeClientContactForDb(input)
  const { data, error } = await sb
    .from("client_contacts")
    .insert({
      client_id: clientId,
      name: normalized.name,
      role: normalized.role,
      email: normalized.email,
      phone: normalized.phone,
      notes: normalized.notes,
      is_primary: normalized.is_primary,
      active: true,
    })
    .select("*")
    .single()
  if (error) throw error
  return rowToClientContact(data)
}

export async function updateClientContact(
  sb: SB,
  id: string,
  input: ClientContactInput
): Promise<ClientContact> {
  const normalized = normalizeClientContactForDb(input)
  const { data, error } = await sb
    .from("client_contacts")
    .update({
      name: normalized.name,
      role: normalized.role,
      email: normalized.email,
      phone: normalized.phone,
      notes: normalized.notes,
      is_primary: normalized.is_primary,
    })
    .eq("id", id)
    .select("*")
    .single()
  if (error) throw error
  return rowToClientContact(data)
}

export async function archiveClientContact(sb: SB, id: string): Promise<ClientContact> {
  const { data, error } = await sb
    .from("client_contacts")
    .update({ active: false, is_primary: false })
    .eq("id", id)
    .select("*")
    .single()
  if (error) throw error
  return rowToClientContact(data)
}

export async function setPrimaryClientContact(sb: SB, id: string): Promise<ClientContact> {
  const { data, error } = await sb
    .from("client_contacts")
    .update({ is_primary: true, active: true })
    .eq("id", id)
    .select("*")
    .single()
  if (error) throw error
  return rowToClientContact(data)
}
