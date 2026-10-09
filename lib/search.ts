import type { InventoryItem } from "./data"
import type { Client } from "./data"
import type { AppUser } from "./data"
import { filterOnHandInventory } from "./inventory-visibility"

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase()
}

function matchQuery(text: string | undefined | null, q: string): boolean {
  if (!text) return false
  return text.toLowerCase().includes(q)
}

export function searchInventory(items: InventoryItem[], query: string): InventoryItem[] {
  const onHand = filterOnHandInventory(items)
  const q = normalizeQuery(query)
  if (!q) return onHand
  return onHand.filter(
    (item) =>
      matchQuery(item.serialNumber, q) ||
      matchQuery(item.name, q) ||
      matchQuery(item.assignedTo, q) ||
      matchQuery(item.client, q) ||
      matchQuery(item.location, q) ||
      matchQuery(item.vendor, q) ||
      matchQuery(item.notes, q)
  )
}

export function searchClients(clients: Client[], query: string): Client[] {
  const q = normalizeQuery(query)
  if (!q) return clients
  return clients.filter(
    (c) =>
      matchQuery(c.name, q) ||
      matchQuery(c.company, q) ||
      matchQuery(c.email, q) ||
      matchQuery(c.phone, q) ||
      matchQuery(c.id, q)
  )
}

/** Client comboboxes in stock movement / quick scan (empty query → full list). */
export function filterClientsForPicker(clients: Client[], query: string): Client[] {
  const q = query.trim()
  if (!q) return clients
  return searchClients(clients, q)
}

/** Closest directory matches before allowing “create new” (name / company contains query). */
export function closestClientsForCreate(clients: Client[], query: string, limit = 5): Client[] {
  const q = query.trim()
  if (!q) return []
  return searchClients(clients, q).slice(0, limit)
}

/** cmdk matches against `value`; include searchable fields, not id alone. */
export function clientCommandItemValue(client: Client): string {
  return [client.name, client.company, client.email, client.phone, client.id].filter(Boolean).join(" ")
}

export function searchUsers(users: AppUser[], query: string): AppUser[] {
  const q = normalizeQuery(query)
  if (!q) return users
  return users.filter(
    (u) =>
      matchQuery(u.name, q) ||
      matchQuery(u.email, q) ||
      matchQuery(u.role, q)
  )
}

export interface SearchResults {
  inventory: InventoryItem[]
  clients: Client[]
  users: AppUser[]
}

export function runSearch(
  data: { inventory: InventoryItem[]; clients: Client[]; users: AppUser[] },
  query: string
): SearchResults {
  const q = query.trim()
  if (!q) {
    return { inventory: [], clients: [], users: [] }
  }
  return {
    inventory: searchInventory(data.inventory, q),
    clients: searchClients(data.clients, q),
    users: searchUsers(data.users, q),
  }
}
