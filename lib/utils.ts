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
