import type { QuickScanRecord, ClientSite } from "@/lib/data"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "./database.types"
import { getSupabaseClient } from "./client"

function getClient(serverClient?: SupabaseClient<Database> | null) {
  return serverClient ?? getSupabaseClient()
}

export type QuickScanOutboundDetails = {
  clientId?: string
  clientName?: string
  clientCompany?: string
  clientEmail?: string
  clientPhone?: string
  sites?: ClientSite[]
}

function generateId(): string {
  return `QSCAN-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export async function getAllQuickScansFromSupabase(serverClient?: SupabaseClient<Database> | null): Promise<QuickScanRecord[] | null> {
  try {
    const supabase = getClient(serverClient)
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
      batchId: row.batch_id ?? undefined,
      clientId: row.client_id ?? undefined,
      clientName: row.client_name ?? undefined,
      clientCompany: row.client_company ?? undefined,
      clientEmail: row.client_email ?? undefined,
      clientPhone: row.client_phone ?? undefined,
      sites: row.sites ?? undefined,
      reversedAt: row.reversed_at ?? undefined,
      reversalReason: row.reversal_reason ?? undefined,
      reversedBy: row.reversed_by ?? undefined,
    }))
  } catch {
    return null
  }
}

export async function addQuickScanToSupabase(
  serialNumber: string,
  scanType: string,
  movementType?: string,
  outbound?: QuickScanOutboundDetails,
  serverClient?: SupabaseClient<Database> | null
): Promise<QuickScanRecord | null> {
  try {
    const supabase = getClient(serverClient)
    const record: QuickScanRecord = {
      id: generateId(),
      serialNumber: serialNumber.trim(),
      scanType,
      scannedAt: new Date().toISOString(),
      movementType: movementType as QuickScanRecord["movementType"],
      batchId: undefined,
      clientId: outbound?.clientId,
      clientName: outbound?.clientName,
      clientCompany: outbound?.clientCompany,
      clientEmail: outbound?.clientEmail,
      clientPhone: outbound?.clientPhone,
      sites: outbound?.sites,
    }
    const batchId = record.id
    record.batchId = batchId
    const { error } = await supabase.from("quick_scans").insert({
      id: record.id,
      serial_number: record.serialNumber,
      scan_type: record.scanType,
      scanned_at: record.scannedAt,
      movement_type: movementType ?? null,
      batch_id: batchId,
      client_id: outbound?.clientId ?? null,
      client_name: outbound?.clientName ?? null,
      client_company: outbound?.clientCompany ?? null,
      client_email: outbound?.clientEmail ?? null,
      client_phone: outbound?.clientPhone ?? null,
      sites: outbound?.sites ?? null,
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

function generateBatchId(): string {
  return `BATCH-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export async function addBulkQuickScansToSupabase(
  serialNumbers: string[],
  scanType: string,
  movementType?: string,
  outbound?: QuickScanOutboundDetails,
  serverClient?: SupabaseClient<Database> | null
): Promise<QuickScanRecord[]> {
  if (serialNumbers.length === 0) return []
  try {
    const supabase = getClient(serverClient)
    const now = new Date().toISOString()
    const batchId = generateBatchId()
    const records: QuickScanRecord[] = serialNumbers.map((serial) => ({
      id: generateId(),
      serialNumber: serial.trim(),
      scanType,
      scannedAt: now,
      movementType: movementType as QuickScanRecord["movementType"],
      batchId,
      clientId: outbound?.clientId,
      clientName: outbound?.clientName,
      clientCompany: outbound?.clientCompany,
      clientEmail: outbound?.clientEmail,
      clientPhone: outbound?.clientPhone,
      sites: outbound?.sites,
    }))
    const rows = records.map((r) => ({
      id: r.id,
      serial_number: r.serialNumber,
      scan_type: r.scanType,
      scanned_at: r.scannedAt,
      movement_type: movementType ?? null,
      batch_id: batchId,
      client_id: outbound?.clientId ?? null,
      client_name: outbound?.clientName ?? null,
      client_company: outbound?.clientCompany ?? null,
      client_email: outbound?.clientEmail ?? null,
      client_phone: outbound?.clientPhone ?? null,
      sites: outbound?.sites ?? null,
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

export async function deleteQuickScanFromSupabase(id: string, serverClient?: SupabaseClient<Database> | null): Promise<boolean> {
  try {
    const supabase = getClient(serverClient)
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

/** Mark all quick_scans rows in a batch as reversed (audit trail). Returns rows updated. */
export async function reverseQuickScanBatchInSupabase(
  batchId: string,
  reason: string,
  reversedByUserId: string,
  serverClient: SupabaseClient<Database>
): Promise<number> {
  try {
    const now = new Date().toISOString()
    const { data, error } = await serverClient
      .from("quick_scans")
      .update({
        reversed_at: now,
        reversal_reason: reason,
        reversed_by: reversedByUserId,
      })
      .or(`batch_id.eq.${batchId},id.eq.${batchId}`)
      .is("reversed_at", null)
      .select("id")
    if (error) {
      console.error("Supabase quick_scans reverse batch error:", error)
      return 0
    }
    return data?.length ?? 0
  } catch {
    return 0
  }
}

/** Delete all records in a batch (batchId) or a single record by id (for legacy/single scans). */
export async function deleteQuickScansByBatchIdFromSupabase(batchId: string, serverClient?: SupabaseClient<Database> | null): Promise<number> {
  try {
    const supabase = getClient(serverClient)
    const isBatchKey = batchId.startsWith("BATCH-")
    const { data, error } = isBatchKey
      ? await supabase.from("quick_scans").delete().eq("batch_id", batchId).select("id")
      : await supabase.from("quick_scans").delete().eq("id", batchId).select("id")
    if (error) {
      console.error("Supabase quick_scans delete by batch/id error:", error)
      return 0
    }
    return data?.length ?? 0
  } catch {
    return 0
  }
}
