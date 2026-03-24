import { NextRequest, NextResponse } from "next/server"
import { apiClientError, apiErrorResponse } from "@/lib/api-error-response"
import { getStockTakeById } from "@/lib/supabase/stock-takes-db"
import { createServerSupabaseClient } from "@/lib/supabase/server"

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const supabase = await createServerSupabaseClient()
    const record = await getStockTakeById(id, supabase)
    if (!record) {
      return apiClientError(404, "Stock take not found", { log: "warn" })
    }
    return NextResponse.json(record)
  } catch (error) {
    return apiErrorResponse(500, "Failed to load stock take", { cause: error, logLabel: "Stock take GET" })
  }
}
