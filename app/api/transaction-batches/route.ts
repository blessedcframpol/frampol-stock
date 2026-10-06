import { NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error-response"
import { getTransactionOrderGroupKey } from "@/lib/client-transactions"
import { collapseClientLabel, formatClientLabel } from "@/lib/client-label"
import { loadProfileLabels } from "@/lib/profile-labels"
import { groupTransactionsIntoBatches, type TransactionBatchLine } from "@/lib/transaction-batches"
import { displayedInvoice, invoiceBatchKey } from "@/lib/invoices"
import { invoiceStateFromRow } from "@/lib/supabase/invoices-db"
import { rowToTransaction } from "@/lib/supabase/inventory-db"
import { fetchAllPages } from "@/lib/supabase/postgrest-page"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import type { Json } from "@/lib/supabase/database.types"

/** Max ids per .in() query (keep small for URL length / PostgREST). */
const ID_CHUNK = 80
const MAX_PAGE = 100

type BatchPageEntry = {
  batchKey: string
  transactionIds: string[]
  reversedByBatchId: string | null
}

function readBoundedInt(value: string | null, fallback: number, max: number): number {
  if (value == null || value.trim() === "") return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) return fallback
  return Math.min(parsed, max)
}

function parseCounts(value: Json | undefined): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const counts: Record<string, number> = {}
  for (const [movement, count] of Object.entries(value)) {
    if (typeof count === "number") counts[movement] = count
  }
  return counts
}

function parseBatchPage(data: Json): { total: number; counts: Record<string, number>; batches: BatchPageEntry[] } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Transaction batch page was not an object")
  }
  const total = data.total
  const batches = data.batches
  if (typeof total !== "number" || !Array.isArray(batches)) {
    throw new Error("Transaction batch page is missing total or batches")
  }
  const parsed: BatchPageEntry[] = []
  for (const entry of batches) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Transaction batch page entry is invalid")
    }
    const batchKey = entry.batchKey
    const transactionIds = entry.transactionIds
    const reversedBy = entry.reversedByBatchId
    if (typeof batchKey !== "string" || !Array.isArray(transactionIds)) {
      throw new Error("Transaction batch page entry is invalid")
    }
    const ids = transactionIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    if (ids.length !== transactionIds.length) {
      throw new Error(`Batch ${batchKey} listed a row that is not an id`)
    }
    parsed.push({
      batchKey,
      transactionIds: ids,
      reversedByBatchId: typeof reversedBy === "string" && reversedBy.trim() ? reversedBy : null,
    })
  }
  return { total, counts: parseCounts(data.counts), batches: parsed }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const limit = readBoundedInt(url.searchParams.get("limit"), MAX_PAGE, MAX_PAGE)
    const offset = readBoundedInt(url.searchParams.get("offset"), 0, 1_000_000)
    const supabase = await createServerSupabaseClient()
    const movement = url.searchParams.get("movement")
    const from = url.searchParams.get("from")
    const to = url.searchParams.get("to")
    const search = url.searchParams.get("search")
    const { data, error } = await supabase.rpc("transaction_batch_page", {
      p_limit: limit,
      p_offset: offset,
      p_movement: movement,
      p_from: from,
      p_to: to,
      p_search: search,
      p_active_only: url.searchParams.get("active") === "1",
    })
    if (error) {
      return apiErrorResponse(500, "Failed to load transaction batches", {
        cause: error,
        logLabel: "transaction-batches page",
      })
    }
    const page = parseBatchPage(data)
    const ids = page.batches.flatMap((batch) => batch.transactionIds)
    const byId = new Map<string, ReturnType<typeof rowToTransaction>>()
    for (let index = 0; index < ids.length; index += ID_CHUNK) {
      const chunk = ids.slice(index, index + ID_CHUNK)
      const rows = await fetchAllPages((from, to) =>
        supabase
          .from("transactions")
          .select("*")
          .in("id", chunk)
          .order("date", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to)
      )
      for (const row of rows) byId.set(row.id, rowToTransaction(row))
    }
    if (byId.size !== ids.length) {
      throw new Error(`Batch page is incomplete: expected ${ids.length} transactions, got ${byId.size}`)
    }
    const invoiceKeys = [...new Set([...byId.values()].map((txn) => invoiceBatchKey(txn)))]
    for (let index = 0; index < invoiceKeys.length; index += ID_CHUNK) {
      const chunk = invoiceKeys.slice(index, index + ID_CHUNK)
      const { data: invoiceRows, error: invoiceError } = await supabase
        .from("batch_invoices")
        .select("*")
        .in("batch_id", chunk)
      if (invoiceError) throw new Error(invoiceError.message)
      for (const row of invoiceRows ?? []) {
        const state = invoiceStateFromRow(row)
        for (const [id, txn] of byId) {
          if (invoiceBatchKey(txn) === row.batch_id) byId.set(id, { ...txn, invoiceState: state })
        }
      }
    }

    const batchIds = [
      ...new Set(
        page.batches
          .map((batch) => (batch.batchKey.startsWith("b:") ? batch.batchKey.slice(2) : ""))
          .filter((id) => id.length > 0)
      ),
    ]
    const reversalByBatchId = new Map<
      string,
      { reversedAt: string; reversalReason?: string; reversedBy?: string; reversedByName?: string; kind?: string }
    >()
    const restoredAtByBatchId = new Map<string, string>()
    for (let index = 0; index < batchIds.length; index += ID_CHUNK) {
      const chunk = batchIds.slice(index, index + ID_CHUNK)
      const [rows, restores] = await Promise.all([
        fetchAllPages((from, to) =>
          supabase
            .from("batch_reversals")
            .select("batch_id, reversed_at, reversal_reason, reversed_by, kind")
            .in("batch_id", chunk)
            .order("batch_id", { ascending: true })
            .range(from, to)
        ),
        fetchAllPages((from, to) =>
          supabase
            .from("batch_restores")
            .select("batch_id, restored_at")
            .in("batch_id", chunk)
            .order("restored_at", { ascending: false })
            .range(from, to)
        ),
      ])
      for (const row of restores) {
        if (!row.batch_id || !row.restored_at || restoredAtByBatchId.has(row.batch_id)) continue
        restoredAtByBatchId.set(row.batch_id, row.restored_at)
      }
      for (const row of rows) {
        if (!row.batch_id || reversalByBatchId.has(row.batch_id) || !row.reversed_at) continue
        const restoredAt = restoredAtByBatchId.get(row.batch_id)
        if (restoredAt && restoredAt >= row.reversed_at) continue
        reversalByBatchId.set(row.batch_id, {
          reversedAt: row.reversed_at,
          reversalReason: row.reversal_reason ?? undefined,
          reversedBy: row.reversed_by ?? undefined,
          kind: row.kind ?? undefined,
        })
      }
    }

    const transactions = ids.map((id) => {
      const txn = byId.get(id)
      if (!txn) throw new Error(`Missing transaction ${id}`)
      return txn
    })
    const grouped = groupTransactionsIntoBatches(transactions, reversalByBatchId)
    const byKey = new Map(grouped.map((batch) => [batch.batchKey, batch]))
    const linesByKey = new Map<string, TransactionBatchLine[]>()
    for (const txn of transactions) {
      const key = getTransactionOrderGroupKey(txn)
      const list = linesByKey.get(key) ?? []
      list.push({
        serialNumber: txn.serialNumber,
        client: txn.client,
        invoiceNumber: displayedInvoice(txn) === "—" ? undefined : displayedInvoice(txn),
        date: txn.date,
        recordedAt: txn.createdAt,
        assignedTo: txn.assignedTo,
      })
      linesByKey.set(key, list)
    }
    const clientIds = [...new Set(transactions.map((txn) => txn.clientId).filter((id): id is string => Boolean(id)))]
    const clientLabels = new Map<string, string>()
    if (clientIds.length > 0) {
      const clientRows = await fetchAllPages((from, to) =>
        supabase
          .from("clients")
          .select("id, name, company")
          .in("id", clientIds)
          .order("id", { ascending: true })
          .range(from, to),
      )
      for (const row of clientRows) {
        const label = formatClientLabel(row)
        if (label) clientLabels.set(row.id, label)
      }
    }
    const labels = await loadProfileLabels(supabase, [
      ...transactions.map((txn) => txn.createdBy),
      ...[...reversalByBatchId.values()].map((row) => row.reversedBy),
    ])
    for (const row of reversalByBatchId.values()) {
      if (!row.reversedBy) continue
      row.reversedByName = labels.get(row.reversedBy)
    }
    const recordedByKey = new Map<string, string[]>()
    for (const txn of transactions) {
      const name = txn.createdBy ? labels.get(txn.createdBy) : undefined
      if (!name) continue
      const key = getTransactionOrderGroupKey(txn)
      const names = recordedByKey.get(key) ?? []
      if (!names.includes(name)) names.push(name)
      recordedByKey.set(key, names)
    }
    const batches = page.batches.map((batch) => {
      const summary = byKey.get(batch.batchKey)
      if (!summary) throw new Error(`Batch ${batch.batchKey} was missing after grouping`)
      if (summary.movementType !== "Reversal" && summary.count !== batch.transactionIds.length) {
        throw new Error(
          `Batch ${batch.batchKey} is partial: ${summary.count} of ${batch.transactionIds.length} rows`
        )
      }
      const recordedBy = recordedByKey.get(batch.batchKey)?.join(", ")
      const fromDirectory = summary.clientId ? clientLabels.get(summary.clientId) : undefined
      return {
        ...summary,
        clientDisplay: fromDirectory || collapseClientLabel(summary.clientDisplay) || summary.clientDisplay,
        reversedByBatchId: batch.reversedByBatchId,
        recordedBy,
        lines: linesByKey.get(batch.batchKey) ?? [],
      }
    })
    return NextResponse.json({ batches, total: page.total, counts: page.counts })
  } catch (error) {
    return apiErrorResponse(500, "Failed to load transaction batches", {
      cause: error,
      logLabel: "transaction-batches GET",
    })
  }
}
