"use client"

import { useCallback, useEffect, useState } from "react"
import type { Client } from "@/lib/data"
import { clients as staticClients } from "@/lib/data"
import type { Database } from "./database.types"
import { getSupabaseClient } from "./client"

type ClientRow = Database["public"]["Tables"]["clients"]["Row"]

export function rowToClient(row: ClientRow): Client {
  return {
    id: row.id,
    name: row.name,
    company: row.company,
    email: row.email,
    phone: row.phone ?? "",
    address: row.address ?? undefined,
    totalOrders: row.total_orders,
    totalSpent: Number(row.total_spent),
    lastOrder: row.last_order ?? "",
  }
}

function getSupabaseIfConfigured() {
  try {
    return getSupabaseClient()
  } catch {
    return null
  }
}

export async function fetchClients(): Promise<Client[]> {
  const supabase = getSupabaseIfConfigured()
  if (!supabase) return staticClients
  const { data, error } = await supabase
    .from("clients")
    .select("*")
    .order("company")
  if (error) throw error
  return (data ?? []).map(rowToClient)
}

export async function fetchClientById(id: string): Promise<Client | null> {
  const supabase = getSupabaseIfConfigured()
  if (!supabase) return staticClients.find((c) => c.id === id) ?? null
  const { data, error } = await supabase
    .from("clients")
    .select("*")
    .eq("id", id)
    .maybeSingle()
  if (error) throw error
  return data ? rowToClient(data) : null
}

export type InsertClientInput = {
  name: string
  company: string
  email: string
  phone: string
  address: string
}

function generateClientId(): string {
  return `CLT-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export async function insertClient(
  input: InsertClientInput
): Promise<Client> {
  const supabase = getSupabaseIfConfigured()
  if (!supabase) throw new Error("Supabase is not configured")
  const id = generateClientId()
  const row = {
    id,
    name: input.name.trim(),
    company: input.company.trim(),
    email: input.email.trim(),
    phone: input.phone.trim() || null,
    address: input.address.trim() || null,
    total_orders: 0,
    total_spent: 0,
    last_order: null,
  }
  const { data, error } = await supabase.from("clients").insert(row).select().single()
  if (error) throw error
  return rowToClient(data)
}

export function useClients(): {
  clients: Client[]
  isLoading: boolean
  error: Error | null
  refetch: () => Promise<void>
} {
  const [clients, setClients] = useState<Client[]>(() => staticClients)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const refetch = useCallback(async () => {
    setError(null)
    const supabase = getSupabaseIfConfigured()
    if (!supabase) {
      setClients(staticClients)
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    try {
      const { data, error: err } = await supabase
        .from("clients")
        .select("*")
        .order("company")
      if (err) throw err
      setClients((data ?? []).map(rowToClient))
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
      setClients(staticClients)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    refetch()
  }, [refetch])

  return { clients, isLoading, error, refetch }
}
