import { NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error-response"
import { groupTransactionsIntoBatches } from "@/lib/transaction-batches"
import { rowToTransaction } from "@/lib/supabase/inventory-db"
import { createServerSupabaseClient } from "@/lib/supabase/server"

/** Max batch_ids per .in() query (keep small for URL length / PostgREST). */
const BATCH_ID_CHUNK = 80

export async function GET() {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: txnRows, error: txnError } = await supabase.from("transactions").select("*").order("date", { ascending: false })
    if (txnError) {
      return apiErrorResponse(500, "Failed to load transactions", { cause: txnError, logLabel: "transaction-batches GET" })
    }
    const transactions = (txnRows ?? []).map(rowToTransaction)

    const batchIds = [...new Set(transactions.map((t) => t.batchId).filter((b): b is string => !!b?.trim()))]
    const reversalByBatchId = new Map<string, { reversedAt: string; reversalReason?: string }>()

    for (let i = 0; i < batchIds.length; i += BATCH_ID_CHUNK) {
      const chunk = batchIds.slice(i, i + BATCH_ID_CHUNK)
      const { data: revRows, error: revError } = await supabase
        .from("batch_reversals")
        .select("batch_id, reversed_at, reversal_reason")
        .in("batch_id", chunk)
      if (revError) {
        console.error("transaction-batches reversal fetch:", revError)
        continue
      }
      for (const row of revRows ?? []) {
        const bid = row.batch_id as string
        if (!bid || reversalByBatchId.has(bid)) continue
        const ra = row.reversed_at as string | null
        if (!ra) continue
        reversalByBatchId.set(bid, {
          reversedAt: ra,
          reversalReason: (row.reversal_reason as string | null) ?? undefined,
        })
      }
    }

    const batches = groupTransactionsIntoBatches(transactions, reversalByBatchId)
    return NextResponse.json(batches)
  } catch (error) {
    return apiErrorResponse(500, "Failed to load transaction batches", { cause: error, logLabel: "transaction-batches GET" })
  }
}
