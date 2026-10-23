"use client"

import { useCallback, useEffect, useState } from "react"
import type { Client, ClientSite } from "@/lib/data"
import type { Database } from "./database.types"
import { getSupabaseClient } from "./client"
import { fetchAllPages } from "./postgrest-page"
import type { ClientEntityKind } from "@/lib/client-complete"
import { normalizeClientPhone, normalizeNewClientForDb, sanitizeClientText } from "@/lib/client-complete"

type ClientRow = Database["public"]["Tables"]["clients"]["Row"]

function parseSitesFromRow(sites: ClientRow["sites"], fallbackAddress: string | null): ClientSite[] | undefined {
  if (Array.isArray(sites) && sites.length > 0) {
    const out: ClientSite[] = []
    for (const s of sites) {
      if (s && typeof s === "object" && typeof s.address === "string") {
        const address = s.address.trim()
        if (!address) continue
        const name = typeof s.name === "string" && s.name.trim() ? s.name.trim() : undefined
        out.push(name ? { name, address } : { address })
      }
    }
    if (out.length > 0) return out
  }
  const fb = fallbackAddress?.trim()
  if (fb) return [{ address: fb }]
  return undefined
}

/** Normalized sites for DB; empty input yields null columns (caller should validate at least one site). */
export function normalizeClientSitesForDb(sites: ClientSite[]): {
  address: string | null
  sites: ClientSite[] | null
} {
  const normalized: ClientSite[] = []
  for (const s of sites) {
    const address = s.address.trim()
    if (!address) continue
    const name = s.name?.trim()
    normalized.push(name ? { name, address } : { address })
  }
  if (normalized.length === 0) return { address: null, sites: null }
  return { address: normalized[0]!.address, sites: normalized }
}

export function rowToClient(row: ClientRow): Client {
  const sites = parseSitesFromRow(row.sites, row.address)
  const primary = sites?.[0]?.address ?? row.address ?? undefined
  return {
    id: row.id,
    name: row.name,
    company: row.company ?? "",
    email: row.email,
    phone: row.phone ?? "",
    address: primary,
    sites,
    totalOrders: row.total_orders,
    totalSpent: Number(row.total_spent),
    lastOrder: row.last_order ?? "",
    duplicateOverrideReason: row.duplicate_override_reason ?? null,
  }
}

function getSupabaseIfConfigured() {
  try {
    return getSupabaseClient()
  } catch {
    return null
  }
}

async function fetchAllClientRows(supabase: NonNullable<ReturnType<typeof getSupabaseIfConfigured>>): Promise<ClientRow[]> {
  return fetchAllPages((from, to) =>
    supabase
      .from("clients")
      .select("*")
      .order("company", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to)
  )
}

export async function fetchClients(): Promise<Client[]> {
  const supabase = getSupabaseIfConfigured()
  if (!supabase) return []
  const rows = await fetchAllClientRows(supabase)
  return rows.map(rowToClient)
}

export async function fetchClientById(id: string): Promise<Client | null> {
  const supabase = getSupabaseIfConfigured()
  if (!supabase) return null
  const { data, error } = await supabase
    .from("clients")
    .select("*")
    .eq("id", id)
    .maybeSingle()
  if (error) throw error
  return data ? rowToClient(data) : null
}

export type InsertClientInput = {
  kind: ClientEntityKind
  name: string
  /** Empty string for individuals; stored as NULL */
  company: string
  email: string
  phone: string
  /** At least one entry with a non-empty address */
  sites: ClientSite[]
  /** Admin-only; omit/undefined for normal creates (column stays NULL) */
  duplicateOverrideReason?: string
}

function toCompleteInput(input: InsertClientInput): import("@/lib/client-complete").ClientCompleteInput {
  return {
    kind: input.kind,
    name: input.name,
    company: input.company,
    email: input.email,
    phone: input.phone,
    sites: input.sites,
  }
}

function generateClientId(): string {
  return `CLT-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export async function insertClient(input: InsertClientInput): Promise<Client> {
  const supabase = getSupabaseIfConfigured()
  if (!supabase) throw new Error("Supabase is not configured")
  const normalized = normalizeNewClientForDb(toCompleteInput(input))
  const { address, sites } = normalizeClientSitesForDb(normalized.sites)
  if (!sites?.length) throw new Error("At least one site address is required")
  const id = generateClientId()
  const override = input.duplicateOverrideReason?.trim()
  const row: Database["public"]["Tables"]["clients"]["Insert"] = {
    id,
    name: normalized.name,
    company: normalized.company,
    email: normalized.email,
    phone: normalized.phone,
    address,
    sites,
    total_orders: 0,
    total_spent: 0,
    last_order: null,
    ...(override ? { duplicate_override_reason: override } : {}),
  }
  const { data, error } = await supabase.from("clients").insert(row).select().single()
  if (error) throw error
  return rowToClient(data)
}

export async function updateClient(id: string, input: InsertClientInput): Promise<Client> {
  const supabase = getSupabaseIfConfigured()
  if (!supabase) throw new Error("Supabase is not configured")
  const { address, sites } = normalizeClientSitesForDb(input.sites)
  if (!sites?.length) throw new Error("At least one site address is required")
  const phoneTrim = input.phone.trim()
  const patch = {
    name: sanitizeClientText(input.name),
    company:
      input.kind === "individual" ? null : sanitizeClientText(input.company) || null,
    email: input.email.trim(),
    phone: normalizeClientPhone(phoneTrim) ?? (phoneTrim || null),
    address,
    sites,
  }
  const { data, error } = await supabase
    .from("clients")
    .update(patch)
    .eq("id", id)
    .select()
    .single()
  if (error) throw error
  return rowToClient(data)
}

export function useClients(): {
  clients: Client[]
  isLoading: boolean
  error: Error | null
  refetch: () => Promise<void>
} {
  const [clients, setClients] = useState<Client[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const fetchClientRows = useCallback(async () => {
    const supabase = getSupabaseIfConfigured()
    if (!supabase) return { ok: false as const }
    const rows = await fetchAllClientRows(supabase)
    return { ok: true as const, rows }
  }, [])

  const refetch = useCallback(async () => {
    setError(null)
    setIsLoading(true)
    try {
      const result = await fetchClientRows()
      if (!result.ok) {
        setClients([])
        return
      }
      setClients(result.rows.map(rowToClient))
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
      setClients([])
    } finally {
      setIsLoading(false)
    }
  }, [fetchClientRows])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const result = await fetchClientRows()
        if (cancelled) return
        if (!result.ok) {
          setClients([])
          return
        }
        setClients(result.rows.map(rowToClient))
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e : new Error(String(e)))
          setClients([])
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [fetchClientRows])

  return { clients, isLoading, error, refetch }
}
