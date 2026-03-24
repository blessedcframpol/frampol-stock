import { NextRequest, NextResponse } from "next/server"
import { apiClientError, apiErrorResponse } from "@/lib/api-error-response"
import { deleteQuickScan } from "@/lib/quick-scans-db"
import { deleteQuickScanFromSupabase } from "@/lib/supabase/quick-scans-db"
import { createServerSupabaseClient } from "@/lib/supabase/server"

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!id?.trim()) {
      return apiClientError(400, "Scan ID is required")
    }
    const supabase = await createServerSupabaseClient()
    const fromDb = await deleteQuickScanFromSupabase(id, supabase)
    if (fromDb) {
      return NextResponse.json({ ok: true, deleted: id })
    }
    const fromFile = deleteQuickScan(id)
    if (fromFile) {
      return NextResponse.json({ ok: true, deleted: id })
    }
    return apiClientError(404, "Scan not found or could not be deleted", { log: "warn" })
  } catch (error) {
    return apiErrorResponse(500, "Failed to delete scan", { cause: error, logLabel: "Quick scan DELETE" })
  }
}
