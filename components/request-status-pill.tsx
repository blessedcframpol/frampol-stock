import { cn } from "@/lib/utils"
import { displayStatusLabel, displayStatusPillClass } from "@/lib/stock-request-statuses"

/** Pill for a request display status (being reviewed, awaiting invoice, completed, ...). */
export function RequestStatusPill({
  status,
  className,
}: {
  status: string | null | undefined
  className?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-md px-2 py-0.5 text-sm font-medium",
        displayStatusPillClass(status),
        className,
      )}
    >
      {displayStatusLabel(status)}
    </span>
  )
}
