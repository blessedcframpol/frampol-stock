import { NextRequest, NextResponse } from "next/server"
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
      return NextResponse.json(
        { error: "Scan ID is required" },
        { status: 400 }
      )
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
    return NextResponse.json(
      { error: "Scan not found or could not be deleted" },
      { status: 404 }
    )
  } catch (error) {
    console.error("Quick scan DELETE error:", error)
    return NextResponse.json(
      { error: "Failed to delete scan" },
      { status: 500 }
    )
  }
}
