import path from "node:path"
import fs from "node:fs"
import type { QuickScanRecord } from "./data"

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
  movementType?: QuickScanRecord["movementType"]
): QuickScanRecord {
  const scans = readScans()
  const id = `QSCAN-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const record: QuickScanRecord = {
    id,
    serialNumber: serialNumber.trim(),
    scanType,
    scannedAt: new Date().toISOString(),
    movementType,
  }
  scans.push(record)
  writeScans(scans)
  return record
}

export function addBulkQuickScans(
  serialNumbers: string[],
  scanType: QuickScanRecord["scanType"],
  movementType?: QuickScanRecord["movementType"]
): QuickScanRecord[] {
  const scans = readScans()
  const now = new Date().toISOString()
  const base = Date.now()
  const records: QuickScanRecord[] = serialNumbers.map((serial, i) => ({
    id: `QSCAN-${base}-${i}-${Math.random().toString(36).slice(2, 7)}`,
    serialNumber: serial.trim(),
    scanType,
    scannedAt: now,
    movementType,
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
