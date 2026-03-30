import path from "node:path"
import fs from "node:fs"
import type { QuickScanRecord, ClientSite } from "./data"

export type QuickScanOutboundDetails = {
  clientId?: string
  clientName?: string
  clientCompany?: string
  clientEmail?: string
  clientPhone?: string
  sites?: ClientSite[]
}

const DATA_DIR = path.join(process.cwd(), "data")
const SCANS_FILE = path.join(DATA_DIR, "quick-scans.json")

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }
}

function readScans(): QuickScanRecord[] {
  ensureDataDir()
  if (!fs.existsSync(SCANS_FILE)) {
    return []
  }
  try {
    const raw = fs.readFileSync(SCANS_FILE, "utf-8")
    return JSON.parse(raw) as QuickScanRecord[]
  } catch {
    return []
  }
}

function writeScans(scans: QuickScanRecord[]) {
  ensureDataDir()
  fs.writeFileSync(SCANS_FILE, JSON.stringify(scans, null, 2), "utf-8")
}

export function getAllQuickScans(): QuickScanRecord[] {
  return readScans()
}

export function addQuickScan(
  serialNumber: string,
  scanType: QuickScanRecord["scanType"],
  movementType?: QuickScanRecord["movementType"],
  outbound?: QuickScanOutboundDetails
): QuickScanRecord {
  const scans = readScans()
  const id = `QSCAN-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const record: QuickScanRecord = {
    id,
    serialNumber: serialNumber.trim(),
    scanType,
    scannedAt: new Date().toISOString(),
    movementType,
    batchId: id,
    clientId: outbound?.clientId,
    clientName: outbound?.clientName,
    clientCompany: outbound?.clientCompany,
    clientEmail: outbound?.clientEmail,
    clientPhone: outbound?.clientPhone,
    sites: outbound?.sites,
  }
  scans.push(record)
  writeScans(scans)
  return record
}

export function addBulkQuickScans(
  serialNumbers: string[],
  scanType: QuickScanRecord["scanType"],
  movementType?: QuickScanRecord["movementType"],
  outbound?: QuickScanOutboundDetails
): QuickScanRecord[] {
  const scans = readScans()
  const now = new Date().toISOString()
  const base = Date.now()
  const batchId = `BATCH-${base}-${Math.random().toString(36).slice(2, 7)}`
  const records: QuickScanRecord[] = serialNumbers.map((serial, i) => ({
    id: `QSCAN-${base}-${i}-${Math.random().toString(36).slice(2, 7)}`,
    serialNumber: serial.trim(),
    scanType,
    scannedAt: now,
    movementType,
    batchId,
    clientId: outbound?.clientId,
    clientName: outbound?.clientName,
    clientCompany: outbound?.clientCompany,
    clientEmail: outbound?.clientEmail,
    clientPhone: outbound?.clientPhone,
    sites: outbound?.sites,
  }))
  scans.push(...records)
  writeScans(scans)
  return records
}

export function deleteQuickScan(id: string): boolean {
  const scans = readScans()
  const idx = scans.findIndex((s) => s.id === id)
  if (idx === -1) return false
  scans.splice(idx, 1)
  writeScans(scans)
  return true
}

export function deleteQuickScansByBatchId(batchId: string): number {
  const scans = readScans()
  const before = scans.length
  const next = scans.filter((s) => (s.batchId ?? s.id) !== batchId)
  const removed = before - next.length
  if (removed > 0) writeScans(next)
  return removed
}

/** Soft-reverse all rows in a batch (local JSON store). Returns count updated. */
export function reverseQuickScansByBatchId(batchId: string, reason: string, reversedBy: string): number {
  const scans = readScans()
  const now = new Date().toISOString()
  let n = 0
  const next = scans.map((s) => {
    const key = s.batchId ?? s.id
    const matches = key === batchId || s.id === batchId
    if (!matches || s.reversedAt) return s
    n++
    return { ...s, reversedAt: now, reversalReason: reason, reversedBy }
  })
  if (n > 0) writeScans(next)
  return n
}
