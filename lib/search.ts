import type { InventoryItem } from "./data"
import type { Client } from "./data"
import type { AppUser } from "./data"

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase()
}

function matchQuery(text: string | undefined | null, q: string): boolean {
  if (!text) return false
  return text.toLowerCase().includes(q)
}

export function searchInventory(items: InventoryItem[], query: string): InventoryItem[] {
  const q = normalizeQuery(query)
  if (!q) return items
  return items.filter(
    (item) =>
      matchQuery(item.serialNumber, q) ||
      matchQuery(item.name, q) ||
      matchQuery(item.itemType, q) ||
      matchQuery(item.assignedTo, q) ||
      matchQuery(item.client, q) ||
      matchQuery(item.location, q) ||
      matchQuery(item.category, q) ||
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
      matchQuery(c.phone, q)
  )
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
