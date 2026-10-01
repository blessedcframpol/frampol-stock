import { NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error-response"
import type { Json } from "@/lib/supabase/database.types"
import { collapseClientLabel } from "@/lib/client-label"
import { loadProfileLabels } from "@/lib/profile-labels"
import { createServerSupabaseClient } from "@/lib/supabase/server"

const MAX_PAGE = 100

export type DispatchedLine = {
  serialNumber: string
  status: string
  assignedTo: string | null
}

export type DispatchedResultKind = "batch" | "serial" | "mixed"

export type DispatchedRow = {
  id: string
  grain: "batch" | "serial"
  batchKey: string
  serialNumber: string | null
  productName: string
  movement: string | null
  clientDisplay: string
  invoiceNumber: string | null
  itemCount: number
  dateOut: string | null
  recordedAt: string | null
  deliveryNoteUrl: string | null
  recordedBy: string | null
  lines: DispatchedLine[]
}

function readBoundedInt(value: string | null, fallback: number, max: number): number {
  if (value == null || value.trim() === "") return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) return fallback
  return Math.min(parsed, max)
}

function parseCounts(value: Json | undefined): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const counts: Record<string, number> = {}
  for (const [movement, count] of Object.entries(value)) {
    if (movement && typeof count === "number") counts[movement] = count
  }
  return counts
}

function parseLine(value: Json): DispatchedLine | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const serialNumber = value.serialNumber
  if (typeof serialNumber !== "string" || !serialNumber.trim()) return null
  return {
    serialNumber,
    status: typeof value.status === "string" && value.status.trim() ? value.status : "—",
    assignedTo: typeof value.assignedTo === "string" && value.assignedTo.trim() ? value.assignedTo : null,
  }
}

function parseRow(value: Json): DispatchedRow & { createdBy: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Dispatched row is invalid")
  }
  const id = value.id
  const batchKey = value.batchKey
  const productName = value.productName
  const clientDisplay = value.clientDisplay
  if (typeof id !== "string" || typeof batchKey !== "string" || typeof productName !== "string") {
    throw new Error("Dispatched row is missing its identity")
  }
  const lines = Array.isArray(value.lines) ? value.lines.map(parseLine).filter((line): line is DispatchedLine => line != null) : []
  return {
    id,
    grain: value.grain === "serial" ? "serial" : "batch",
    batchKey,
    serialNumber: typeof value.serialNumber === "string" ? value.serialNumber : null,
    productName,
    movement: typeof value.movement === "string" ? value.movement : null,
    clientDisplay: collapseClientLabel(typeof clientDisplay === "string" ? clientDisplay : "") || "—",
    invoiceNumber: typeof value.invoiceNumber === "string" ? value.invoiceNumber : null,
    itemCount: typeof value.itemCount === "number" ? value.itemCount : lines.length,
    dateOut: typeof value.dateOut === "string" ? value.dateOut : null,
    recordedAt: typeof value.recordedAt === "string" ? value.recordedAt : null,
    deliveryNoteUrl: typeof value.deliveryNoteUrl === "string" ? value.deliveryNoteUrl : null,
    recordedBy: null,
    lines,
    createdBy: typeof value.createdBy === "string" ? value.createdBy : null,
  }
}

function parseResultKind(value: Json | undefined): DispatchedResultKind {
  if (value === "serial" || value === "mixed") return value
  return "batch"
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const limit = readBoundedInt(url.searchParams.get("limit"), 24, MAX_PAGE)
    const offset = readBoundedInt(url.searchParams.get("offset"), 0, 1_000_000)
    const supabase = await createServerSupabaseClient()
    const { data, error } = await supabase.rpc("dispatched_page", {
      p_limit: limit,
      p_offset: offset,
      p_movement: url.searchParams.get("movement"),
      p_from: url.searchParams.get("from"),
      p_to: url.searchParams.get("to"),
      p_search: url.searchParams.get("search"),
    })
    if (error) {
      return apiErrorResponse(500, "Failed to load dispatched items", {
        cause: error,
        logLabel: "dispatched page",
      })
    }
    if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.total !== "number" || !Array.isArray(data.rows)) {
      throw new Error("Dispatched page was not an object")
    }
    const parsed = data.rows.map(parseRow)
    const labels = await loadProfileLabels(
      supabase,
      parsed.map((row) => row.createdBy),
    )
    return NextResponse.json({
      total: data.total,
      resultKind: parseResultKind(data.resultKind),
      counts: parseCounts(data.counts),
      rows: parsed.map(({ createdBy, ...row }) => ({
        ...row,
        recordedBy: createdBy ? (labels.get(createdBy) ?? null) : null,
      })),
    })
  } catch (error) {
    return apiErrorResponse(500, "Failed to load dispatched items", {
      cause: error,
      logLabel: "dispatched GET",
    })
  }
}
