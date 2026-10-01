import { cn } from "@/lib/utils"

/**
 * Single colour map for item statuses, movement types, request statuses,
 * log severities, and the few line-state pills already rendered in the app.
 * Unknown values stay muted so a page cannot invent a colour.
 */
export const STATUS_PILL_CLASS: Record<string, string> = {
  "In Stock": "bg-success-soft text-success",
  Sold: "bg-success-soft text-success",
  Inbound: "bg-success-soft text-success",
  Sale: "bg-success-soft text-success",
  "Inspection Pass": "bg-success-soft text-success",
  serviced: "bg-success-soft text-success",
  Active: "bg-success-soft text-success",
  "Line full": "bg-success-soft text-success",

  POC: "bg-info-soft text-info",
  "POC Out": "bg-info-soft text-info",
  "POC Return": "bg-info-soft text-info",
  "Pending Inspection": "bg-info-soft text-info",
  Decommissioned: "bg-info-soft text-info",
  in_progress: "bg-info-soft text-info",
  info: "bg-info-soft text-info",

  Rented: "bg-brand/15 text-brand",
  Rentals: "bg-brand/15 text-brand",
  "Rental Return": "bg-brand/15 text-brand",

  Maintenance: "bg-warning-soft text-warning",
  "RMA Hold": "bg-warning-soft text-warning",
  Reversal: "bg-warning-soft text-warning",
  Reversed: "bg-warning-soft text-warning",
  "Sale Return": "bg-warning-soft text-warning",
  "Remediation Loaner Issue": "bg-warning-soft text-warning",
  submitted: "bg-warning-soft text-warning",
  warn: "bg-warning-soft text-warning",
  Low: "bg-warning-soft text-warning",

  "Inspection Fail": "bg-danger-soft text-danger",
  cancelled: "bg-danger-soft text-danger",
  error: "bg-danger-soft text-danger",
  Inactive: "bg-danger-soft text-danger",

  Disposed: "bg-muted text-muted-foreground",
  Dispose: "bg-muted text-muted-foreground",
  Transfer: "bg-muted text-muted-foreground",
  draft: "bg-muted text-muted-foreground",
  invoiced: "bg-muted text-muted-foreground",
  Open: "bg-muted text-muted-foreground",
}

const FALLBACK_PILL_CLASS = "bg-muted text-muted-foreground"

export function statusPillClass(value: string): string {
  return STATUS_PILL_CLASS[value] ?? FALLBACK_PILL_CLASS
}

export function statusLabel(value: string): string {
  return value.replaceAll("_", " ")
}

export function StatusPill({
  value,
  children,
  className,
}: {
  value: string
  children?: React.ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-sm font-medium",
        statusPillClass(value),
        className,
      )}
    >
      {children ?? statusLabel(value)}
    </span>
  )
}
