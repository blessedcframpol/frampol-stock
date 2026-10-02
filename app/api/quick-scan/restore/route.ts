import { NextRequest, NextResponse } from "next/server"
import { apiClientError, apiErrorResponse } from "@/lib/api-error-response"
import { parseRestorePlan } from "@/lib/quick-scan-reversal-inventory"
import { requireAdmin } from "@/lib/require-admin"

const MIN_REASON_LENGTH = 15
const LOG_LABEL = "batch_restore"

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdmin({
      logLabel: LOG_LABEL,
      forbiddenMessage: "Only admins can restore a batch",
    })
    if (!auth.ok) return auth.response
    const batchId = new URL(request.url).searchParams.get("batchId")?.trim() ?? ""
    if (!batchId) return apiClientError(400, "batchId is required", { logLabel: LOG_LABEL })
    const { data, error } = await auth.supabase.rpc("restore_batch_plan", { p_batch_id: batchId })
    if (error) {
      return apiErrorResponse(500, "Could not preview this restore", {
        cause: error,
        logLabel: `${LOG_LABEL} plan`,
        metadata: { batchId },
      })
    }
    return NextResponse.json(parseRestorePlan(data))
  } catch (error) {
    return apiErrorResponse(500, "Could not preview this restore", {
      cause: error,
      logLabel: `${LOG_LABEL} plan`,
    })
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAdmin({
      logLabel: LOG_LABEL,
      forbiddenMessage: "Only admins can restore a batch",
    })
    if (!auth.ok) return auth.response
    const body = await request.json().catch(() => ({}))
    const batchId = typeof body.batchId === "string" ? body.batchId.trim() : ""
    const reason = typeof body.reason === "string" ? body.reason.trim() : ""
    if (!batchId) return apiClientError(400, "batchId is required", { logLabel: LOG_LABEL })
    if (reason.length < MIN_REASON_LENGTH) {
      return apiClientError(400, `Reason must be at least ${MIN_REASON_LENGTH} characters`, {
        logLabel: LOG_LABEL,
        metadata: { batchId, reasonLength: reason.length },
      })
    }
    const { data, error } = await auth.supabase.rpc("restore_batch", {
      p_batch_id: batchId,
      p_reason: reason,
    })
    if (error) {
      const message = error.message ?? ""
      const status = /forbidden/i.test(message)
        ? 403
        : /at least 15/i.test(message)
          ? 400
          : /not reversed|blocked by later batch|inventory row is missing/i.test(message)
            ? 409
            : 500
      return apiErrorResponse(status, message || "Failed to restore batch", {
        cause: error,
        logLabel: LOG_LABEL,
        metadata: { batchId },
      })
    }
    return NextResponse.json(data)
  } catch (error) {
    return apiErrorResponse(500, "Failed to restore batch", {
      cause: error,
      logLabel: `${LOG_LABEL} unexpected`,
    })
  }
}
