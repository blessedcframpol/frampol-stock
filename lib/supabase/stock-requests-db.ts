"use client"

import { useCallback, useEffect, useState } from "react"
import type { Database } from "./database.types"
import type { AppSupabaseClient } from "./app-client"
import { getSupabaseClient } from "./client"
import { notifyRequestServicedByEmail } from "@/lib/notify-request-email"
import { rowToClient } from "./clients-db"
import type { Client } from "@/lib/data"
import { rowToInventoryItem } from "./inventory-db"
import type { InventoryItem } from "@/lib/data"
import type { StockRequestStatus } from "@/lib/stock-request-statuses"
import { ensureProductLine } from "./product-lines"

type SB = AppSupabaseClient

export type { StockRequestStatus }

const ALREADY_MOVED = "request has already moved on"

function assertUpdated(
  data: { id: string }[] | null,
  error: { message: string } | null
): void {
  if (error) throw error
  if (!data?.length) throw new Error(ALREADY_MOVED)
}

export type StockRequestRow = Database["public"]["Tables"]["stock_requests"]["Row"]
export type StockRequestLineRow = Database["public"]["Tables"]["stock_request_lines"]["Row"] & {
  requires_serial: boolean
}

export type StockRequestWithRelations = StockRequestRow & {
  stock_request_lines: StockRequestLineRow[]
  client?: Pick<Client, "id" | "name" | "company" | "email"> | null
}

const REQUEST_WITH_LINES_SELECT = "*, stock_request_lines(*, product_lines(requires_serial))"

type LineEmbed = { requires_serial?: boolean } | { requires_serial?: boolean }[] | null

function foldProductName(name: string): string {
  return name.trim().toLowerCase()
}

function requiresSerialFromEmbed(embed: LineEmbed): boolean {
  if (!embed) return false
  if (Array.isArray(embed)) return Boolean(embed[0]?.requires_serial)
  return Boolean(embed.requires_serial)
}

function normalizeLines(
  lines: (Database["public"]["Tables"]["stock_request_lines"]["Row"] & {
    product_lines?: LineEmbed
  })[]
): StockRequestLineRow[] {
  return [...(lines ?? [])]
    .map((l) => ({
      ...l,
      requires_serial: requiresSerialFromEmbed(l.product_lines ?? null),
    }))
    .sort((a, b) => a.sort_order - b.sort_order)
}

/**
 * Fold-match line names against the catalog in one query. Existing names reuse the
 * catalog id (no vendor argument). Genuinely new names call ensureProductLine(..., 'General').
 */
async function resolveProductIdsForLineNames(sb: SB, names: string[]): Promise<string[]> {
  const trimmed = names.map((n) => n.trim())
  const { data, error } = await sb.from("product_lines").select("id, product_name")
  if (error) throw error
  const byFold = new Map<string, string>()
  for (const row of data ?? []) {
    byFold.set(foldProductName(row.product_name), row.id)
  }
  const resolved = new Map<string, string>()
  const ids: string[] = []
  for (const name of trimmed) {
    const key = foldProductName(name)
    const cached = resolved.get(key)
    if (cached) {
      ids.push(cached)
      continue
    }
    const existing = byFold.get(key)
    if (existing) {
      resolved.set(key, existing)
      ids.push(existing)
      continue
    }
    const id = await ensureProductLine(sb, name, "General")
    resolved.set(key, id)
    byFold.set(key, id)
    ids.push(id)
  }
  return ids
}

function getSb(): SB | null {
  try {
    return getSupabaseClient()
  } catch {
    return null
  }
}

export async function fetchStockRequests(sb: SB): Promise<StockRequestWithRelations[]> {
  const { data, error } = await sb
    .from("stock_requests")
    .select(REQUEST_WITH_LINES_SELECT)
    .order("created_at", { ascending: false })
  if (error) throw error
  const rows = (data ?? []) as StockRequestWithRelations[]
  const clientIds = [...new Set(rows.map((r) => r.client_id))]
  if (clientIds.length === 0) {
    return rows.map((r) => ({
      ...r,
      stock_request_lines: normalizeLines(r.stock_request_lines ?? []),
    }))
  }
  const { data: clientsData } = await sb.from("clients").select("*").in("id", clientIds)
  const byId = new Map((clientsData ?? []).map((c) => [c.id, rowToClient(c)]))
  return rows.map((r) => ({
    ...r,
    client: byId.get(r.client_id) ?? null,
    stock_request_lines: normalizeLines(r.stock_request_lines ?? []),
  }))
}

export async function fetchStockRequestById(sb: SB, id: string): Promise<StockRequestWithRelations | null> {
  const { data, error } = await sb
    .from("stock_requests")
    .select(REQUEST_WITH_LINES_SELECT)
    .eq("id", id)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  const row = data as StockRequestWithRelations
  const { data: clientRow } = await sb.from("clients").select("*").eq("id", row.client_id).maybeSingle()
  return {
    ...row,
    client: clientRow ? rowToClient(clientRow) : null,
    stock_request_lines: normalizeLines(row.stock_request_lines ?? []),
  }
}

export async function fetchStockRequestsForClient(sb: SB, clientId: string): Promise<StockRequestWithRelations[]> {
  const { data, error } = await sb
    .from("stock_requests")
    .select(REQUEST_WITH_LINES_SELECT)
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
  if (error) throw error
  const rows = (data ?? []) as StockRequestWithRelations[]
  const { data: clientRow } = await sb.from("clients").select("*").eq("id", clientId).maybeSingle()
  const client = clientRow ? rowToClient(clientRow) : null
  return rows.map((r) => ({
    ...r,
    client,
    stock_request_lines: normalizeLines(r.stock_request_lines ?? []),
  }))
}

export async function fetchLatestOpenRequests(sb: SB, limit: number): Promise<StockRequestWithRelations[]> {
  const { data, error } = await sb
    .from("stock_requests")
    .select(REQUEST_WITH_LINES_SELECT)
    .in("status", ["submitted", "in_progress", "serviced"])
    .order("created_at", { ascending: false })
    .limit(limit)
  if (error) throw error
  const rows = (data ?? []) as StockRequestWithRelations[]
  const clientIds = [...new Set(rows.map((r) => r.client_id))]
  const byId = new Map<string, Client>()
  if (clientIds.length > 0) {
    const { data: clientsData } = await sb.from("clients").select("*").in("id", clientIds)
    for (const c of clientsData ?? []) byId.set(c.id, rowToClient(c))
  }
  return rows.map((r) => ({
    ...r,
    client: byId.get(r.client_id) ?? null,
    stock_request_lines: normalizeLines(r.stock_request_lines ?? []),
  }))
}

/** Free pool: In Stock and not reserved, keyed by product_id. */
export async function fetchAvailabilityByProductIds(
  sb: SB,
  productIds: string[]
): Promise<Record<string, number>> {
  const unique = [...new Set(productIds.filter(Boolean))]
  if (unique.length === 0) return {}
  const { data, error } = await sb
    .from("inventory_items")
    .select("product_id")
    .in("product_id", unique)
    .eq("status", "In Stock")
    .is("reserved_for_request_line_id", null)
  if (error) throw error
  const counts: Record<string, number> = {}
  for (const id of unique) counts[id] = 0
  for (const row of data ?? []) {
    const pid = row.product_id
    if (pid) counts[pid] = (counts[pid] ?? 0) + 1
  }
  return counts
}

export async function fetchAssignedCountsByLineId(sb: SB, lineIds: string[]): Promise<Record<string, number>> {
  if (lineIds.length === 0) return {}
  const { data, error } = await sb
    .from("inventory_items")
    .select("reserved_for_request_line_id")
    .in("reserved_for_request_line_id", lineIds)
  if (error) throw error
  const counts: Record<string, number> = {}
  for (const id of lineIds) counts[id] = 0
  for (const row of data ?? []) {
    const lid = row.reserved_for_request_line_id
    if (lid) counts[lid] = (counts[lid] ?? 0) + 1
  }
  return counts
}

export async function fetchInventoryItemsForAssignment(
  sb: SB,
  productId: string
): Promise<InventoryItem[]> {
  if (!productId) return []
  return fetchInventoryItemsForAssignmentByProductIds(sb, [productId])
}

/** One query for many catalog ids; caller groups by product_id. */
export async function fetchInventoryItemsForAssignmentByProductIds(
  sb: SB,
  productIds: string[]
): Promise<InventoryItem[]> {
  const unique = [...new Set(productIds.filter(Boolean))]
  if (unique.length === 0) return []
  const { data, error } = await sb
    .from("inventory_items")
    .select("*, product_lines(product_name, vendor)")
    .in("product_id", unique)
    .eq("status", "In Stock")
    .order("date_added", { ascending: true })
  if (error) throw error
  return (data ?? []).map(rowToInventoryItem)
}

export type CreateRequestInput = {
  clientId: string
  createdBy: string
  notes?: string | null
  quotationUrl?: string | null
  lines: { productName: string; quantity: number }[]
}

export async function createStockRequest(sb: SB, input: CreateRequestInput): Promise<StockRequestWithRelations> {
  const productIds = await resolveProductIdsForLineNames(
    sb,
    input.lines.map((l) => l.productName)
  )
  const { data: req, error: e1 } = await sb
    .from("stock_requests")
    .insert({
      client_id: input.clientId,
      created_by: input.createdBy,
      status: "draft",
      notes: input.notes ?? null,
      quotation_url: input.quotationUrl ?? null,
    })
    .select()
    .single()
  if (e1) throw e1

  const requestId = req.id
  const lineRows = input.lines.map((l, i) => ({
    request_id: requestId,
    product_name: l.productName.trim(),
    product_id: productIds[i],
    quantity_requested: l.quantity,
    sort_order: i,
  }))
  const { error: e2 } = await sb.from("stock_request_lines").insert(lineRows)
  if (e2) throw e2

  const full = await fetchStockRequestById(sb, requestId)
  if (!full) throw new Error("Failed to load new request")
  return full
}

export async function submitStockRequest(sb: SB, requestId: string): Promise<void> {
  const { data, error } = await sb
    .from("stock_requests")
    .update({ status: "submitted" })
    .eq("id", requestId)
    .eq("status", "draft")
    .select("id")
  assertUpdated(data, error)
}

/** Move to in_progress from submitted (start work) or serviced (recovery). */
export async function markRequestInProgress(
  sb: SB,
  requestId: string,
  fromStatus: Extract<StockRequestStatus, "submitted" | "serviced"> = "submitted"
): Promise<void> {
  const { data, error } = await sb
    .from("stock_requests")
    .update({ status: "in_progress" })
    .eq("id", requestId)
    .eq("status", fromStatus)
    .select("id")
  assertUpdated(data, error)
}

export async function markRequestServiced(
  sb: SB,
  requestId: string,
  ownerEmail?: string | null,
  fromStatus: Extract<StockRequestStatus, "submitted" | "in_progress"> = "in_progress"
): Promise<void> {
  const { data: before } = await sb.from("stock_requests").select("created_by").eq("id", requestId).single()
  const { data, error } = await sb
    .from("stock_requests")
    .update({ status: "serviced", serviced_at: new Date().toISOString() })
    .eq("id", requestId)
    .eq("status", fromStatus)
    .select("id")
  assertUpdated(data, error)
  const { error: rpcErr } = await sb.rpc("create_request_serviced_notification", { p_request_id: requestId })
  if (rpcErr) throw rpcErr
  if (before?.created_by) {
    void notifyRequestServicedByEmail({
      requestId,
      ownerUserId: before.created_by,
      ownerEmail: ownerEmail ?? null,
    })
  }
}

export async function markRequestInvoiced(
  sb: SB,
  requestId: string,
  args: { invoiceNumber: string; invoiceDocumentUrl?: string | null; invoicedBy: string }
): Promise<void> {
  const { data, error } = await sb
    .from("stock_requests")
    .update({
      status: "invoiced",
      invoice_number: args.invoiceNumber,
      invoice_document_url: args.invoiceDocumentUrl ?? null,
      invoiced_at: new Date().toISOString(),
      invoiced_by: args.invoicedBy,
    })
    .eq("id", requestId)
    .eq("status", "serviced")
    .select("id")
  assertUpdated(data, error)
}

export async function cancelStockRequest(
  sb: SB,
  requestId: string,
  fromStatus: Extract<StockRequestStatus, "draft" | "submitted" | "in_progress">
): Promise<void> {
  const { data, error } = await sb
    .from("stock_requests")
    .update({ status: "cancelled" })
    .eq("id", requestId)
    .eq("status", fromStatus)
    .select("id")
  assertUpdated(data, error)
}

export async function revertStockRequestToDraft(sb: SB, requestId: string): Promise<void> {
  const { data, error } = await sb
    .from("stock_requests")
    .update({ status: "draft" })
    .eq("id", requestId)
    .eq("status", "submitted")
    .select("id")
  assertUpdated(data, error)
}

export async function updateDraftRequest(
  sb: SB,
  requestId: string,
  args: { notes?: string | null; quotationUrl?: string | null; clientId?: string }
): Promise<void> {
  const patch: Database["public"]["Tables"]["stock_requests"]["Update"] = {}
  if (args.notes !== undefined) patch.notes = args.notes
  if (args.quotationUrl !== undefined) patch.quotation_url = args.quotationUrl
  if (args.clientId !== undefined) patch.client_id = args.clientId
  const { error } = await sb.from("stock_requests").update(patch).eq("id", requestId)
  if (error) throw error
}

export async function replaceDraftLines(
  sb: SB,
  requestId: string,
  lines: { productName: string; quantity: number }[]
): Promise<void> {
  const { error: delErr } = await sb.from("stock_request_lines").delete().eq("request_id", requestId)
  if (delErr) throw delErr
  if (lines.length === 0) return
  const productIds = await resolveProductIdsForLineNames(
    sb,
    lines.map((l) => l.productName)
  )
  const lineRows = lines.map((l, i) => ({
    request_id: requestId,
    product_name: l.productName.trim(),
    product_id: productIds[i],
    quantity_requested: l.quantity,
    sort_order: i,
  }))
  const { error: insErr } = await sb.from("stock_request_lines").insert(lineRows)
  if (insErr) throw insErr
}

export async function assignSerialToLine(sb: SB, lineId: string, inventoryItemId: string): Promise<void> {
  const { error } = await sb.rpc("assign_serial_to_request_line", {
    p_line_id: lineId,
    p_inventory_item_id: inventoryItemId,
  })
  if (error) throw error
}

export async function releaseSerialFromLine(sb: SB, inventoryItemId: string): Promise<void> {
  const { error } = await sb.rpc("release_serial_from_request_line", {
    p_inventory_item_id: inventoryItemId,
  })
  if (error) throw error
}

export type AppNotificationRow = Database["public"]["Tables"]["notifications"]["Row"]

export async function fetchUnreadNotifications(sb: SB): Promise<AppNotificationRow[]> {
  const { data, error } = await sb
    .from("notifications")
    .select("*")
    .is("read_at", null)
    .order("created_at", { ascending: false })
  if (error) throw error
  return data ?? []
}

export async function fetchAllNotifications(sb: SB, limit = 50): Promise<AppNotificationRow[]> {
  const { data, error } = await sb
    .from("notifications")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit)
  if (error) throw error
  return data ?? []
}

export async function markNotificationsRead(sb: SB, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const { error } = await sb
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .in("id", ids)
  if (error) throw error
}

export async function uploadQuotationForRequest(sb: SB, requestId: string, file: File): Promise<string> {
  const ext = file.name.split(".").pop() || "pdf"
  const path = `requests/${requestId}/quotation-${Date.now()}.${ext}`
  const { error } = await sb.storage.from("uploads").upload(path, file, {
    contentType: file.type || "application/pdf",
    upsert: false,
  })
  if (error) throw error
  const { data } = sb.storage.from("uploads").getPublicUrl(path)
  return data.publicUrl
}

export async function uploadInvoiceDocumentForRequest(sb: SB, requestId: string, file: File): Promise<string> {
  const ext = file.name.split(".").pop() || "pdf"
  const path = `requests/${requestId}/invoice-${Date.now()}.${ext}`
  const { error } = await sb.storage.from("uploads").upload(path, file, {
    contentType: file.type || "application/pdf",
    upsert: false,
  })
  if (error) throw error
  const { data } = sb.storage.from("uploads").getPublicUrl(path)
  return data.publicUrl
}

export function useStockRequests(): {
  list: StockRequestWithRelations[]
  loading: boolean
  error: Error | null
  refetch: () => Promise<void>
} {
  const [list, setList] = useState<StockRequestWithRelations[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const fetchList = useCallback(async () => {
    const sb = getSb()
    if (!sb) return { ok: false as const }
    const rows = await fetchStockRequests(sb)
    return { ok: true as const, rows }
  }, [])

  const refetch = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      const result = await fetchList()
      if (!result.ok) {
        setList([])
        return
      }
      setList(result.rows)
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
      setList([])
    } finally {
      setLoading(false)
    }
  }, [fetchList])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const result = await fetchList()
        if (cancelled) return
        if (!result.ok) {
          setList([])
          return
        }
        setList(result.rows)
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e : new Error(String(e)))
          setList([])
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [fetchList])

  return { list, loading, error, refetch }
}
