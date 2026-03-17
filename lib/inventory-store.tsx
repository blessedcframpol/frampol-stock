"use client"

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import type { InventoryItem, Transaction, TransactionType } from "./data"
import { inventoryItems as initialInventory, recentTransactions as initialTransactions, clients } from "./data"
import { getReorderLevelForProduct, getReorderLevelOverrides } from "./settings"
import { getSupabaseClient } from "./supabase/client"
import { rowToInventoryItem, inventoryItemToRow, rowToTransaction, transactionToRow } from "./supabase/inventory-db"
import { computeMovementResult } from "./supabase/movement-utils"

function deepClone<T>(arr: T[]): T[] {
  return JSON.parse(JSON.stringify(arr))
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

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
  /** For POC Out / Rentals: optional batch id (created by store when supabase) */
  batchId?: string
  /** For Inbound: public URL of uploaded delivery note */
  deliveryNoteUrl?: string
}

const APPROACHING_DAYS = 7

export interface AlertsResult {
  lowStock: { groupName: string; itemType: string; inStock: number; threshold: number }[]
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
        itemType: items[0]?.itemType ?? name,
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
  applyMovement: (params: MovementParams) => { success: string[]; notFound: string[] }
  updateItem: (id: string, updates: Partial<InventoryItem>) => void
  addItem: (item: Omit<InventoryItem, "id">) => InventoryItem
  undoTransaction: (txnId: string) => Promise<{ ok: boolean; error?: string }>
  reassignTransaction: (txnId: string, newItemName: string, newItemType?: InventoryItem["itemType"]) => Promise<{ ok: boolean; error?: string }>
  getAlerts: () => AlertsResult
}

const InventoryStoreContext = createContext<InventoryStoreValue | null>(null)

export function InventoryStoreProvider({ children }: { children: React.ReactNode }) {
  const supabase = useMemo(() => getSupabaseIfConfigured(), [])
  const [inventory, setInventory] = useState<InventoryItem[]>(() =>
    supabase ? [] : deepClone(initialInventory)
  )
  const [transactions, setTransactions] = useState<Transaction[]>(() =>
    supabase ? [] : deepClone(initialTransactions)
  )

  useEffect(() => {
    if (!supabase) return
    let cancelled = false
    async function load() {
      const { data: invRows } = await supabase.from("inventory_items").select("*").order("date_added", { ascending: true })
      const { data: txnRows } = await supabase.from("transactions").select("*").order("date", { ascending: false })
      if (cancelled) return
      if (invRows?.length) {
        setInventory(invRows.map(rowToInventoryItem))
      }
      if (txnRows?.length) {
        setTransactions(txnRows.map(rowToTransaction))
      }
      // When DB is empty, do not seed dummy data — use actual data only
    }
    load()
    return () => {
      cancelled = true
    }
  }, [supabase])

  const applyMovement = useCallback(
    (params: MovementParams): { success: string[]; notFound: string[] } => {
      const { type, serialNumbers, clientId, fromLocation, toLocation, assignedTo, invoiceNumber, notes, returnDate, disposalReason, authorisedBy, batchId, deliveryNoteUrl } = params
      const clientDisplay = clientId ? getClientDisplay(clientId) : "Internal"
      const isOutboundBatch = type === "POC Out" || type === "Rentals"
      const newBatchId = isOutboundBatch ? (batchId ?? `BATCH-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`) : undefined
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
      })
      if (result.success.length === 0) {
        return { success: [], notFound: result.notFound }
      }

      const runPersist = async () => {
        if (!supabase) return
        if (newBatchId && isOutboundBatch && result.newTransactions.length > 0) {
          const txn = result.newTransactions[0]
          const dateIso = txn.date
          const dateOnly = dateIso.slice(0, 10)
          const endDate = type === "Rentals" && result.updatedItems[0]?.returnDate ? result.updatedItems[0].returnDate : null
          await supabase.from("outbound_batches").insert({
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
        }
        for (const item of result.updatedItems) {
          await supabase.from("inventory_items").update(inventoryItemToRow(item)).eq("id", item.id)
        }
        if (result.newTransactions.length) {
          await supabase.from("transactions").insert(result.newTransactions.map(transactionToRow))
        }
      }

      runPersist().catch(console.error)

      setInventory((prev) =>
        prev.map((item) => {
          const u = result.updatedItems.find((x) => x.id === item.id)
          return u ?? item
        })
      )
      setTransactions((prev) => [...result.newTransactions, ...prev])

      return { success: result.success, notFound: result.notFound }
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

  const addItem = useCallback(
    (item: Omit<InventoryItem, "id">): InventoryItem => {
      const newItem: InventoryItem = {
        ...item,
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
    [supabase]
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
            return { ok: false, error: "Failed to revert inventory" }
          }
        }
      }
      setTransactions((prev) => prev.filter((t) => t.id !== txnId))
      if (supabase) {
        const { error } = await supabase.from("transactions").delete().eq("id", txnId)
        if (error) {
          console.error("Undo: transaction delete error", error)
          return { ok: false, error: "Failed to remove transaction" }
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
      newItemType?: InventoryItem["itemType"]
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
          return { ok: false, error: "Failed to update transaction" }
        }
      }
      if (item) {
        const itemUpdates: Partial<InventoryItem> = { name }
        if (newItemType) itemUpdates.itemType = newItemType
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
            return { ok: false, error: "Failed to update item" }
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
      applyMovement,
      updateItem,
      addItem,
      undoTransaction,
      reassignTransaction,
      getAlerts,
    }),
    [inventory, transactions, applyMovement, updateItem, addItem, undoTransaction, reassignTransaction, getAlerts]
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
