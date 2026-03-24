import { NextRequest, NextResponse } from "next/server"
import { apiClientError, apiErrorResponse } from "@/lib/api-error-response"
import { getAllStockTakes, createStockTake, isStockTakesTableMissingError } from "@/lib/supabase/stock-takes-db"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import type { StockTakeSnapshot } from "@/lib/data"

export async function GET() {
  try {
    const supabase = await createServerSupabaseClient()
    const list = await getAllStockTakes(supabase)
    return NextResponse.json(list)
  } catch (error) {
    return apiErrorResponse(500, "Failed to load stock take history", {
      cause: error,
      logLabel: "Stock takes GET",
    })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { resultSnapshot?: StockTakeSnapshot }
    const snapshot = body?.resultSnapshot
    if (!snapshot || !Array.isArray(snapshot.scannedSerials) || !Array.isArray(snapshot.matched) || !Array.isArray(snapshot.notInSystem) || !Array.isArray(snapshot.notScanned)) {
      return apiClientError(
        400,
        "resultSnapshot with scannedSerials, matched, notInSystem, notScanned is required"
      )
    }
    const supabase = await createServerSupabaseClient()
    const record = await createStockTake(snapshot, supabase)
    return NextResponse.json(record, { status: 201 })
  } catch (error) {
    if (isStockTakesTableMissingError(error)) {
      return apiClientError(
        503,
        "Stock take history is not set up. Run the stock_takes migration (013_stock_takes.sql) in your Supabase project."
      )
    }
    return apiErrorResponse(500, "Failed to save stock take", { cause: error, logLabel: "Stock takes POST" })
  }
}
