"use client"

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import type { InventoryItem, JsonValue, Transaction, TransactionType } from "./data"
import { getSupabaseClient } from "./supabase/client"
import { fetchAllPages } from "./supabase/postgrest-page"
import {
  rowToInventoryItem,
  inventoryItemToRow,
  rowToTransaction,
  transactionToRow,
  INVENTORY_ITEM_SELECT,
} from "./supabase/inventory-db"
import { ensureProductLine } from "./supabase/product-lines"
import {
  computeMovementResult,
  type InboundCreateDefaults,
  type MovementRejection,
} from "./supabase/movement-utils"
import { useAuth } from "./auth-context"
import { reportAppEvent } from "./report-app-event"
import { humanizeStockDbError } from "./parse-api-error"
import { toast } from "sonner"
import type { Database } from "./supabase/database.types"
import { businessDateToIso, DEFAULT_ORG_TIMEZONE } from "./business-date.mjs"
import { fetchAppSettings } from "./settings"

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/** Direct edits must not change status. Status moves only through apply_stock_movement. */
function inventoryItemPatch(item: InventoryItem): Database["public"]["Tables"]["inventory_items"]["Update"] {
  const row = inventoryItemToRow(item)
  return {
    id: row.id,
    product_id: row.product_id,
    serial_number: row.serial_number,
    date_added: row.date_added,
    location: row.location,
    client: row.client,
    notes: row.notes,
    assigned_to: row.assigned_to,
    purchase_date: row.purchase_date,
    warranty_end_date: row.warranty_end_date,
    poc_out_date: row.poc_out_date,
    return_date: row.return_date,
    assignment_history: row.assignment_history,
    reserved_for_request_line_id: row.reserved_for_request_line_id,
    cloud_key: row.cloud_key,
    deleted_at: row.deleted_at,
  }
}

/** Days before trashed inventory rows are eligible for permanent purge. */
export const INVENTORY_TRASH_RETENTION_DAYS = 30

function getClientDisplay(clientId: string): string {
  if (!clientId || clientId === "internal") return "Internal"
  return clientId
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
   * When omitted, the transaction stores the client id. Pass the directory label from live clients.
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
  /** For Inbound: private uploads bucket object path for the delivery note. */
  deliveryNoteUrl?: string
  /** When Inbound: create new rows for unknown serials (and require no conflicting In Stock serial) */
  inboundCreateDefaults?: InboundCreateDefaults
  /** FortiGate outbound: map trimmed serial → cloud key */
  cloudKeysBySerial?: Record<string, string>
  /** TEMPORARY (admin UI, Sale only): optional ledger date; omit for “now” */
  saleTransactionDateIso?: string
  /** Optional: reject existing rows whose name/vendor do not match (see movement-utils). */
  expectedProductName?: string
  expectedVendor?: string
  /** Stored on transaction rows (JSON). */
  movementMetadata?: JsonValue
  /** When type is Inspection Pass / Fail: persist kit_inspections after transactions. */
  kitInspectionPayload?: {
    inventoryItemId: string
    serialNumber: string
    inspectorName: string
    outcome: "available" | "faulty"
    conditionNotes?: string
    attachmentUrls: string[]
  }
  /** After Remediation Loaner Issue: link loaner serial to remediation_cases row. */
  remediationCaseLoanerLink?: {
    caseId: string
    loanerInventoryItemId: string
    loanerSerial: string
  }
  /** POC Return only. Required, with no default: sale or demo. */
  returnPool?: "sale" | "demo"
  /** Resolve `transactions.client_id` when display text is "Name - Company" (returns + form edge cases). */
  clientDirectory?: { id: string; name: string; company: string }[]
}

const APPROACHING_DAYS = 7

export interface AlertsResult {
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

function getAlertsFromInventory(inventory: InventoryItem[]): AlertsResult {
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const warrantyLimit = new Date(now)
  warrantyLimit.setDate(warrantyLimit.getDate() + WARRANTY_DAYS)

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

  return { warrantyExpiring, pocOverdue, pocApproaching, rentalOverdue, rentalApproaching }
}

interface InventoryStoreValue {
  inventory: InventoryItem[]
  transactions: Transaction[]
  applyMovement: (params: MovementParams) => Promise<{
    success: string[]
    notFound: string[]
    rejected: MovementRejection[]
    movementBatchId?: string
  }>
  refetchLedger: () => Promise<void>
  updateItem: (id: string, updates: Partial<InventoryItem>) => Promise<void>
  softDeleteItem: (id: string) => Promise<{ ok: boolean; error?: string }>
  restoreItem: (id: string) => Promise<{ ok: boolean; error?: string }>
  permanentlyDeleteItem: (id: string) => Promise<{ ok: boolean; error?: string }>
  purgeTrashExpired: () => Promise<{ ok: boolean; error?: string; removed?: number }>
  trashedInventory: InventoryItem[]
  refetchTrashed: () => Promise<void>
  addItem: (item: Omit<InventoryItem, "id">) => Promise<InventoryItem>
  reassignInventoryItems: (params: {
    itemIds: string[]
    targetGroupName: string
    targetVendor?: string
  }) => Promise<{ ok: boolean; updated: number; error?: string }>
  reassignInventoryGroup: (params: {
    sourceGroupName: string
    sourceVendor?: string
    targetGroupName?: string
    targetVendor?: string
  }) => Promise<{ ok: boolean; updated: number; error?: string }>
  getAlerts: () => AlertsResult
}

const InventoryStoreContext = createContext<InventoryStoreValue | null>(null)

export function InventoryStoreProvider({ children }: { children: React.ReactNode }) {
  const { user, loading: authLoading } = useAuth()
  const supabase = useMemo(() => getSupabaseIfConfigured(), [])
  const [inventory, setInventory] = useState<InventoryItem[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [trashedInventory, setTrashedInventory] = useState<InventoryItem[]>([])

  // Logout must drop the in-memory ledger. Doing it here, when the session id
  // changes, clears before paint without an effect setState. Same id (token
  // refresh) does not reset.
  const sessionUserId = user?.id
  const [ledgerUserId, setLedgerUserId] = useState<string | undefined>(sessionUserId)
  if (supabase && sessionUserId !== ledgerUserId) {
    setLedgerUserId(sessionUserId)
    setInventory([])
    setTransactions([])
    setTrashedInventory([])
  }

  const refetchLedger = useCallback(
    async (opts?: { isStale?: () => boolean }) => {
      const stale = () => opts?.isStale?.() ?? false
      if (!supabase) return

      // Page past PostgREST's cap so insert-vs-update decisions see every live row.
      // A truncated ledger re-inserts unseen serials as duplicates.
      try {
        const allInvRows = await fetchAllPages((from, to) =>
          supabase
            .from("inventory_items")
            .select(INVENTORY_ITEM_SELECT)
            .is("deleted_at", null)
            .order("date_added", { ascending: true })
            .order("id", { ascending: true })
            .range(from, to)
        )
        if (stale()) return
        setInventory(allInvRows.map(rowToInventoryItem))

        const allTxnRows = await fetchAllPages((from, to) =>
          supabase
            .from("transactions")
            .select("*")
            .order("date", { ascending: false })
            .order("id", { ascending: false })
            .range(from, to)
        )
        if (!stale()) setTransactions(allTxnRows.map(rowToTransaction))
      } catch (error) {
        console.error("refetchLedger:", error)
      }
    },
    [supabase]
  )

  useEffect(() => {
    if (!supabase) return
    if (authLoading) return
    // Body reads user?.id, not the User object — do not add `user` to the deps.
    // refetchLedger does not read user; attribution uses user?.id in applyMovement.
    if (!user?.id) return
    let cancelled = false
    // setState inside refetchLedger runs only after its awaits. The rule still
    // flags the call site; restructuring the ledger fetch would be worse than
    // leaving this mount/session refetch as-is.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- ledger refetch is async; setState is after await
    void refetchLedger({ isStale: () => cancelled })
    return () => {
      cancelled = true
    }
  }, [supabase, authLoading, user?.id, refetchLedger])

  const applyMovement = useCallback(
    async (
      params: MovementParams
    ): Promise<{
      success: string[]
      notFound: string[]
      rejected: MovementRejection[]
      movementBatchId?: string
    }> => {
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
        movementMetadata,
        kitInspectionPayload,
        remediationCaseLoanerLink,
        clientDirectory,
        returnPool,
      } = params
      const clientDisplay =
        clientDisplayOverride ?? (clientId ? getClientDisplay(clientId) : "Internal")
      const newBatchId = batchId ?? `BATCH-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
      let orgTimeZone = DEFAULT_ORG_TIMEZONE
      try {
        const settings = await fetchAppSettings()
        if (settings.timezone.trim()) orgTimeZone = settings.timezone.trim()
      } catch {
        // app_settings.timezone is the source when the read succeeds. The fallback matches the column default.
      }

      // A serial missing from the loaded ledger is not new until the database says so.
      // Treating it as a create is what wrote phantom Inbounds when the insert was skipped.
      let movementLedger = inventory
      if (supabase) {
        const known = new Set(inventory.map((item) => item.serialNumber))
        const missing = [...new Set(serialNumbers.map((serial) => serial.trim()).filter((serial) => serial && !known.has(serial)))]
        if (missing.length > 0) {
          const data = await fetchAllPages((from, to) =>
            supabase
              .from("inventory_items")
              .select(INVENTORY_ITEM_SELECT)
              .in("serial_number", missing)
              .is("deleted_at", null)
              .order("id", { ascending: true })
              .range(from, to)
          )
          const found = data.map((row) => rowToInventoryItem(row))
          if (found.length > 0) movementLedger = [...inventory, ...found]
        }
      }

      const result = computeMovementResult(movementLedger, {
        type,
        serialNumbers,
        clientDisplay,
        clientId,
        clientDirectory,
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
        movementMetadata,
        orgTimeZone,
        returnPool,
      })

      if (result.saleDateError) {
        toast.error("Invalid sale date", {
          description: result.saleDateError,
          duration: 12_000,
        })
        return {
          success: [],
          notFound: [],
          rejected: [],
          movementBatchId: undefined,
        }
      }

      if (result.rejected.length > 0) {
        const preview = result.rejected.slice(0, 3)
        const more =
          result.rejected.length > 3 ? ` (+${result.rejected.length - 3} more)` : ""
        const detail = preview.map((r) => `${r.serial}: ${r.reason}`).join("; ")
        toast.warning(`Some serials were skipped${more}`, { description: detail, duration: 12_000 })
        void reportAppEvent({
          severity: "warn",
          source: "client",
          context: "movement_validation_rejected",
          message: `Stock movement rejected ${result.rejected.length} serial(s) before persist`,
          detail: detail || undefined,
          metadata: {
            movementType: type,
            batchId: newBatchId,
            requestedCount: serialNumbers.length,
            rejectedCount: result.rejected.length,
            successCount: result.success.length,
            notFoundCount: result.notFound.length,
            sampleRejected: result.rejected.slice(0, 10).map((r) => ({
              serial: r.serial,
              reason: r.reason,
            })),
          },
        })
      }

      if (result.success.length === 0) {
        void reportAppEvent({
          severity: "warn",
          source: "client",
          context: "movement_noop",
          message: "Stock movement completed with zero persisted serials",
          detail:
            result.rejected.length > 0
              ? `All serials rejected (${result.rejected.length})`
              : result.notFound.length > 0
                ? `No matching serials found (${result.notFound.length})`
                : "No eligible serials after validation",
          metadata: {
            movementType: type,
            batchId: newBatchId,
            requestedCount: serialNumbers.length,
            rejectedCount: result.rejected.length,
            notFoundCount: result.notFound.length,
            sampleRejected: result.rejected.slice(0, 10).map((r) => ({
              serial: r.serial,
              reason: r.reason,
            })),
            sampleNotFound: result.notFound.slice(0, 20),
          },
        })
        return {
          success: [],
          notFound: result.notFound,
          rejected: result.rejected,
          movementBatchId: undefined,
        }
      }

      const runPersist = async (): Promise<boolean> => {
        if (!supabase) return true
        const persistMeta = () => ({
          movementType: type,
          batchId: newBatchId,
          serialNumbers: [...serialNumbers],
        })
        const reportFail = (step: string, error: { code?: string; message: string } | null) => {
          if (!error) return false
          const friendly = humanizeStockDbError(error)
          const description = friendly ?? `${step}: ${error.message}`
          toast.error("Could not save stock movement", {
            description,
            duration: 20_000,
          })
          void reportAppEvent({
            severity: "error",
            source: "client",
            context: "movement_persist",
            message: `Stock movement persist failed: ${step}`,
            detail: error.message,
            metadata: { step, ...persistMeta(), friendly: friendly ?? null },
          })
          return true
        }
        try {
          const resolvedItems: InventoryItem[] = []
          const productLineByKey = new Map<string, string>()
          for (const item of result.updatedItems) {
            if (item.productId) {
              resolvedItems.push(item)
              continue
            }
            const vendor = item.vendor?.trim() ? item.vendor.trim() : "General"
            const key = `${item.name}\u0000${vendor}`
            let pid = productLineByKey.get(key)
            if (!pid) {
              try {
                pid = await ensureProductLine(supabase, item.name, vendor)
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e)
                toast.error("Could not save stock movement", {
                  description: `Product line: ${msg}`,
                  duration: 20_000,
                })
                void reportAppEvent({
                  severity: "error",
                  source: "client",
                  context: "movement_persist",
                  message: "Stock movement persist failed: Product line",
                  detail: msg,
                  metadata: {
                    step: "Product line",
                    ...persistMeta(),
                    productName: item.name,
                    vendor,
                  },
                })
                return false
              }
              productLineByKey.set(key, pid)
            }
            resolvedItems.push({ ...item, productId: pid })
          }

          const prevIds = new Set(movementLedger.map((i) => i.id))
          const inventoryUpserts: Database["public"]["Tables"]["inventory_items"]["Insert"][] = []
          const inventoryInserts: Database["public"]["Tables"]["inventory_items"]["Insert"][] = []
          for (const item of resolvedItems) {
            const row = inventoryItemToRow(item)
            if (prevIds.has(item.id)) inventoryUpserts.push(row)
            else inventoryInserts.push(row)
          }

          const transactionRows = result.newTransactions.map((t) => {
            const row = transactionToRow({ ...t, createdBy: user?.id })
            return t.returnPool ? { ...row, return_pool: t.returnPool } : row
          })

          let outboundBatchPayload: Database["public"]["Tables"]["outbound_batches"]["Insert"] | null = null
          if (newBatchId && (type === "POC Out" || type === "Rentals") && result.newTransactions.length > 0) {
            const txn = result.newTransactions[0]
            const dateIso = txn.date
            const dateOnly = dateIso.slice(0, 10)
            const endDate =
              type === "Rentals" && result.updatedItems[0]?.returnDate ? result.updatedItems[0].returnDate : null
            outboundBatchPayload = {
              id: newBatchId,
              type,
              client: clientDisplay,
              client_id: clientId ?? null,
              start_date: dateOnly,
              end_date: endDate,
              status: "open",
              invoice_number: invoiceNumber ?? null,
              // Transaction date is a business-date midnight. The batch row keeps the recorded instant.
              created_at: new Date().toISOString(),
            }
          }

          let kitInspectionPayloadRow: Database["public"]["Tables"]["kit_inspections"]["Insert"] | null = null
          if (
            kitInspectionPayload &&
            (type === "Inspection Pass" || type === "Inspection Fail") &&
            result.newTransactions[0]
          ) {
            kitInspectionPayloadRow = {
              inventory_item_id: kitInspectionPayload.inventoryItemId,
              serial_number: kitInspectionPayload.serialNumber,
              inspector_name: kitInspectionPayload.inspectorName.trim() || null,
              outcome: kitInspectionPayload.outcome,
              condition_notes: kitInspectionPayload.conditionNotes?.trim() || null,
              attachment_urls: kitInspectionPayload.attachmentUrls ?? [],
              transaction_id: result.newTransactions[0].id,
              created_by: user?.id ?? null,
            }
          }

          let remediationPatch: {
            id: string
            loaner_inventory_item_id: string
            loaner_serial: string
            updated_at: string
          } | null = null
          if (type === "Remediation Loaner Issue" && remediationCaseLoanerLink && result.success.length > 0) {
            remediationPatch = {
              id: remediationCaseLoanerLink.caseId,
              loaner_inventory_item_id: remediationCaseLoanerLink.loanerInventoryItemId,
              loaner_serial: remediationCaseLoanerLink.loanerSerial,
              updated_at: new Date().toISOString(),
            }
          }

          const { error } = await supabase.rpc("apply_stock_movement", {
            p_inventory_upserts: inventoryUpserts,
            p_inventory_inserts: inventoryInserts,
            p_transactions: transactionRows,
            p_outbound_batch: outboundBatchPayload,
            p_kit_inspection: kitInspectionPayloadRow,
            p_remediation_patch: remediationPatch,
          })
          if (reportFail("Atomic movement persist", error)) return false

          await refetchLedger({ isStale: () => false })
          return true
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          toast.error("Could not save stock movement", { description: msg, duration: 20_000 })
          void reportAppEvent({
            severity: "error",
            source: "client",
            context: "movement_persist",
            message: "Stock movement persist failed: unexpected error",
            detail: msg,
            metadata: { step: "unexpected", ...persistMeta() },
          })
          return false
        }
      }

      if (supabase) {
        const ok = await runPersist()
        if (!ok) {
          void refetchLedger({ isStale: () => false })
          return {
            success: [],
            notFound: result.notFound,
            rejected: result.rejected,
            movementBatchId: undefined,
          }
        }
      } else {
        setInventory((prev) => {
          const prevIds = new Set(prev.map((i) => i.id))
          const merged = prev.map((item) => {
            const u = result.updatedItems.find((x) => x.id === item.id)
            return u ?? item
          })
          const created = result.updatedItems.filter((u) => !prevIds.has(u.id))
          return [...merged, ...created]
        })
        setTransactions((prev) => [
          ...result.newTransactions.map((t) => ({ ...t, createdBy: user?.id })),
          ...prev,
        ])
      }

      return {
        success: result.success,
        notFound: result.notFound,
        rejected: result.rejected,
        movementBatchId: newBatchId,
      }
    },
    [inventory, supabase, refetchLedger, user]
  )

  const updateItem = useCallback(
    async (id: string, updates: Partial<InventoryItem>) => {
      const item = inventory.find((i) => i.id === id)
      if (!item) return
      let next: InventoryItem = { ...item, ...updates }
      if (supabase && (updates.name !== undefined || updates.vendor !== undefined)) {
        try {
          const pid = await ensureProductLine(supabase, next.name, next.vendor ?? "General")
          next = { ...next, productId: pid }
        } catch (e) {
          console.error("Supabase updateItem ensureProductLine:", e)
          return
        }
      }
      setInventory((prev) => prev.map((i) => (i.id === id ? next : i)))
      if (supabase) {
        const { error } = await supabase.from("inventory_items").update(inventoryItemPatch(next)).eq("id", id)
        if (error) console.error("Supabase updateItem error:", error)
      }
    },
    [inventory, supabase]
  )

  const refetchTrashed = useCallback(async () => {
    if (!supabase) {
      setTrashedInventory([])
      return
    }
    try {
      const data = await fetchAllPages((from, to) =>
        supabase
          .from("inventory_items")
          .select(INVENTORY_ITEM_SELECT)
          .not("deleted_at", "is", null)
          .order("deleted_at", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to)
      )
      setTrashedInventory(data.map(rowToInventoryItem))
    } catch (error) {
      console.error("refetchTrashed:", error)
    }
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
    let stale: { id: string }[]
    try {
      stale = await fetchAllPages((from, to) =>
        supabase
          .from("inventory_items")
          .select("id")
          .not("deleted_at", "is", null)
          .lt("deleted_at", cutoff)
          .order("id", { ascending: true })
          .range(from, to)
      )
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Failed to read trash" }
    }
    const ids = stale.map((r) => r.id)
    if (ids.length === 0) return { ok: true, removed: 0 }
    const { error } = await supabase.from("inventory_items").delete().in("id", ids)
    if (error) return { ok: false, error: error.message }
    await refetchTrashed()
    return { ok: true, removed: ids.length }
  }, [supabase, refetchTrashed])

  const addItem = useCallback(
    async (item: Omit<InventoryItem, "id">): Promise<InventoryItem> => {
      const vendor = item.vendor?.trim() ? item.vendor : "General"
      let productId = item.productId
      if (supabase && !productId) {
        productId = await ensureProductLine(supabase, item.name, vendor)
      }
      const newItem: InventoryItem = {
        ...item,
        status: "In Stock",
        vendor,
        id: generateId("INV"),
        productId,
      }
      if (!supabase) {
        setInventory((prev) => [...prev, newItem])
        return newItem
      }
      const businessDate = businessDateToIso((newItem.dateAdded || new Date().toISOString()).slice(0, 10))
      const txnId = generateId("TXN")
      const { error } = await supabase.rpc("apply_stock_movement", {
        p_inventory_upserts: [],
        p_inventory_inserts: [inventoryItemToRow(newItem)],
        p_transactions: [
          transactionToRow({
            id: txnId,
            type: "Inbound",
            serialNumber: newItem.serialNumber,
            itemName: newItem.name,
            client: "Internal",
            date: businessDate,
            batchId: generateId("BATCH"),
            metadata: { inboundCreated: true },
            createdBy: user?.id,
          }),
        ],
      })
      if (error) throw error
      await refetchLedger()
      return newItem
    },
    [supabase, user, refetchLedger]
  )

  const reassignInventoryItems = useCallback(
    async (params: {
      itemIds: string[]
      targetGroupName: string
      targetVendor?: string
    }): Promise<{ ok: boolean; updated: number; error?: string }> => {
      const targetName = params.targetGroupName.trim()
      if (!targetName) return { ok: false, updated: 0, error: "Target group name is required" }
      const targetVendor = params.targetVendor?.trim() || "General"
      const idSet = new Set(params.itemIds.filter(Boolean))
      if (idSet.size === 0) return { ok: false, updated: 0, error: "No items selected" }

      const affected = inventory.filter((item) => idSet.has(item.id))
      if (affected.length === 0) return { ok: true, updated: 0 }

      let updatedItems = affected.map((item) => ({
        ...item,
        name: targetName,
        vendor: targetVendor,
      }))
      if (supabase) {
        let productId: string
        try {
          productId = await ensureProductLine(supabase, targetName, targetVendor)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          return { ok: false, updated: 0, error: msg || "Failed to resolve product line" }
        }
        updatedItems = updatedItems.map((item) => ({ ...item, productId }))
      }
      const updatedMap = new Map(updatedItems.map((i) => [i.id, i]))
      setInventory((prev) => prev.map((item) => updatedMap.get(item.id) ?? item))

      if (supabase) {
        for (const item of updatedItems) {
          const { error } = await supabase.from("inventory_items").update(inventoryItemPatch(item)).eq("id", item.id)
          if (error) {
            return { ok: false, updated: 0, error: error.message || "Failed to update inventory item(s)" }
          }
        }
      }
      return { ok: true, updated: updatedItems.length }
    },
    [inventory, supabase]
  )

  const reassignInventoryGroup = useCallback(
    async (params: {
      sourceGroupName: string
      sourceVendor?: string
      targetGroupName?: string
      targetVendor?: string
    }): Promise<{ ok: boolean; updated: number; error?: string }> => {
      const source = params.sourceGroupName.trim()
      if (!source) return { ok: false, updated: 0, error: "Source group is required" }
      const sourceVendor = params.sourceVendor?.trim()
      const itemIds = inventory
        .filter((item) => {
          if (item.name !== source) return false
          if (!sourceVendor) return true
          const v = item.vendor?.trim() ? item.vendor.trim() : "General"
          return v === sourceVendor
        })
        .map((item) => item.id)
      return reassignInventoryItems({
        itemIds,
        targetGroupName: params.targetGroupName?.trim() || source,
        targetVendor: params.targetVendor,
      })
    },
    [inventory, reassignInventoryItems]
  )

  const getAlerts = useCallback(() => getAlertsFromInventory(inventory), [inventory])

  const value = useMemo<InventoryStoreValue>(
    () => ({
      inventory,
      transactions,
      applyMovement,
      updateItem,
      softDeleteItem,
      restoreItem,
      permanentlyDeleteItem,
      purgeTrashExpired,
      trashedInventory,
      refetchTrashed,
      addItem,
      reassignInventoryItems,
      reassignInventoryGroup,
      getAlerts,
      refetchLedger,
    }),
    [
      inventory,
      transactions,
      applyMovement,
      updateItem,
      softDeleteItem,
      restoreItem,
      permanentlyDeleteItem,
      purgeTrashExpired,
      trashedInventory,
      refetchTrashed,
      addItem,
      reassignInventoryItems,
      reassignInventoryGroup,
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
