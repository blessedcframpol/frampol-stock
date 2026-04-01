import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { apiClientError, apiErrorResponse } from "@/lib/api-error-response"
import { isInternalLocation } from "@/lib/data"
import { reverseQuickScansByBatchId } from "@/lib/quick-scans-db"
import {
  fetchActiveMovementBatchRows,
  revertInventoryAndTransactionsForQuickScan,
} from "@/lib/quick-scan-reversal-inventory"
import { insertBatchReversal } from "@/lib/supabase/batch-reversals-db"
import { createServerSupabaseClient } from "@/lib/supabase/server"

const MIN_REASON_LENGTH = 15

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      return apiClientError(401, "Unauthorized", { log: "warn" })
    }

    const { data: profileRow } = await supabase
      .from("profiles")
      .select("role, active")
      .eq("id", user.id)
      .single()

    const profile = profileRow as { role: string | null; active: boolean } | null
    if (!profile?.active || profile.role !== "admin") {
      return apiClientError(403, "Only admins can reverse scan batches", { log: "warn" })
    }

    const body = await request.json().catch(() => ({}))
    const batchId = typeof body.batchId === "string" ? body.batchId.trim() : ""
    const reason = typeof body.reason === "string" ? body.reason.trim() : ""
    const returnLocationRaw = typeof body.returnLocation === "string" ? body.returnLocation.trim() : ""

    if (!batchId) {
      return apiClientError(400, "batchId is required")
    }
    if (reason.length < MIN_REASON_LENGTH) {
      return apiClientError(400, `Reason must be at least ${MIN_REASON_LENGTH} characters`)
    }
    if (!returnLocationRaw || !isInternalLocation(returnLocationRaw)) {
      return apiClientError(
        400,
        `returnLocation must be one of: Warehouse A, Warehouse B, Service Center`
      )
    }

    const batchRows = await fetchActiveMovementBatchRows(supabase, batchId)

    if (batchRows === null) {
      return apiErrorResponse(500, "Could not load scan batch", { logLabel: "Quick scan reverse fetch batch" })
    }

    if (batchRows.length > 0) {
      const stockResult = await revertInventoryAndTransactionsForQuickScan(supabase, {
        rows: batchRows,
        returnLocation: returnLocationRaw,
      })
      if (!stockResult.ok) {
        const requestId = randomUUID()
        const detail = stockResult.detail?.join("\n")
        return NextResponse.json(
          {
            error: stockResult.error,
            ...(detail ? { detail } : {}),
            requestId,
          },
          { status: stockResult.status }
        )
      }

      const marked = await insertBatchReversal(supabase, batchId, reason, user.id)
      if (!marked.ok) {
        return apiErrorResponse(500, "Stock was reverted but recording batch reversal failed", {
          cause: new Error(marked.message),
          logLabel: "Quick scan reverse after inventory",
        })
      }
      return NextResponse.json({ ok: true, updated: 1, inventoryReverted: true })
    }

    const fileUpdated = reverseQuickScansByBatchId(batchId, reason, user.id)
    if (fileUpdated > 0) {
      return NextResponse.json({
        ok: true,
        updated: fileUpdated,
        inventoryReverted: false,
        message: "Local scan log only — inventory was not changed (no Supabase rows for this batch).",
      })
    }

    return apiClientError(404, "No active scan rows found for this batch", { log: "warn" })
  } catch (error) {
    return apiErrorResponse(500, "Failed to reverse batch", {
      cause: error,
      logLabel: "Quick scan reverse POST",
    })
  }
}
