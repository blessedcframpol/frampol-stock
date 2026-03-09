import type { QuickScanRecord } from "@/lib/data"
import { getSupabaseClient } from "./client"

function generateId(): string {
  return `QSCAN-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export async function getAllQuickScansFromSupabase(): Promise<QuickScanRecord[] | null> {
  try {
    const supabase = getSupabaseClient()
    const { data, error } = await supabase.from("quick_scans").select("*").order("scanned_at", { ascending: false })
    if (error) {
      console.error("Supabase quick_scans select error:", error)
      return null
    }
    return (data ?? []).map((row) => ({
      id: row.id,
      serialNumber: row.serial_number,
      scanType: row.scan_type,
      scannedAt: row.scanned_at,
      movementType: row.movement_type ?? undefined,
    }))
  } catch {
    return null
  }
}

export async function addQuickScanToSupabase(
  serialNumber: string,
  scanType: string,
  movementType?: string
): Promise<QuickScanRecord | null> {
  try {
    const supabase = getSupabaseClient()
    const record: QuickScanRecord = {
      id: generateId(),
      serialNumber: serialNumber.trim(),
      scanType,
      scannedAt: new Date().toISOString(),
      movementType: movementType as QuickScanRecord["movementType"],
    }
    const { error } = await supabase.from("quick_scans").insert({
      id: record.id,
      serial_number: record.serialNumber,
      scan_type: record.scanType,
      scanned_at: record.scannedAt,
      movement_type: movementType ?? null,
    })
    if (error) {
      console.error("Supabase quick_scans insert error:", error)
      return null
    }
    return record
  } catch {
    return null
  }
}

export async function addBulkQuickScansToSupabase(
  serialNumbers: string[],
  scanType: string,
  movementType?: string
): Promise<QuickScanRecord[]> {
  if (serialNumbers.length === 0) return []
  try {
    const supabase = getSupabaseClient()
    const now = new Date().toISOString()
    const records: QuickScanRecord[] = serialNumbers.map((serial) => ({
      id: generateId(),
      serialNumber: serial.trim(),
      scanType,
      scannedAt: now,
      movementType: movementType as QuickScanRecord["movementType"],
    }))
    const rows = records.map((r) => ({
      id: r.id,
      serial_number: r.serialNumber,
      scan_type: r.scanType,
      scanned_at: r.scannedAt,
      movement_type: movementType ?? null,
    }))
    const { error } = await supabase.from("quick_scans").insert(rows)
    if (error) {
      console.error("Supabase quick_scans bulk insert error:", error)
      return []
    }
    return records
  } catch {
    return []
  }
}

export async function deleteQuickScanFromSupabase(id: string): Promise<boolean> {
  try {
    const supabase = getSupabaseClient()
    const { error } = await supabase.from("quick_scans").delete().eq("id", id)
    if (error) {
      console.error("Supabase quick_scans delete error:", error)
      return false
    }
    return true
  } catch {
    return false
  }
}
