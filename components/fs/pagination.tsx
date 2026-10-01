import { ChevronLeft, ChevronRight } from "lucide-react"

export function Pagination({
  page,
  pageCount,
  onPageChange,
}: {
  page: number
  pageCount: number
  onPageChange: (page: number) => void
}) {
  const safeCount = Math.max(1, pageCount)
  return (
    <nav aria-label="Pagination" className="flex items-center gap-3">
      <button
        type="button"
        aria-label="Previous page"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
        className="inline-flex size-10 items-center justify-center rounded-full bg-card text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
      >
        <ChevronLeft className="size-4" aria-hidden />
      </button>
      <span className="min-w-16 text-center text-sm tabular-nums text-muted-foreground">
        {page} of {safeCount}
      </span>
      <button
        type="button"
        aria-label="Next page"
        disabled={page >= safeCount}
        onClick={() => onPageChange(page + 1)}
        className="inline-flex size-10 items-center justify-center rounded-full bg-card text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
      >
        <ChevronRight className="size-4" aria-hidden />
      </button>
    </nav>
  )
}
