import { NextRequest, NextResponse } from "next/server"
import { apiClientError, apiErrorResponse } from "@/lib/api-error-response"
import { addQuickScan, addBulkQuickScans, getAllQuickScans, deleteQuickScansByBatchId } from "@/lib/quick-scans-db"
import {
  getAllQuickScansFromSupabase,
  addQuickScanToSupabase,
  addBulkQuickScansToSupabase,
  deleteQuickScansByBatchIdFromSupabase,
} from "@/lib/supabase/quick-scans-db"
import { createServerSupabaseClient } from "@/lib/supabase/server"

export async function GET() {
  try {
    const supabase = await createServerSupabaseClient()
    const fromDb = await getAllQuickScansFromSupabase(supabase)
    const scans = fromDb ?? getAllQuickScans()
    return NextResponse.json(scans)
  } catch (error) {
    return apiErrorResponse(500, "Failed to load scans", { cause: error, logLabel: "Quick scan GET" })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const {
      serialNumber,
      serialNumbers,
      scanType,
      movementType,
      clientId,
      clientName,
      clientCompany,
      clientEmail,
      clientPhone,
      sites,
    } = body as {
      serialNumber?: string
      serialNumbers?: string[]
      scanType?: string
      movementType?: string
      clientId?: string
      clientName?: string
      clientCompany?: string
      clientEmail?: string
      clientPhone?: string
      sites?: { name?: string; address: string }[]
    }

    const productName = typeof scanType === "string" ? scanType.trim() : ""
    if (!productName) {
      return apiClientError(400, "Product or item type (what's being scanned in) is required")
    }

    const validMovementTypes = ["Inbound", "Sale", "POC Out", "POC Return", "Rental Return", "Rentals", "Transfer", "Dispose"] as const
    const movement = typeof movementType === "string" ? movementType.trim() : ""
    if (!movement || !validMovementTypes.includes(movement as (typeof validMovementTypes)[number])) {
      return apiClientError(400, "Stock movement type is required")
    }

    const outbound =
      clientId != null ||
      clientName != null ||
      clientCompany != null ||
      clientEmail != null ||
      clientPhone != null ||
      (Array.isArray(sites) && sites.length > 0)
        ? {
            clientId: typeof clientId === "string" ? clientId : undefined,
            clientName: typeof clientName === "string" ? clientName.trim() || undefined : undefined,
            clientCompany: typeof clientCompany === "string" ? clientCompany.trim() || undefined : undefined,
            clientEmail: typeof clientEmail === "string" ? clientEmail.trim() || undefined : undefined,
            clientPhone: typeof clientPhone === "string" ? clientPhone.trim() || undefined : undefined,
            sites: Array.isArray(sites)
              ? sites
                  .filter((s): s is { name?: string; address: string } => s && typeof s.address === "string" && s.address.trim() !== "")
                  .map((s) => ({ name: typeof s.name === "string" ? s.name.trim() || undefined : undefined, address: s.address.trim() }))
              : undefined,
          }
        : undefined

    const bulk = Array.isArray(serialNumbers) && serialNumbers.length > 0
    if (bulk) {
      const list = serialNumbers
        .filter((s): s is string => typeof s === "string" && s.trim() !== "")
        .map((s) => s.trim())
      const unique = [...new Set(list)]
      if (unique.length === 0) {
        return apiClientError(400, "At least one serial number is required")
      }
      const supabase = await createServerSupabaseClient()
      const existing = await getAllQuickScansFromSupabase(supabase)
      const existingSet = new Set((existing ?? getAllQuickScans()).map((s) => s.serialNumber))
      const toInsert = unique.filter((s) => !existingSet.has(s))
      const duplicates = unique.filter((s) => existingSet.has(s))
      let records: { id: string; serialNumber: string; scanType: string; scannedAt: string; movementType?: string }[] = []
      if (toInsert.length > 0) {
        const fromDb = await addBulkQuickScansToSupabase(toInsert, productName, movement, outbound, supabase)
        records = fromDb.length > 0 ? fromDb : addBulkQuickScans(toInsert, productName, movement, outbound)
      }
      return NextResponse.json(
        { recorded: records.length, records, duplicates, duplicateCount: duplicates.length },
        { status: 201 }
      )
    }

    if (!serialNumber || typeof serialNumber !== "string" || !serialNumber.trim()) {
      return apiClientError(400, "Serial number is required")
    }

    const trimmed = serialNumber.trim()
    const supabase = await createServerSupabaseClient()
    const existing = await getAllQuickScansFromSupabase(supabase)
    const existingList = existing ?? getAllQuickScans()
    if (existingList.some((s) => s.serialNumber === trimmed)) {
      return NextResponse.json(
        { duplicate: true, serialNumber: trimmed, message: "Already scanned" },
        { status: 200 }
      )
    }
    const fromDb = await addQuickScanToSupabase(trimmed, productName, movement, outbound, supabase)
    const record = fromDb ?? addQuickScan(trimmed, productName, movement, outbound)
    return NextResponse.json(record, { status: 201 })
  } catch (error) {
    return apiErrorResponse(500, "Failed to record scan", { cause: error, logLabel: "Quick scan POST" })
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const batchId = request.nextUrl.searchParams.get("batchId")
    if (!batchId?.trim()) {
      return apiClientError(400, "batchId query parameter is required")
    }
    const supabase = await createServerSupabaseClient()
    const fromDb = await deleteQuickScansByBatchIdFromSupabase(batchId, supabase)
    const deleted = fromDb > 0 ? fromDb : deleteQuickScansByBatchId(batchId)
    if (deleted === 0) {
      return apiClientError(404, "No scan(s) found for this batch", { log: "warn" })
    }
    return NextResponse.json({ ok: true, deleted })
  } catch (error) {
    return apiErrorResponse(500, "Failed to delete scan batch", {
      cause: error,
      logLabel: "Quick scan DELETE by batch",
    })
  }
}
