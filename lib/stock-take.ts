import type { InventoryItem, StockTakeSnapshot, StockTakeSnapshotItem } from "./data"

export interface StockTakeResult {
  matched: InventoryItem[]
  notInSystem: string[]
  notScanned: InventoryItem[]
}

function toSnapshotItem(item: InventoryItem): StockTakeSnapshotItem {
  return {
    serialNumber: item.serialNumber,
    name: item.name,
    status: item.status,
    location: item.location,
  }
}

/** Build a snapshot for persisting a completed stock take (read-only history). */
export function buildStockTakeSnapshot(
  scannedSerials: string[],
  result: StockTakeResult
): StockTakeSnapshot {
  return {
    scannedSerials,
    matched: result.matched.map(toSnapshotItem),
    notInSystem: result.notInSystem,
    notScanned: result.notScanned.map(toSnapshotItem),
  }
}

/**
 * Compare scanned serials against current inventory.
 * - matched: inventory items whose serial was scanned
 * - notInSystem: scanned serials that don't exist in inventory
 * - notScanned: inventory items that were not in the scan list
 */
export function compareStockTake(
  scannedSerials: string[],
  inventory: InventoryItem[]
): StockTakeResult {
  const scannedSet = new Set(scannedSerials.map((s) => s.trim()).filter(Boolean))
  const systemBySerial = new Map(inventory.map((i) => [i.serialNumber, i]))

  const matched: InventoryItem[] = []
  const notInSystem: string[] = []

  for (const serial of scannedSet) {
    const item = systemBySerial.get(serial)
    if (item) {
      matched.push(item)
    } else {
      notInSystem.push(serial)
    }
  }

  const scannedSerialsSet = new Set(scannedSet)
  const notScanned = inventory.filter((item) => !scannedSerialsSet.has(item.serialNumber))

  return { matched, notInSystem, notScanned }
}
