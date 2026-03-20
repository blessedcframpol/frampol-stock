import { NextRequest, NextResponse } from "next/server"
import { getAllStockTakes, createStockTake, isStockTakesTableMissingError } from "@/lib/supabase/stock-takes-db"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import type { StockTakeSnapshot } from "@/lib/data"

export async function GET() {
  try {
    const supabase = await createServerSupabaseClient()
    const list = await getAllStockTakes(supabase)
    return NextResponse.json(list)
  } catch (error) {
    console.error("Stock takes GET error:", error)
    return NextResponse.json({ error: "Failed to load stock take history" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { resultSnapshot?: StockTakeSnapshot }
    const snapshot = body?.resultSnapshot
    if (!snapshot || !Array.isArray(snapshot.scannedSerials) || !Array.isArray(snapshot.matched) || !Array.isArray(snapshot.notInSystem) || !Array.isArray(snapshot.notScanned)) {
      return NextResponse.json(
        { error: "resultSnapshot with scannedSerials, matched, notInSystem, notScanned is required" },
        { status: 400 }
      )
    }
    const supabase = await createServerSupabaseClient()
    const record = await createStockTake(snapshot, supabase)
    return NextResponse.json(record, { status: 201 })
  } catch (error) {
    console.error("Stock takes POST error:", error)
    if (isStockTakesTableMissingError(error)) {
      return NextResponse.json(
        { error: "Stock take history is not set up. Run the stock_takes migration (013_stock_takes.sql) in your Supabase project." },
        { status: 503 }
      )
    }
    return NextResponse.json({ error: "Failed to save stock take" }, { status: 500 })
  }
}
