import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Format a date string (yyyy-mm-dd or ISO) for display as dd/mm/yyyy */
export function formatDateDDMMYYYY(dateStr: string | undefined | null): string {
  if (!dateStr || !dateStr.trim()) return "—"
  const d = new Date(dateStr.trim())
  if (Number.isNaN(d.getTime())) return dateStr
  const day = String(d.getDate()).padStart(2, "0")
  const month = String(d.getMonth() + 1).padStart(2, "0")
  const year = d.getFullYear()
  return `${day}/${month}/${year}`
}

const INVALID_FILENAME_CHARS = /[/\\?%*:|"<>]/g

/** One segment of a downloaded filename (no extension). */
export function sanitizeFilenameSegment(raw: string, maxLen = 64): string {
  const s = raw
    .trim()
    .replace(INVALID_FILENAME_CHARS, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .slice(0, maxLen)
    .replace(/-+$/, "")
    .trim()
  return s || "export"
}

/** Join sanitized parts and a yyyy-mm-dd suffix into `name-2026-04-15.csv`. */
export function buildCsvFilename(parts: string[], isoDate: string): string {
  const base = parts.map((p) => sanitizeFilenameSegment(p)).filter(Boolean).join("-")
  return `${base}-${isoDate.slice(0, 10)}.csv`
}
