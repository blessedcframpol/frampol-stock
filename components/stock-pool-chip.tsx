import type { StockPool } from "@/lib/data"
import { cn } from "@/lib/utils"

/** Rental and demo kits are labelled. Sale is the default and has no chip. */
export function StockPoolChip({
  pool,
  className,
}: {
  pool?: StockPool | string | null
  className?: string
}) {
  if (pool !== "rental" && pool !== "demo") return null
  const label = pool === "rental" ? "Rental" : "Demo"
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-md px-1.5 py-0 text-xs font-medium",
        pool === "rental" ? "bg-info-soft text-info" : "bg-warning-soft text-warning",
        className
      )}
    >
      {label}
    </span>
  )
}
