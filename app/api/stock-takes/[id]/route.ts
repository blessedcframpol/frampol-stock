import { NextRequest, NextResponse } from "next/server"
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
      return NextResponse.json({ error: "Stock take not found" }, { status: 404 })
    }
    return NextResponse.json(record)
  } catch (error) {
    console.error("Stock take GET error:", error)
    return NextResponse.json({ error: "Failed to load stock take" }, { status: 500 })
  }
}
