import { NextRequest, NextResponse } from "next/server"
import { apiClientError, apiErrorResponse } from "@/lib/api-error-response"
import { isInternalLocation } from "@/lib/data"
import {
  fetchActiveBatchTransactions,
  getQuickScanBatchReversalCompleteness,
  revertInventoryAndTransactionsForQuickScan,
} from "@/lib/quick-scan-reversal-inventory"
import { requireAdmin } from "@/lib/require-admin"

const MIN_REASON_LENGTH = 15
const LOG_LABEL = "batch_reversal"

function reversalMeta(batchId: string, extra?: Record<string, unknown>) {
  return { batchId, ...(extra ?? {}) }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAdmin({
      logLabel: LOG_LABEL,
      forbiddenMessage: "Only admins can reverse scan batches",
    })
    if (!auth.ok) return auth.response
    const { user, supabase } = auth

    const body = await request.json().catch(() => ({}))
    const batchId = typeof body.batchId === "string" ? body.batchId.trim() : ""
    const reason = typeof body.reason === "string" ? body.reason.trim() : ""
    const returnLocationRaw = typeof body.returnLocation === "string" ? body.returnLocation.trim() : ""

    if (!batchId) {
      return apiClientError(400, "batchId is required", { logLabel: LOG_LABEL })
    }
    if (reason.length < MIN_REASON_LENGTH) {
      return apiClientError(400, `Reason must be at least ${MIN_REASON_LENGTH} characters`, {
        logLabel: LOG_LABEL,
        metadata: reversalMeta(batchId, { reasonLength: reason.length }),
      })
    }
    if (!returnLocationRaw || !isInternalLocation(returnLocationRaw)) {
      return apiClientError(
        400,
        `returnLocation must be one of: Warehouse A, Warehouse B, Service Center`,
        {
          logLabel: LOG_LABEL,
          metadata: reversalMeta(batchId, { returnLocation: returnLocationRaw || null }),
        }
      )
    }

    const batchTxns = await fetchActiveBatchTransactions(supabase, batchId)

    if (batchTxns === null) {
      return apiErrorResponse(500, "Could not load scan batch", {
        logLabel: `${LOG_LABEL} fetch_batch`,
        metadata: reversalMeta(batchId),
      })
    }

    if (batchTxns.length > 0) {
      const stockResult = await revertInventoryAndTransactionsForQuickScan(supabase, {
        batchId,
        batchTxns,
        returnLocation: returnLocationRaw,
        reversalReason: reason,
        createdBy: user.id,
      })
      if (!stockResult.ok) {
        return apiErrorResponse(stockResult.status, stockResult.error, {
          logLabel: LOG_LABEL,
          detail: stockResult.detail?.join("\n"),
          metadata: reversalMeta(batchId, {
            returnLocation: returnLocationRaw,
            movementType: batchTxns[0]?.movement_type ?? null,
            batchTxnCount: batchTxns.length,
          }),
        })
      }

      return NextResponse.json({
        ok: true,
        updated: stockResult.reversedCount,
        alreadyReversed: stockResult.alreadyReversedCount,
        requested: stockResult.requestedCount,
        reversedSerials: stockResult.reversedSerials,
        alreadyReversedSerials: stockResult.alreadyReversedSerials,
        reversalBatchId: stockResult.reversalBatchId,
        inventoryReverted: stockResult.reversedCount > 0,
        message:
          stockResult.reversedCount === 0 && stockResult.alreadyReversedCount > 0
            ? "This batch was already reversed."
            : undefined,
      })
    }

    const completeness = await getQuickScanBatchReversalCompleteness(supabase, batchId)
    if (!completeness) {
      return apiErrorResponse(500, "Could not verify batch reversal completeness", {
        logLabel: `${LOG_LABEL} completeness_check`,
        metadata: reversalMeta(batchId),
      })
    }
    if (completeness.batchReversalExists && completeness.remainingTransactions === 0) {
      return NextResponse.json({
        ok: true,
        updated: 0,
        alreadyReversed: true,
        requested: 0,
        inventoryReverted: false,
        message: "This batch was already reversed.",
      })
    }
    if (completeness.remainingTransactions > 0) {
      const detail = [
        `Remaining transaction rows in batch: ${completeness.remainingTransactions}.`,
        ...(completeness.nonRevertedSerials.length > 0
          ? [`Non-reverted serial(s): ${completeness.nonRevertedSerials.join(", ")}`]
          : []),
      ]
      return apiErrorResponse(409, "Batch reversal is incomplete — manual follow-up required.", {
        logLabel: `${LOG_LABEL} incomplete`,
        detail: detail.join("\n"),
        metadata: reversalMeta(batchId, {
          remainingTransactions: completeness.remainingTransactions,
          nonRevertedSerialCount: completeness.nonRevertedSerials.length,
        }),
      })
    }

    return apiClientError(404, "No active scan rows found for this batch", {
      log: "warn",
      logLabel: LOG_LABEL,
      metadata: reversalMeta(batchId),
    })
  } catch (error) {
    return apiErrorResponse(500, "Failed to reverse batch", {
      cause: error,
      logLabel: `${LOG_LABEL} unexpected`,
    })
  }
}
