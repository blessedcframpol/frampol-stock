"use client"

import { useCallback, useEffect, useState } from "react"
import type { Database, Json } from "./database.types"
import type { AppSupabaseClient } from "./app-client"
import { getSupabaseClient } from "./client"
import { rowToClient } from "./clients-db"
import type { Client } from "@/lib/data"
import {
  displayStatusOrReviewState,
  isRequestDisplayStatus,
  type RequestDisplayStatus,
  type StockRequestReviewState,
} from "@/lib/stock-request-statuses"
import type { InvoiceChoice, NotInvoicedKind } from "@/lib/invoices"
import { uploadDocument } from "@/lib/upload-documents"
import { ensureProductLine } from "./product-lines"
import { fetchAllPages } from "./postgrest-page"

type SB = AppSupabaseClient

export type { StockRequestReviewState }

export type StockRequestType = "Sale" | "POC Out" | "Rentals"
export type StockRequestInvoiceStatus = "invoiced" | "pending" | "not_invoiced"
export type StockRequestInvoiceApproval = "awaiting" | "approved"
export type RejectReasonCode = "insufficient_customer_info" | "no_atlas_task" | "no_invoice" | "other"

type StockRequestDbRow = Database["public"]["Tables"]["stock_requests"]["Row"]
type StockRequestLineDbRow = Database["public"]["Tables"]["stock_request_lines"]["Row"]

export type StockRequestRow = Omit<
  StockRequestDbRow,
  "review_state" | "type" | "invoice_status" | "not_invoiced_kind" | "invoice_approval" | "reject_reason_code"
> & {
  review_state: StockRequestReviewState
  type: StockRequestType
  invoice_status: StockRequestInvoiceStatus
  not_invoiced_kind: NotInvoicedKind | null
  invoice_approval: StockRequestInvoiceApproval | null
  reject_reason_code: RejectReasonCode | null
}

export type StockRequestLineRow = StockRequestLineDbRow & {
  requires_serial: boolean
  requires_cloud_key: boolean
  vendor: string | null
}

export type StockRequestWithRelations = StockRequestRow & {
  stock_request_lines: StockRequestLineRow[]
  client?: Pick<Client, "id" | "name" | "company" | "email"> | null
}

const REQUEST_WITH_LINES_SELECT =
  "*, stock_request_lines(*, product_lines(requires_serial, requires_cloud_key, vendor))"

type ProductLineEmbed = {
  requires_serial?: boolean | null
  requires_cloud_key?: boolean | null
  vendor?: string | null
}
type LineEmbed = ProductLineEmbed | ProductLineEmbed[] | null
type LineWithEmbed = StockRequestLineDbRow & { product_lines?: LineEmbed }
type StockRequestWithLineEmbeds = StockRequestRow & { stock_request_lines: LineWithEmbed[] }

function foldProductName(name: string): string {
  return name.trim().toLowerCase()
}

function firstEmbed(embed: LineEmbed | undefined): ProductLineEmbed | null {
  if (!embed) return null
  return Array.isArray(embed) ? embed[0] ?? null : embed
}

function normalizeLines(lines: LineWithEmbed[]): StockRequestLineRow[] {
  return [...(lines ?? [])]
    .map(({ product_lines, ...line }) => {
      const pl = firstEmbed(product_lines)
      return {
        ...line,
        requires_serial: Boolean(pl?.requires_serial),
        requires_cloud_key: Boolean(pl?.requires_cloud_key),
        vendor: pl?.vendor ?? null,
      }
    })
    .sort((a, b) => a.sort_order - b.sort_order)
}

function toRows(data: unknown): StockRequestWithLineEmbeds[] {
  return (data ?? []) as StockRequestWithLineEmbeds[]
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

async function fetchClientsById(sb: SB, clientIds: string[]): Promise<Map<string, Client>> {
  const byId = new Map<string, Client>()
  if (clientIds.length === 0) return byId
  const clientsData = await fetchAllPages((from, to) =>
    sb.from("clients").select("*").in("id", clientIds).order("id", { ascending: true }).range(from, to)
  )
  for (const c of clientsData) byId.set(c.id, rowToClient(c))
  return byId
}

async function withClients(sb: SB, rows: StockRequestWithLineEmbeds[]): Promise<StockRequestWithRelations[]> {
  const byId = await fetchClientsById(sb, [...new Set(rows.map((r) => r.client_id))])
  return rows.map((r) => ({
    ...r,
    client: byId.get(r.client_id) ?? null,
    stock_request_lines: normalizeLines(r.stock_request_lines ?? []),
  }))
}

export async function fetchStockRequests(sb: SB): Promise<StockRequestWithRelations[]> {
  const { data, error } = await sb
    .from("stock_requests")
    .select(REQUEST_WITH_LINES_SELECT)
    .order("created_at", { ascending: false })
  if (error) throw error
  return withClients(sb, toRows(data))
}

export async function fetchStockRequestById(sb: SB, id: string): Promise<StockRequestWithRelations | null> {
  const { data, error } = await sb
    .from("stock_requests")
    .select(REQUEST_WITH_LINES_SELECT)
    .eq("id", id)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  const [row] = await withClients(sb, toRows([data]))
  return row ?? null
}

export async function fetchStockRequestsForClient(sb: SB, clientId: string): Promise<StockRequestWithRelations[]> {
  const { data, error } = await sb
    .from("stock_requests")
    .select(REQUEST_WITH_LINES_SELECT)
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
  if (error) throw error
  return withClients(sb, toRows(data))
}

const OPEN_REVIEW_STATES: StockRequestReviewState[] = ["submitted", "awaiting_approval"]

export async function fetchLatestOpenRequests(sb: SB, limit: number): Promise<StockRequestWithRelations[]> {
  const { data, error } = await sb
    .from("stock_requests")
    .select(REQUEST_WITH_LINES_SELECT)
    .in("review_state", OPEN_REVIEW_STATES)
    .order("created_at", { ascending: false })
    .limit(limit)
  if (error) throw error
  return withClients(sb, toRows(data))
}

/** In Stock units keyed by product_id. */
export async function fetchAvailabilityByProductIds(
  sb: SB,
  productIds: string[]
): Promise<Record<string, number>> {
  const unique = [...new Set(productIds.filter(Boolean))]
  if (unique.length === 0) return {}
  const data = await fetchAllPages((from, to) =>
    sb
      .from("inventory_items")
      .select("product_id")
      .in("product_id", unique)
      .eq("status", "In Stock")
      .order("id", { ascending: true })
      .range(from, to)
  )
  const counts: Record<string, number> = {}
  for (const id of unique) counts[id] = 0
  for (const row of data) {
    const pid = row.product_id
    if (pid) counts[pid] = (counts[pid] ?? 0) + 1
  }
  return counts
}

/** Issued units per line: active (non-reversed) transactions carrying the line id. */
export async function fetchIssuedCountsByLineId(sb: SB, lineIds: string[]): Promise<Record<string, number>> {
  if (lineIds.length === 0) return {}
  const data = await fetchAllPages((from, to) =>
    sb
      .from("active_transactions")
      .select("id, request_line_id")
      .in("request_line_id", lineIds)
      .order("id", { ascending: true })
      .range(from, to)
  )
  const counts: Record<string, number> = {}
  for (const id of lineIds) counts[id] = 0
  for (const row of data) {
    const lid = row.request_line_id
    if (lid) counts[lid] = (counts[lid] ?? 0) + 1
  }
  return counts
}

// ---------------------------------------------------------------------------
// RPC wrappers
// ---------------------------------------------------------------------------

export type RequestLineInput = {
  productName: string
  /** Catalog id; when omitted the name is fold-matched (or created under 'General'). */
  productId?: string | null
  quantity: number
}

export type RequestInvoiceInput = {
  invoiceChoice: InvoiceChoice
  invoiceNumber?: string | null
  notInvoicedReason?: string | null
  notInvoicedKind?: NotInvoicedKind | null
}

export type SubmitRequestInput = RequestInvoiceInput & {
  clientId: string
  type: StockRequestType
  returnDate?: string | null
  atlasTaskUrl: string
  quotationUrl?: string | null
  notes?: string | null
  lines: RequestLineInput[]
}

export type ResubmitRequestChanges = Partial<SubmitRequestInput>

async function linesPayload(sb: SB, lines: RequestLineInput[]): Promise<{ product_id: string; quantity: number }[]> {
  const missing = lines.map((l, i) => (l.productId ? null : i)).filter((i): i is number => i !== null)
  const resolved = missing.length
    ? await resolveProductIdsForLineNames(sb, missing.map((i) => lines[i].productName))
    : []
  const resolvedByIndex = new Map(missing.map((lineIndex, k) => [lineIndex, resolved[k]]))
  return lines.map((l, i) => ({
    product_id: l.productId || resolvedByIndex.get(i)!,
    quantity: l.quantity,
  }))
}

async function requestPayload(sb: SB, input: ResubmitRequestChanges): Promise<Record<string, Json>> {
  const out: Record<string, Json> = {}
  if (input.clientId !== undefined) out.client_id = input.clientId
  if (input.type !== undefined) out.type = input.type
  if (input.returnDate !== undefined) out.return_date = input.returnDate
  if (input.atlasTaskUrl !== undefined) out.atlas_task_url = input.atlasTaskUrl
  if (input.quotationUrl !== undefined) out.quotation_url = input.quotationUrl
  if (input.notes !== undefined) out.notes = input.notes
  if (input.invoiceChoice !== undefined) out.invoice_choice = input.invoiceChoice
  if (input.invoiceNumber !== undefined) out.invoice_number = input.invoiceNumber
  if (input.notInvoicedReason !== undefined) out.not_invoiced_reason = input.notInvoicedReason
  if (input.notInvoicedKind !== undefined) out.not_invoiced_kind = input.notInvoicedKind
  if (input.lines !== undefined) out.lines = await linesPayload(sb, input.lines)
  return out
}

/** Creates the request and its lines. Returns the new request id. */
export async function submitRequest(sb: SB, input: SubmitRequestInput): Promise<string> {
  const payload = await requestPayload(sb, input)
  const { data, error } = await sb.rpc("submit_request", { p_payload: payload })
  if (error) throw error
  return data as string
}

export async function setRequestAtlasLink(sb: SB, requestId: string, url: string): Promise<void> {
  const { error } = await sb.rpc("set_request_atlas_link", {
    p_request_id: requestId,
    p_url: url.trim(),
  })
  if (error) throw error
}

export async function approveNotInvoiced(sb: SB, requestId: string): Promise<void> {
  const { error } = await sb.rpc("approve_not_invoiced", { p_request_id: requestId })
  if (error) throw error
}

export async function rejectRequest(
  sb: SB,
  requestId: string,
  code: RejectReasonCode,
  note?: string | null
): Promise<void> {
  const { error } = await sb.rpc("reject_request", {
    p_request_id: requestId,
    p_code: code,
    p_note: note ?? null,
  })
  if (error) throw error
}

/** Keys left out keep their current value; `lines`, when present, replaces every line. */
export async function resubmitRequest(sb: SB, requestId: string, changes: ResubmitRequestChanges): Promise<void> {
  const payload = await requestPayload(sb, changes)
  const { error } = await sb.rpc("resubmit_request", { p_request_id: requestId, p_changes: payload })
  if (error) throw error
}

export async function cancelRequest(sb: SB, requestId: string, reason?: string | null): Promise<void> {
  const { error } = await sb.rpc("cancel_request", { p_request_id: requestId, p_reason: reason ?? null })
  if (error) throw error
}

export type IssueUnitScan = {
  serial: string
  lineId?: string | null
  cloudKey?: string | null
}

export type IssueUnitsResult = {
  ok: boolean
  batch_id?: string
  failures: { serial: string; reason: string }[]
  serials: string[]
}

export type PreviewIssueScanResult =
  | {
      ok: true
      serial: string
      line_id: string
      product_id: string
      product_name: string
      needs_cloud_key: boolean
      cloud_key?: string | null
      cloud_key_prompt?: string
    }
  | {
      ok: false
      serial: string
      reason: string
    }

/** Validate one scan without writing. Plain-language reason when invalid. */
export async function previewIssueScan(
  sb: SB,
  requestId: string,
  serial: string,
  alreadyScanned: string[] = [],
  cloudKey?: string | null
): Promise<PreviewIssueScanResult> {
  const { data, error } = await sb.rpc("preview_issue_scan", {
    p_request_id: requestId,
    p_serial: serial,
    p_already_scanned: alreadyScanned,
    p_cloud_key: cloudKey ?? null,
  })
  if (error) throw error
  const raw = (data ?? {}) as Partial<PreviewIssueScanResult> & { ok?: boolean; reason?: string }
  if (raw.ok) {
    return {
      ok: true,
      serial: String(raw.serial ?? serial),
      line_id: String((raw as { line_id?: string }).line_id ?? ""),
      product_id: String((raw as { product_id?: string }).product_id ?? ""),
      product_name: String((raw as { product_name?: string }).product_name ?? ""),
      needs_cloud_key: Boolean((raw as { needs_cloud_key?: boolean }).needs_cloud_key),
      cloud_key: (raw as { cloud_key?: string | null }).cloud_key ?? null,
      cloud_key_prompt: (raw as { cloud_key_prompt?: string }).cloud_key_prompt,
    }
  }
  return {
    ok: false,
    serial: String(raw.serial ?? serial),
    reason: String(raw.reason ?? "Scan was rejected"),
  }
}

/** All-or-nothing: any failing serial writes nothing and is listed in `failures`. */
export async function issueUnits(sb: SB, requestId: string, scans: IssueUnitScan[]): Promise<IssueUnitsResult> {
  const p_scans = scans.map((s) => {
    const scan: Record<string, string> = { serial: s.serial }
    if (s.lineId) scan.line_id = s.lineId
    if (s.cloudKey) scan.cloud_key = s.cloudKey
    return scan
  })
  const { data, error } = await sb.rpc("issue_units", { p_request_id: requestId, p_scans: p_scans })
  if (error) throw error
  const raw = (data ?? {}) as Partial<IssueUnitsResult>
  return {
    ok: Boolean(raw.ok),
    batch_id: raw.batch_id ?? undefined,
    failures: Array.isArray(raw.failures) ? raw.failures : [],
    serials: Array.isArray(raw.serials) ? raw.serials : [],
  }
}

export async function closeOutstanding(sb: SB, requestId: string, reason: string): Promise<void> {
  const { error } = await sb.rpc("close_outstanding", { p_request_id: requestId, p_reason: reason })
  if (error) throw error
}

export async function setRequestInvoice(sb: SB, requestId: string, input: RequestInvoiceInput): Promise<void> {
  const { error } = await sb.rpc("set_request_invoice", {
    p_request_id: requestId,
    p_choice: input.invoiceChoice,
    p_invoice_number: input.invoiceNumber ?? null,
    p_reason: input.notInvoicedReason ?? null,
    p_kind: input.notInvoicedKind ?? null,
  })
  if (error) throw error
}

// ---------------------------------------------------------------------------
// Display status, issued serials, timeline
// ---------------------------------------------------------------------------

/** Server-side display status (public.request_display_status). Null when the call fails. */
export async function fetchRequestDisplayStatus(sb: SB, requestId: string): Promise<RequestDisplayStatus | null> {
  const { data, error } = await sb.rpc("request_display_status", { p_request_id: requestId })
  if (error) throw error
  return isRequestDisplayStatus(data) ? data : null
}

const DISPLAY_STATUS_CONCURRENCY = 8

/**
 * Display status for many requests. Only `submitted` requests need the server
 * function (their status depends on issued counts); every other review_state maps
 * one-to-one, so those never cost a round trip.
 */
export async function fetchRequestDisplayStatuses(
  sb: SB,
  rows: Pick<StockRequestRow, "id" | "review_state">[]
): Promise<Record<string, RequestDisplayStatus>> {
  const out: Record<string, RequestDisplayStatus> = {}
  const needServer: string[] = []
  for (const row of rows) {
    if (row.review_state === "submitted") needServer.push(row.id)
    else out[row.id] = displayStatusOrReviewState(null, row.review_state)
  }
  let next = 0
  async function worker() {
    while (next < needServer.length) {
      const id = needServer[next++]
      try {
        out[id] = (await fetchRequestDisplayStatus(sb, id)) ?? "being_reviewed"
      } catch {
        out[id] = "being_reviewed"
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(DISPLAY_STATUS_CONCURRENCY, needServer.length) }, worker))
  return out
}

export type IssuedSerialRow = {
  transactionId: string
  serial: string
  productName: string
  lineId: string | null
  cloudKey: string | null
  issuedAt: string | null
}

/** Units issued against a request (active, non-reversed), with the cloud key held on the kit. */
export async function fetchIssuedSerialsForRequest(sb: SB, requestId: string): Promise<IssuedSerialRow[]> {
  const txns = await fetchAllPages((from, to) =>
    sb
      .from("active_transactions")
      .select("id, serial_number, item_name, request_line_id, created_at")
      .eq("request_id", requestId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to)
  )
  if (txns.length === 0) return []
  const serials = [...new Set(txns.map((t) => t.serial_number))]
  const keyBySerial = new Map<string, string>()
  try {
    const items = await fetchAllPages((from, to) =>
      sb
        .from("inventory_items")
        .select("id, serial_number, cloud_key")
        .in("serial_number", serials)
        .is("deleted_at", null)
        .order("id", { ascending: true })
        .range(from, to)
    )
    for (const item of items) {
      const key = item.cloud_key?.trim()
      if (key) keyBySerial.set(item.serial_number, key)
    }
  } catch {
    // Cloud keys are a convenience; the serial list still renders without them.
  }
  return txns.map((t) => ({
    transactionId: t.id,
    serial: t.serial_number,
    productName: t.item_name,
    lineId: t.request_line_id,
    cloudKey: keyBySerial.get(t.serial_number) ?? null,
    issuedAt: t.created_at,
  }))
}

/**
 * Request ids (newest issue first) that have units issued against them, capped at `maxRequests`.
 * One query over the supplied ids; callers pass a bounded list.
 */
export async function fetchRecentlyIssuedRequestIds(
  sb: SB,
  requestIds: string[],
  maxRequests = 5
): Promise<string[]> {
  const unique = [...new Set(requestIds)]
  if (unique.length === 0) return []
  const { data, error } = await sb
    .from("active_transactions")
    .select("request_id, created_at")
    .in("request_id", unique)
    .order("created_at", { ascending: false })
    .limit(200)
  if (error) throw error
  const out: string[] = []
  for (const row of data ?? []) {
    const id = row.request_id
    if (id && !out.includes(id)) out.push(id)
    if (out.length >= maxRequests) break
  }
  return out
}

export type StockRequestEvent = Database["public"]["Tables"]["stock_request_events"]["Row"] & {
  actorLabel: string | null
}

/** Oldest first. Actor names are best effort: RLS lets only admin and Admin viewer read other profiles. */
export async function fetchRequestEvents(sb: SB, requestId: string): Promise<StockRequestEvent[]> {
  const { data, error } = await sb
    .from("stock_request_events")
    .select("*")
    .eq("request_id", requestId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
  if (error) throw error
  const rows = data ?? []
  const labels = await fetchProfileLabels(
    sb,
    rows.map((r) => r.actor_id).filter((id): id is string => Boolean(id))
  )
  return rows.map((r) => ({ ...r, actorLabel: r.actor_id ? (labels.get(r.actor_id) ?? null) : null }))
}

/** id → display name (or email). Missing when RLS hides the profile. */
export async function fetchProfileLabels(sb: SB, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const unique = [...new Set(ids)]
  if (unique.length === 0) return out
  try {
    const { data } = await sb.from("profiles").select("id, display_name, email").in("id", unique)
    for (const p of data ?? []) {
      out.set(p.id, p.display_name?.trim() || p.email)
    }
  } catch {
    // Labels are cosmetic.
  }
  return out
}

/** Only notes and quotation_url may be written directly; everything else goes through RPCs. */
export type RequestIssueLock = {
  userId: string | null
  since: string | null
  displayName: string | null
  heldByMe: boolean
  needsTakeover: boolean
}

export type FreshIssueLockRow = {
  requestId: string
  activeUserId: string | null
  activeSince: string | null
}

function parseRequestIssueLock(data: unknown): RequestIssueLock {
  const row = (data ?? {}) as Record<string, unknown>
  return {
    userId: typeof row.user_id === "string" ? row.user_id : null,
    since: typeof row.since === "string" ? row.since : null,
    displayName: typeof row.display_name === "string" ? row.display_name : null,
    heldByMe: row.held_by_me === true,
    needsTakeover: row.needs_takeover === true,
  }
}

export async function beginRequestIssue(sb: SB, requestId: string): Promise<RequestIssueLock> {
  const { data, error } = await sb.rpc("begin_request_issue", { p_request_id: requestId })
  if (error) throw error
  return parseRequestIssueLock(data)
}

export async function takeOverRequestIssue(sb: SB, requestId: string): Promise<RequestIssueLock> {
  const { data, error } = await sb.rpc("take_over_request_issue", { p_request_id: requestId })
  if (error) throw error
  return parseRequestIssueLock(data)
}

export async function fetchFreshIssueLocks(sb: SB, requestIds: string[]): Promise<Map<string, FreshIssueLockRow>> {
  const out = new Map<string, FreshIssueLockRow>()
  const unique = [...new Set(requestIds)]
  if (unique.length === 0) return out
  const { data, error } = await sb.rpc("stock_request_fresh_issue_locks", {
    p_request_ids: unique,
  })
  if (error) throw error
  for (const row of data ?? []) {
    const r = row as {
      request_id: string
      issue_lock_active_user_id: string | null
      issue_lock_active_since: string | null
    }
    out.set(r.request_id, {
      requestId: r.request_id,
      activeUserId: r.issue_lock_active_user_id,
      activeSince: r.issue_lock_active_since,
    })
  }
  return out
}

export async function touchRequestIssue(sb: SB, requestId: string): Promise<void> {
  const { error } = await sb.rpc("touch_request_issue", { p_request_id: requestId })
  if (error) throw error
}

export async function endRequestIssue(sb: SB, requestId: string): Promise<void> {
  const { error } = await sb.rpc("end_request_issue", { p_request_id: requestId })
  if (error) throw error
}

export async function updateRequestDetails(
  sb: SB,
  requestId: string,
  args: { notes?: string | null; quotationUrl?: string | null }
): Promise<void> {
  const patch: Database["public"]["Tables"]["stock_requests"]["Update"] = {}
  if (args.notes !== undefined) patch.notes = args.notes
  if (args.quotationUrl !== undefined) patch.quotation_url = args.quotationUrl
  if (Object.keys(patch).length === 0) return
  const { error } = await sb.from("stock_requests").update(patch).eq("id", requestId)
  if (error) throw error
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

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

export async function uploadQuotationForRequest(
  requestId: string,
  file: File
): Promise<string> {
  return uploadDocument("quotation", requestId, file)
}

export function useStockRequests(): {
  list: StockRequestWithRelations[]
  loading: boolean
  error: Error | null
  refetch: () => Promise<void>
  softRefetch: () => Promise<void>
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

  const softRefetch = useCallback(async () => {
    try {
      const result = await fetchList()
      if (result.ok) setList(result.rows)
    } catch {
      // Keep the current list on background refresh failures.
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

  return { list, loading, error, refetch, softRefetch }
}
