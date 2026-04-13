"use client"

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import type { InventoryItem, DeviceType, Transaction, TransactionType } from "./data"
import { inventoryItems as initialInventory, recentTransactions as initialTransactions, clients } from "./data"
import { getReorderLevelForProduct, getReorderLevelOverrides } from "./settings"
import { getSupabaseClient } from "./supabase/client"
import { rowToInventoryItem, inventoryItemToRow, rowToTransaction, transactionToRow } from "./supabase/inventory-db"
import {
  computeMovementResult,
  type InboundCreateDefaults,
  type MovementRejection,
} from "./supabase/movement-utils"
import { useAuth } from "./auth-context"
import { toast } from "sonner"

const DEFAULT_DEVICE_TYPES: DeviceType[] = [{ id: "ptype-general", name: "General", active: true }]

function deepClone<T>(arr: T[]): T[] {
  return JSON.parse(JSON.stringify(arr))
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/** Days before trashed inventory rows are eligible for permanent purge. */
export const INVENTORY_TRASH_RETENTION_DAYS = 30

function getClientDisplay(clientId: string): string {
  if (!clientId || clientId === "internal") return "Internal"
  const c = clients.find((x) => x.id === clientId)
  return c ? `${c.name} - ${c.company}` : clientId
}

function getSupabaseIfConfigured() {
  try {
    return getSupabaseClient()
  } catch {
    return null
  }
}

export interface MovementParams {
  type: TransactionType
  serialNumbers: string[]
  clientId?: string
  /**
   * Directory label for transactions/inventory (e.g. "Name - Company").
   * When omitted, falls back to seed-data lookup — use this with live clients from Supabase.
   */
  clientDisplayOverride?: string
  fromLocation?: string
  toLocation?: string
  assignedTo?: string
  invoiceNumber?: string
  notes?: string
  /** For Rentals: when the kit is due to be returned (ISO date). Defaults to 30 days from today if omitted. */
  returnDate?: string
  /** For Dispose: reason and authorisation */
  disposalReason?: string
  authorisedBy?: string
  /** Optional batch id; if omitted, one is generated so all rows in this submit share `batch_id`. */
  batchId?: string
  /** For Inbound: public URL of uploaded delivery note */
  deliveryNoteUrl?: string
  /** When Inbound: create new rows for unknown serials (and require no conflicting In Stock serial) */
  inboundCreateDefaults?: InboundCreateDefaults
  /** FortiGate outbound: map trimmed serial → cloud key */
  cloudKeysBySerial?: Record<string, string>
  /** TEMPORARY (admin UI, Sale only): optional ledger date; omit for “now” */
  saleTransactionDateIso?: string
  /** Optional: reject existing rows whose name/vendor/device type do not match (see movement-utils). */
  expectedProductName?: string
  expectedVendor?: string
  expectedDeviceType?: string
}

const APPROACHING_DAYS = 7

export interface AlertsResult {
  lowStock: { groupName: string; deviceType: string; inStock: number; threshold: number }[]
  warrantyExpiring: InventoryItem[]
  /** POC items past expected return date */
  pocOverdue: InventoryItem[]
  /** POC items with return date approaching (within N days) */
  pocApproaching: InventoryItem[]
  /** Rentals past their return date (kit not yet returned) */
  rentalOverdue: InventoryItem[]
  /** Rentals with return date approaching (within N days) */
  rentalApproaching: InventoryItem[]
}

const WARRANTY_DAYS = 30

function getAlertsFromInventory(
  inventory: InventoryItem[],
  getThreshold: (productName: string) => number
): AlertsResult {
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const warrantyLimit = new Date(now)
  warrantyLimit.setDate(warrantyLimit.getDate() + WARRANTY_DAYS)

  const byName = new Map<string, InventoryItem[]>()
  for (const item of inventory) {
    const list = byName.get(item.name) ?? []
    list.push(item)
    byName.set(item.name, list)
  }

  // Consider all product groups: those in inventory and those with reorder overrides (so we still
  // show low stock when a product has 0 items). Alert clears only when in-stock count exceeds
  // the reorder level (i.e. when new items have been scanned in to satisfy it).
  const overrideProductNames = Object.keys(getReorderLevelOverrides())
  const allProductNames = new Set<string>([...byName.keys(), ...overrideProductNames])
  const lowStock: AlertsResult["lowStock"] = []
  for (const name of allProductNames) {
    const items = byName.get(name) ?? []
    const inStock = items.filter((i) => i.status === "In Stock").length
    const threshold = getThreshold(name)
    if (inStock <= threshold) {
      lowStock.push({
        groupName: name,
        deviceType: items[0]?.deviceType ?? name,
        inStock,
        threshold,
      })
    }
  }

  const warrantyExpiring = inventory.filter((item) => {
    if (!item.warrantyEndDate) return false
    const end = new Date(item.warrantyEndDate)
    return end <= warrantyLimit && end >= now && item.status !== "Disposed" && item.status !== "Sold"
  })

  const approachingStart = new Date(now)
  approachingStart.setDate(approachingStart.getDate() + 1)
  const approachingEnd = new Date(now)
  approachingEnd.setDate(approachingEnd.getDate() + APPROACHING_DAYS)

  /** POC: return date has passed */
  const pocOverdue = inventory.filter((item) => {
    if (item.status !== "POC" || !item.returnDate) return false
    const due = new Date(item.returnDate)
    due.setHours(0, 0, 0, 0)
    return due < now
  })

  /** POC: return date approaching (within N days) */
  const pocApproaching = inventory.filter((item) => {
    if (item.status !== "POC" || !item.returnDate) return false
    const due = new Date(item.returnDate)
    due.setHours(0, 0, 0, 0)
    return due >= approachingStart && due <= approachingEnd
  })

  /** Rental: return date has passed (status Rented) */
  const rentalOverdue = inventory.filter((item) => {
    if (item.status !== "Rented" || !item.returnDate) return false
    const due = new Date(item.returnDate)
    due.setHours(0, 0, 0, 0)
    return due < now
  })

  /** Rental: return date approaching */
  const rentalApproaching = inventory.filter((item) => {
    if (item.status !== "Rented" || !item.returnDate) return false
    const due = new Date(item.returnDate)
    due.setHours(0, 0, 0, 0)
    return due >= approachingStart && due <= approachingEnd
  })

  return { lowStock, warrantyExpiring, pocOverdue, pocApproaching, rentalOverdue, rentalApproaching }
}

/** Revert state for one inventory item when undoing a transaction */
function getRevertUpdatesForTransaction(txn: Transaction): Partial<InventoryItem> {
  switch (txn.type) {
    case "Inbound":
      return {}
    case "Sale":
      return {
        status: "In Stock",
        location: "Warehouse A",
        client: undefined,
        assignedTo: undefined,
      }
    case "POC Out":
      return {
        status: "In Stock",
        location: "Warehouse A",
        client: undefined,
        assignedTo: undefined,
        pocOutDate: undefined,
      }
    case "POC Return":
      return {
        status: "POC",
        location: "Client Site",
        client: undefined,
        assignedTo: undefined,
      }
    case "Rental Return":
      return {
        status: "Rented",
        location: "Client Site",
        client: undefined,
        assignedTo: undefined,
        pocOutDate: undefined,
        returnDate: undefined,
      }
    case "Rentals":
      return {
        status: "In Stock",
        location: "Warehouse A",
        client: undefined,
        assignedTo: undefined,
        pocOutDate: undefined,
        returnDate: undefined,
      }
    case "Transfer":
      return txn.fromLocation ? { location: txn.fromLocation } : {}
    case "Dispose":
      return {
        status: "In Stock",
        location: "Warehouse A",
        client: undefined,
        assignedTo: undefined,
      }
    default:
      return {}
  }
}

interface InventoryStoreValue {
  inventory: InventoryItem[]
  transactions: Transaction[]
  deviceTypes: DeviceType[]
  applyMovement: (params: MovementParams) => {
    success: string[]
    notFound: string[]
    rejected: MovementRejection[]
    movementBatchId?: string
  }
  refetchLedger: () => Promise<void>
  updateItem: (id: string, updates: Partial<InventoryItem>) => void
  softDeleteItem: (id: string) => Promise<{ ok: boolean; error?: string }>
  restoreItem: (id: string) => Promise<{ ok: boolean; error?: string }>
  permanentlyDeleteItem: (id: string) => Promise<{ ok: boolean; error?: string }>
  purgeTrashExpired: () => Promise<{ ok: boolean; error?: string; removed?: number }>
  trashedInventory: InventoryItem[]
  refetchTrashed: () => Promise<void>
  addItem: (item: Omit<InventoryItem, "id">) => InventoryItem
  addDeviceType: (name: string) => Promise<{ ok: boolean; error?: string }>
  archiveDeviceType: (id: string) => Promise<{ ok: boolean; error?: string }>
  reassignInventoryGroup: (params: {
    sourceGroupName: string
    targetGroupName?: string
    targetDeviceTypeId?: string
    targetVendor?: string
  }) => Promise<{ ok: boolean; updated: number; error?: string }>
  undoTransaction: (txnId: string) => Promise<{ ok: boolean; error?: string }>
  reassignTransaction: (txnId: string, newItemName: string, newDeviceType?: InventoryItem["deviceType"]) => Promise<{ ok: boolean; error?: string }>
  getAlerts: () => AlertsResult
}

const InventoryStoreContext = createContext<InventoryStoreValue | null>(null)

export function InventoryStoreProvider({ children }: { children: React.ReactNode }) {
  const { user, loading: authLoading } = useAuth()
  const supabase = useMemo(() => getSupabaseIfConfigured(), [])
  const [inventory, setInventory] = useState<InventoryItem[]>(() =>
    supabase ? [] : deepClone(initialInventory)
  )
  const [transactions, setTransactions] = useState<Transaction[]>(() =>
    supabase ? [] : deepClone(initialTransactions)
  )
  const [trashedInventory, setTrashedInventory] = useState<InventoryItem[]>([])
  const [deviceTypes, setDeviceTypes] = useState<DeviceType[]>(() => {
    if (supabase) return []
    const names = [...new Set(initialInventory.map((i) => i.deviceType).filter(Boolean))].sort()
    return [
      { id: "ptype-general", name: "General", active: true },
      ...names
        .filter((n) => n.toLowerCase() !== "general")
        .map((n) => ({ id: `legacy-${n.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, name: n, active: true })),
    ]
  })

  const refetchLedger = useCallback(
    async (opts?: { isStale?: () => boolean }) => {
      const stale = () => opts?.isStale?.() ?? false
      if (!supabase) return
      const { data: invRows, error: invError } = await supabase
        .from("inventory_items")
        .select("*")
        .is("deleted_at", null)
        .order("date_added", { ascending: true })
      if (invError) {
        console.error("refetchLedger inventory_items:", invError)
        return
      }
      if (stale()) return
      setInventory((invRows ?? []).map(rowToInventoryItem))

      const { data: txnRows, error: txnError } = await supabase.from("transactions").select("*").order("date", { ascending: false })
      if (txnError) {
        console.error("refetchLedger transactions:", txnError)
      } else if (!stale()) {
        setTransactions((txnRows ?? []).map(rowToTransaction))
      }

      const { data: typeRows, error: typeError } = await supabase
        .from("device_types")
        .select("id, name, active")
        .order("name", { ascending: true })
      if (stale()) return
      if (typeError) {
        console.error("refetchLedger device_types:", typeError)
        setDeviceTypes(DEFAULT_DEVICE_TYPES)
        return
      }
      if (typeRows && typeRows.length > 0) {
        setDeviceTypes(typeRows.map((r) => ({ id: r.id, name: r.name, active: r.active })))
        return
      }
      const inv = invRows ?? []
      const names = [...new Set(inv.map((r) => r.device_type).filter(Boolean))].sort()
      if (names.length > 0) {
        setDeviceTypes([
          ...DEFAULT_DEVICE_TYPES,
          ...names
            .filter((n) => n.toLowerCase() !== "general")
            .map((n) => ({ id: `legacy-${n.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, name: n, active: true })),
        ])
      } else {
        setDeviceTypes(DEFAULT_DEVICE_TYPES)
      }
    },
    [supabase]
  )

  useEffect(() => {
    if (!supabase) return
    if (authLoading) return
    if (!user) {
      setInventory([])
      setTransactions([])
      setTrashedInventory([])
      setDeviceTypes([])
      return
    }
    let cancelled = false
    void refetchLedger({ isStale: () => cancelled })
    return () => {
      cancelled = true
    }
  }, [supabase, authLoading, user?.id, refetchLedger])

  const applyMovement = useCallback(
    (
      params: MovementParams
    ): { success: string[]; notFound: string[]; rejected: MovementRejection[]; movementBatchId?: string } => {
      const {
        type,
        serialNumbers,
        clientId,
        clientDisplayOverride,
        fromLocation,
        toLocation,
        assignedTo,
        invoiceNumber,
        notes,
        returnDate,
        disposalReason,
        authorisedBy,
        batchId,
        deliveryNoteUrl,
        inboundCreateDefaults,
        cloudKeysBySerial,
        saleTransactionDateIso,
        expectedProductName,
        expectedVendor,
        expectedDeviceType,
      } = params
      const clientDisplay =
        clientDisplayOverride ?? (clientId ? getClientDisplay(clientId) : "Internal")
      const newBatchId = batchId ?? `BATCH-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

      const result = computeMovementResult(inventory, {
        type,
        serialNumbers,
        clientDisplay,
        clientId,
        fromLocation,
        toLocation,
        assignedTo,
        invoiceNumber,
        notes,
        returnDate,
        disposalReason,
        authorisedBy,
        batchId: newBatchId,
        deliveryNoteUrl,
        inboundCreateDefaults,
        cloudKeysBySerial,
        saleTransactionDateIso,
        expectedProductName,
        expectedVendor,
        expectedDeviceType,
      })

      if (result.rejected.length > 0) {
        const preview = result.rejected.slice(0, 3)
        const more =
          result.rejected.length > 3 ? ` (+${result.rejected.length - 3} more)` : ""
        const detail = preview.map((r) => `${r.serial}: ${r.reason}`).join("; ")
        toast.warning(`Some serials were skipped${more}`, { description: detail, duration: 12_000 })
      }

      if (result.success.length === 0) {
        return {
          success: [],
          notFound: result.notFound,
          rejected: result.rejected,
          movementBatchId: undefined,
        }
      }

      const runPersist = async () => {
        if (!supabase) return
        const reportFail = (step: string, error: { message: string } | null) => {
          if (!error) return false
          toast.error("Could not save stock movement", {
            description: `${step}: ${error.message}`,
            duration: 20_000,
          })
          return true
        }
        try {
          if (newBatchId && (type === "POC Out" || type === "Rentals") && result.newTransactions.length > 0) {
            const txn = result.newTransactions[0]
            const dateIso = txn.date
            const dateOnly = dateIso.slice(0, 10)
            const endDate = type === "Rentals" && result.updatedItems[0]?.returnDate ? result.updatedItems[0].returnDate : null
            const { error } = await supabase.from("outbound_batches").insert({
              id: newBatchId,
              type,
              client: clientDisplay,
              client_id: clientId ?? null,
              start_date: dateOnly,
              end_date: endDate,
              status: "open",
              invoice_number: invoiceNumber ?? null,
              created_at: dateIso,
            })
            if (reportFail("Outbound batch", error)) return
          }
          const prevIds = new Set(inventory.map((i) => i.id))
          for (const item of result.updatedItems) {
            if (prevIds.has(item.id)) {
              const { error } = await supabase
                .from("inventory_items")
                .update(inventoryItemToRow(item))
                .eq("id", item.id)
              if (reportFail("Inventory update", error)) return
            } else {
              const { error } = await supabase.from("inventory_items").insert(inventoryItemToRow(item))
              if (reportFail("Inventory insert", error)) return
            }
          }
          if (result.newTransactions.length) {
            const { error } = await supabase
              .from("transactions")
              .insert(result.newTransactions.map(transactionToRow))
            if (reportFail("Transaction log", error)) return
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          toast.error("Could not save stock movement", { description: msg, duration: 20_000 })
        }
      }

      void runPersist()

      setInventory((prev) => {
        const prevIds = new Set(prev.map((i) => i.id))
        const merged = prev.map((item) => {
          const u = result.updatedItems.find((x) => x.id === item.id)
          return u ?? item
        })
        const created = result.updatedItems.filter((u) => !prevIds.has(u.id))
        return [...merged, ...created]
      })
      setTransactions((prev) => [...result.newTransactions, ...prev])

      return {
        success: result.success,
        notFound: result.notFound,
        rejected: result.rejected,
        movementBatchId: newBatchId,
      }
    },
    [inventory, supabase]
  )

  const updateItem = useCallback(
    (id: string, updates: Partial<InventoryItem>) => {
      setInventory((prev) => {
        const next = prev.map((item) => (item.id === id ? { ...item, ...updates } : item))
        const updated = next.find((i) => i.id === id)
        if (supabase && updated) {
          supabase
            .from("inventory_items")
            .update(inventoryItemToRow(updated))
            .eq("id", id)
            .then(({ error }) => {
              if (error) console.error("Supabase updateItem error:", error)
            })
        }
        return next
      })
    },
    [supabase]
  )

  const refetchTrashed = useCallback(async () => {
    if (!supabase) {
      setTrashedInventory([])
      return
    }
    const { data, error } = await supabase
      .from("inventory_items")
      .select("*")
      .not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false })
    if (error) {
      console.error("refetchTrashed:", error)
      return
    }
    setTrashedInventory((data ?? []).map(rowToInventoryItem))
  }, [supabase])

  const softDeleteItem = useCallback(
    async (id: string): Promise<{ ok: boolean; error?: string }> => {
      const ts = new Date().toISOString()
      if (supabase) {
        const { error } = await supabase.from("inventory_items").update({ deleted_at: ts }).eq("id", id).is("deleted_at", null)
        if (error) return { ok: false, error: error.message || "Failed to move item to trash" }
      }
      setInventory((prev) => prev.filter((i) => i.id !== id))
      return { ok: true }
    },
    [supabase]
  )

  const restoreItem = useCallback(
    async (id: string): Promise<{ ok: boolean; error?: string }> => {
      if (supabase) {
        const { error } = await supabase.from("inventory_items").update({ deleted_at: null }).eq("id", id)
        if (error) return { ok: false, error: error.message || "Failed to restore item" }
      }
      setTrashedInventory((prev) => prev.filter((i) => i.id !== id))
      await refetchLedger()
      return { ok: true }
    },
    [supabase, refetchLedger]
  )

  const permanentlyDeleteItem = useCallback(
    async (id: string): Promise<{ ok: boolean; error?: string }> => {
      if (supabase) {
        const { error } = await supabase.from("inventory_items").delete().eq("id", id)
        if (error) return { ok: false, error: error.message || "Failed to delete item" }
      }
      setTrashedInventory((prev) => prev.filter((i) => i.id !== id))
      setInventory((prev) => prev.filter((i) => i.id !== id))
      return { ok: true }
    },
    [supabase]
  )

  const purgeTrashExpired = useCallback(async (): Promise<{ ok: boolean; error?: string; removed?: number }> => {
    const cutoff = new Date(Date.now() - INVENTORY_TRASH_RETENTION_DAYS * 86400000).toISOString()
    if (!supabase) {
      setTrashedInventory((prev) => prev.filter((i) => !i.deletedAt || i.deletedAt >= cutoff))
      return { ok: true, removed: 0 }
    }
    const { data: stale, error: selErr } = await supabase
      .from("inventory_items")
      .select("id")
      .not("deleted_at", "is", null)
      .lt("deleted_at", cutoff)
    if (selErr) return { ok: false, error: selErr.message }
    const ids = (stale ?? []).map((r) => r.id)
    if (ids.length === 0) return { ok: true, removed: 0 }
    const { error } = await supabase.from("inventory_items").delete().in("id", ids)
    if (error) return { ok: false, error: error.message }
    await refetchTrashed()
    return { ok: true, removed: ids.length }
  }, [supabase, refetchTrashed])

  const addItem = useCallback(
    (item: Omit<InventoryItem, "id">): InventoryItem => {
      const fallbackTypeId =
        item.deviceTypeId ??
        deviceTypes.find((pt) => pt.name.toLowerCase() === item.deviceType.toLowerCase())?.id ??
        deviceTypes.find((pt) => pt.name === "General")?.id ??
        "ptype-general"
      const newItem: InventoryItem = {
        ...item,
        vendor: item.vendor?.trim() ? item.vendor : "General",
        deviceTypeId: fallbackTypeId,
        id: generateId("INV"),
      }
      setInventory((prev) => [...prev, newItem])
      if (supabase) {
        supabase
          .from("inventory_items")
          .insert(inventoryItemToRow(newItem))
          .then(({ error }) => {
            if (error) console.error("Supabase addItem error:", error)
          })
      }
      return newItem
    },
    [supabase, deviceTypes]
  )

  const addDeviceType = useCallback(
    async (name: string): Promise<{ ok: boolean; error?: string }> => {
      const trimmed = name.trim()
      if (!trimmed) return { ok: false, error: "Type name is required" }
      if (deviceTypes.some((pt) => pt.name.toLowerCase() === trimmed.toLowerCase() && pt.active)) {
        return { ok: false, error: "Type already exists" }
      }
      const id = `ptype-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const next: DeviceType = { id, name: trimmed, active: true }
      setDeviceTypes((prev) => [...prev, next].sort((a, b) => a.name.localeCompare(b.name)))
      if (supabase) {
        const { error } = await supabase.from("device_types").insert({ id, name: trimmed, active: true })
        if (error) return { ok: false, error: error.message || "Failed to add device type" }
      }
      return { ok: true }
    },
    [deviceTypes, supabase]
  )

  const archiveDeviceType = useCallback(
    async (id: string): Promise<{ ok: boolean; error?: string }> => {
      const hasInventory = inventory.some((item) => item.deviceTypeId === id)
      if (hasInventory) {
        return { ok: false, error: "Cannot archive a type that is still used by inventory items" }
      }
      setDeviceTypes((prev) => prev.map((pt) => (pt.id === id ? { ...pt, active: false } : pt)))
      if (supabase) {
        const { error } = await supabase.from("device_types").update({ active: false }).eq("id", id)
        if (error) return { ok: false, error: error.message || "Failed to archive device type" }
      }
      return { ok: true }
    },
    [inventory, supabase]
  )

  const reassignInventoryGroup = useCallback(
    async (params: {
      sourceGroupName: string
      targetGroupName?: string
      targetDeviceTypeId?: string
      targetVendor?: string
    }): Promise<{ ok: boolean; updated: number; error?: string }> => {
      const source = params.sourceGroupName.trim()
      if (!source) return { ok: false, updated: 0, error: "Source group is required" }
      const targetName = params.targetGroupName?.trim() || source
      const targetTypeId =
        params.targetDeviceTypeId ??
        deviceTypes.find((pt) => pt.name.toLowerCase() === "general")?.id ??
        "ptype-general"
      const targetTypeName = deviceTypes.find((pt) => pt.id === targetTypeId)?.name ?? "General"
      const targetVendor = params.targetVendor?.trim() || "General"
      const affected = inventory.filter((item) => item.name === source)
      if (affected.length === 0) return { ok: true, updated: 0 }

      const updatedItems = affected.map((item) => ({
        ...item,
        name: targetName,
        deviceType: targetTypeName,
        deviceTypeId: targetTypeId,
        vendor: targetVendor,
      }))
      const updatedMap = new Map(updatedItems.map((i) => [i.id, i]))
      setInventory((prev) => prev.map((item) => updatedMap.get(item.id) ?? item))

      if (supabase) {
        for (const item of updatedItems) {
          const { error } = await supabase.from("inventory_items").update(inventoryItemToRow(item)).eq("id", item.id)
          if (error) {
            return { ok: false, updated: 0, error: error.message || "Failed to update inventory group" }
          }
        }
      }
      return { ok: true, updated: updatedItems.length }
    },
    [inventory, deviceTypes, supabase]
  )

  const getAlerts = useCallback(
    () => getAlertsFromInventory(inventory, getReorderLevelForProduct),
    [inventory]
  )

  const undoTransaction = useCallback(
    async (txnId: string): Promise<{ ok: boolean; error?: string }> => {
      const txn = transactions.find((t) => t.id === txnId)
      if (!txn) return { ok: false, error: "Transaction not found" }
      if (txn.type === "Dispose") return { ok: false, error: "Disposal cannot be undone." }
      const item = inventory.find((i) => i.serialNumber === txn.serialNumber)
      const updates = getRevertUpdatesForTransaction(txn)
      if (item && Object.keys(updates).length > 0) {
        const next = { ...item, ...updates }
        setInventory((prev) =>
          prev.map((i) => (i.id === item.id ? next : i))
        )
        if (supabase) {
          const { error } = await supabase
            .from("inventory_items")
            .update(inventoryItemToRow(next))
            .eq("id", item.id)
          if (error) {
            console.error("Undo: inventory update error", error)
            return { ok: false, error: error.message || "Failed to revert inventory" }
          }
        }
      }
      setTransactions((prev) => prev.filter((t) => t.id !== txnId))
      if (supabase) {
        const { error } = await supabase.from("transactions").delete().eq("id", txnId)
        if (error) {
          console.error("Undo: transaction delete error", error)
          return { ok: false, error: error.message || "Failed to remove transaction" }
        }
      }
      return { ok: true }
    },
    [inventory, transactions, supabase]
  )

  const reassignTransaction = useCallback(
    async (
      txnId: string,
      newItemName: string,
      newDeviceType?: InventoryItem["deviceType"]
    ): Promise<{ ok: boolean; error?: string }> => {
      const txn = transactions.find((t) => t.id === txnId)
      if (!txn) return { ok: false, error: "Transaction not found" }
      const name = newItemName.trim()
      if (!name) return { ok: false, error: "Product name is required" }
      const item = inventory.find((i) => i.serialNumber === txn.serialNumber)
      const txnNext = { ...txn, itemName: name }
      setTransactions((prev) =>
        prev.map((t) => (t.id === txnId ? txnNext : t))
      )
      if (supabase) {
        const { error: txnErr } = await supabase
          .from("transactions")
          .update({ item_name: name })
          .eq("id", txnId)
        if (txnErr) {
          console.error("Reassign: transaction update error", txnErr)
          return { ok: false, error: txnErr.message || "Failed to update transaction" }
        }
      }
      if (item) {
        const itemUpdates: Partial<InventoryItem> = { name }
        if (newDeviceType) itemUpdates.deviceType = newDeviceType
        setInventory((prev) =>
          prev.map((i) => (i.id === item.id ? { ...i, ...itemUpdates } : i))
        )
        if (supabase) {
          const updated = { ...item, ...itemUpdates }
          const { error } = await supabase
            .from("inventory_items")
            .update(inventoryItemToRow(updated))
            .eq("id", item.id)
          if (error) {
            console.error("Reassign: inventory update error", error)
            return { ok: false, error: error.message || "Failed to update item" }
          }
        }
      }
      return { ok: true }
    },
    [inventory, transactions, supabase]
  )

  const value = useMemo<InventoryStoreValue>(
    () => ({
      inventory,
      transactions,
      deviceTypes,
      applyMovement,
      updateItem,
      softDeleteItem,
      restoreItem,
      permanentlyDeleteItem,
      purgeTrashExpired,
      trashedInventory,
      refetchTrashed,
      addItem,
      addDeviceType,
      archiveDeviceType,
      reassignInventoryGroup,
      undoTransaction,
      reassignTransaction,
      getAlerts,
      refetchLedger,
    }),
    [
      inventory,
      transactions,
      deviceTypes,
      applyMovement,
      updateItem,
      softDeleteItem,
      restoreItem,
      permanentlyDeleteItem,
      purgeTrashExpired,
      trashedInventory,
      refetchTrashed,
      addItem,
      addDeviceType,
      archiveDeviceType,
      reassignInventoryGroup,
      undoTransaction,
      reassignTransaction,
      getAlerts,
      refetchLedger,
    ]
  )

  return (
    <InventoryStoreContext.Provider value={value}>
      {children}
    </InventoryStoreContext.Provider>
  )
}

export function useInventoryStore(): InventoryStoreValue {
  const ctx = useContext(InventoryStoreContext)
  if (!ctx) throw new Error("useInventoryStore must be used within InventoryStoreProvider")
  return ctx
}
