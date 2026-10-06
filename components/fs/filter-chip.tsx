import { X } from "lucide-react"
import { cn } from "@/lib/utils"

export type FilterChipModel = {
  id: string
  label: string
  count?: number
}

/** The number printed on a chip. Absent when the caller has no count. */
import { formatCount } from "@/lib/format-display"

export function filterChipCountText(count: number | undefined): string | null {
  if (count == null || Number.isNaN(count)) return null
  return formatCount(count)
}

/** "Clear all (n)" counts chips, not the sum of their result counts. */
export function clearAllCount(chips: readonly FilterChipModel[]): number {
  return chips.length
}

export function clearAllLabel(chips: readonly FilterChipModel[]): string {
  return `Clear all (${clearAllCount(chips)})`
}

export function FilterChip({
  label,
  count,
  onClear,
  onSelect,
  selected = false,
  className,
}: {
  label: string
  count?: number
  onClear?: () => void
  onSelect?: () => void
  selected?: boolean
  className?: string
}) {
  const countText = filterChipCountText(count)
  const classes = cn(
    "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
    selected ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground",
    className,
  )
  const body = (
    <>
      <span>{label}</span>
      {countText != null ? (
        <span className={cn("tabular-nums", selected ? "text-primary-foreground" : "text-muted-foreground")}>
          {countText}
        </span>
      ) : null}
      {onClear ? (
        <button
          type="button"
          aria-label={`Remove ${label}`}
          onClick={onClear}
          className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3" aria-hidden />
        </button>
      ) : null}
    </>
  )
  if (onSelect) {
    return (
      <button type="button" aria-pressed={selected} onClick={onSelect} className={classes}>
        {body}
      </button>
    )
  }
  return <span className={classes}>{body}</span>
}

export function FilterChipGroup({
  chips,
  onClear,
  onClearAll,
  className,
}: {
  chips: FilterChipModel[]
  onClear?: (id: string) => void
  onClearAll?: () => void
  className?: string
}) {
  if (chips.length === 0) return null
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {chips.map((chip) => (
        <FilterChip
          key={chip.id}
          label={chip.label}
          count={chip.count}
          onClear={onClear ? () => onClear(chip.id) : undefined}
        />
      ))}
      {onClearAll ? (
        <button
          type="button"
          onClick={onClearAll}
          className="text-sm text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {clearAllLabel(chips)}
        </button>
      ) : null}
    </div>
  )
}
