import { NextRequest, NextResponse } from "next/server"
import { addQuickScan, addBulkQuickScans, getAllQuickScans } from "@/lib/quick-scans-db"
import { getAllQuickScansFromSupabase, addQuickScanToSupabase, addBulkQuickScansToSupabase } from "@/lib/supabase/quick-scans-db"

export async function GET() {
  try {
    const fromDb = await getAllQuickScansFromSupabase()
    const scans = fromDb ?? getAllQuickScans()
    return NextResponse.json(scans)
  } catch (error) {
    console.error("Quick scan GET error:", error)
    return NextResponse.json({ error: "Failed to load scans" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { serialNumber, serialNumbers, scanType, movementType } = body as {
      serialNumber?: string
      serialNumbers?: string[]
      scanType?: string
      movementType?: string
    }

    const productName = typeof scanType === "string" ? scanType.trim() : ""
    if (!productName) {
      return NextResponse.json(
        { error: "Product or item type is required" },
        { status: 400 }
      )
    }

    const bulk = Array.isArray(serialNumbers) && serialNumbers.length > 0
    if (bulk) {
      const list = serialNumbers
        .filter((s): s is string => typeof s === "string" && s.trim() !== "")
        .map((s) => s.trim())
      const unique = [...new Set(list)]
      if (unique.length === 0) {
        return NextResponse.json(
          { error: "At least one serial number is required" },
          { status: 400 }
        )
      }
      const existing = await getAllQuickScansFromSupabase()
      const existingSet = new Set((existing ?? getAllQuickScans()).map((s) => s.serialNumber))
      const toInsert = unique.filter((s) => !existingSet.has(s))
      const duplicates = unique.filter((s) => existingSet.has(s))
      let records: { id: string; serialNumber: string; scanType: string; scannedAt: string; movementType?: string }[] = []
      if (toInsert.length > 0) {
        const fromDb = await addBulkQuickScansToSupabase(toInsert, productName, movementType)
        records = fromDb.length > 0 ? fromDb : addBulkQuickScans(toInsert, productName, movementType)
      }
      return NextResponse.json(
        { recorded: records.length, records, duplicates, duplicateCount: duplicates.length },
        { status: 201 }
      )
    }

    if (!serialNumber || typeof serialNumber !== "string" || !serialNumber.trim()) {
      return NextResponse.json(
        { error: "Serial number is required" },
        { status: 400 }
      )
    }

    const trimmed = serialNumber.trim()
    const existing = await getAllQuickScansFromSupabase()
    const existingList = existing ?? getAllQuickScans()
    if (existingList.some((s) => s.serialNumber === trimmed)) {
      return NextResponse.json(
        { duplicate: true, serialNumber: trimmed, message: "Already scanned" },
        { status: 200 }
      )
    }
    const fromDb = await addQuickScanToSupabase(trimmed, productName, movementType)
    const record = fromDb ?? addQuickScan(trimmed, productName, movementType)
    return NextResponse.json(record, { status: 201 })
  } catch (error) {
    console.error("Quick scan POST error:", error)
    return NextResponse.json({ error: "Failed to record scan" }, { status: 500 })
  }
}
