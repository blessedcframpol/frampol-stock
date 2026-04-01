import type { InventoryItem, ItemStatus } from "@/lib/data"

/** Matches rows shown on the Dispatched page (out of warehouse / not available to ship). */
const DISPATCHED_STATUSES: ReadonlySet<ItemStatus> = new Set([
  "Sold",
  "POC",
  "Rented",
  "Disposed",
  "Maintenance",
])

export function isDispatchedStatus(status: ItemStatus): boolean {
  return DISPATCHED_STATUSES.has(status)
}

/** Items that belong on main Inventory browse and in global inventory search. */
export function filterOnHandInventory(items: InventoryItem[]): InventoryItem[] {
  return items.filter((i) => i.status === "In Stock")
}
