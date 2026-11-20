/**
 * SF1: header search hits the DB with narrow selects (no full ledger load).
 */
import type { AppSupabaseClient } from "@/lib/supabase/app-client"
import type { SearchEntity, SearchProduct, SearchResults } from "@/lib/search"
import type { InventoryItem, Client, AppUser } from "@/lib/data"
import { filterOnHandInventory } from "@/lib/inventory-visibility"

export const HEADER_SEARCH_MIN_CHARS = 2
export const HEADER_SEARCH_LIMIT = 20
export const HEADER_SEARCH_DEBOUNCE_MS = 250

/** Columns pulled for inventory header hits — keep tiny for byte measurement. */
export const HEADER_INVENTORY_SELECT =
  "id, serial_number, product_id, status, client, location, assigned_to, deleted_at, stock_pool, date_added, product_lines(product_name, vendor)"

export const HEADER_CLIENT_SELECT = "id, name, company, email, phone"
export const HEADER_USER_SELECT = "id, email, display_name, role, active"
export const HEADER_PRODUCT_SELECT = "id, product_name, vendor, is_active"
export const HEADER_REQUEST_SELECT = "id, request_number, type"

export type HeaderRequestHit = {
  id: string
  requestNumber: string
  type: string
}

export type HeaderSearchResults = SearchResults & {
  requests: HeaderRequestHit[]
}

type InventoryHitRow = {
  id: string
  serial_number: string
  product_id: string
  status: InventoryItem["status"]
  client: string | null
  location: string | null
  assigned_to: string | null
  deleted_at: string | null
  stock_pool: string | null
  date_added: string
  product_lines: { product_name: string; vendor: string | null } | null
}

function rowToInventoryHit(row: InventoryHitRow): InventoryItem {
  return {
    id: row.id,
    productId: row.product_id,
    serialNumber: row.serial_number,
    name: row.product_lines?.product_name ?? "",
    vendor: row.product_lines?.vendor?.trim() ? row.product_lines.vendor : "General",
    status: row.status,
    stockPool: row.stock_pool === "rental" || row.stock_pool === "demo" ? row.stock_pool : "sale",
    dateAdded: row.date_added,
    location: row.location ?? "",
    client: row.client ?? undefined,
    assignedTo: row.assigned_to ?? undefined,
    deletedAt: row.deleted_at ? String(row.deleted_at) : undefined,
  }
}

function escapeIlike(q: string): string {
  return q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
}

export function emptyHeaderSearchResults(): HeaderSearchResults {
  return { inventory: [], clients: [], users: [], products: [], requests: [] }
}

export async function fetchHeaderSearch(
  sb: AppSupabaseClient,
  query: string,
  entities: readonly SearchEntity[],
): Promise<HeaderSearchResults> {
  const out = emptyHeaderSearchResults()
  const q = query.trim()
  if (q.length < HEADER_SEARCH_MIN_CHARS) return out

  const pattern = `%${escapeIlike(q)}%`
  const quoted = `"${pattern.replace(/"/g, '\\"')}"`
  const allow = new Set(entities)
  const tasks: Promise<void>[] = []

  if (allow.has("inventory")) {
    tasks.push(
      (async () => {
        const { data, error } = await sb
          .from("inventory_items")
          .select(HEADER_INVENTORY_SELECT)
          .is("deleted_at", null)
          .or(
            `serial_number.ilike.${quoted},client.ilike.${quoted},assigned_to.ilike.${quoted},location.ilike.${quoted}`,
          )
          .limit(HEADER_SEARCH_LIMIT)
        if (error) throw error
        const mapped = ((data ?? []) as unknown as InventoryHitRow[]).map(rowToInventoryHit)
        out.inventory = filterOnHandInventory(mapped).slice(0, HEADER_SEARCH_LIMIT)
      })(),
    )
  }

  if (allow.has("products")) {
    tasks.push(
      (async () => {
        const { data, error } = await sb
          .from("product_lines")
          .select(HEADER_PRODUCT_SELECT)
          .eq("is_active", true)
          .or(`product_name.ilike.${quoted},vendor.ilike.${quoted}`)
          .limit(HEADER_SEARCH_LIMIT)
        if (error) throw error
        out.products = (data ?? []).map(
          (p): SearchProduct => ({
            productId: p.id,
            name: p.product_name,
            vendor: p.vendor ?? "",
          }),
        )
      })(),
    )
  }

  if (allow.has("clients")) {
    tasks.push(
      (async () => {
        const { data, error } = await sb
          .from("clients")
          .select(HEADER_CLIENT_SELECT)
          .or(
            `name.ilike.${quoted},company.ilike.${quoted},email.ilike.${quoted},phone.ilike.${quoted},id.ilike.${quoted}`,
          )
          .limit(HEADER_SEARCH_LIMIT)
        if (error) throw error
        out.clients = (data ?? []).map(
          (c): Client => ({
            id: c.id,
            name: c.name,
            company: c.company ?? "",
            email: c.email ?? "",
            phone: c.phone ?? "",
            totalOrders: 0,
            totalSpent: 0,
            lastOrder: "",
          }),
        )
      })(),
    )
  }

  if (allow.has("users")) {
    tasks.push(
      (async () => {
        const { data, error } = await sb
          .from("profiles")
          .select(HEADER_USER_SELECT)
          .or(`email.ilike.${quoted},display_name.ilike.${quoted}`)
          .limit(HEADER_SEARCH_LIMIT)
        if (error) throw error
        out.users = (data ?? []).map(
          (u): AppUser => ({
            id: u.id,
            name: u.display_name?.trim() || u.email.split("@")[0] || u.email,
            email: u.email,
            role: u.role ?? "",
          }),
        )
      })(),
    )
  }

  // Request number search for roles that already search inventory/clients.
  if (allow.has("inventory") || allow.has("clients")) {
    tasks.push(
      (async () => {
        const { data, error } = await sb
          .from("stock_requests")
          .select(HEADER_REQUEST_SELECT)
          .ilike("request_number", pattern)
          .limit(Math.min(5, HEADER_SEARCH_LIMIT))
        if (error) return
        out.requests = (data ?? []).map((r) => ({
          id: r.id,
          requestNumber: r.request_number,
          type: r.type,
        }))
      })(),
    )
  }

  await Promise.all(tasks)
  return out
}

/** Rough JSON byte size for measurement scripts. */
export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length
}
