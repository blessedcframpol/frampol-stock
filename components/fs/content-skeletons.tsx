import { Skeleton } from "@/components/ui/skeleton"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { cn } from "@/lib/utils"

/** Matches StatCard: p-5 + label + 3xl value + caption line reserved. */
export const STAT_CARD_MIN_H = "min-h-[7.25rem]"

/** Stat tiles matching StatCard padding / type scale. */
export function StatCardsSkeleton({ count = 4, className }: { count?: number; className?: string }) {
  return (
    <div className={cn("grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4", className)}>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className={cn(
            "rounded-2xl bg-card p-5 flex flex-col justify-start",
            STAT_CARD_MIN_H,
            i === 0 && "bg-primary/10",
          )}
        >
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="mt-2 h-8 w-16" />
          <Skeleton className="mt-1 h-3.5 w-36" />
        </div>
      ))}
    </div>
  )
}

/** Table body placeholder — fixed h-10 rows matching list tables. */
export function TableBodySkeleton({
  rows = 8,
  cols = 5,
  className,
}: {
  rows?: number
  cols?: number
  className?: string
}) {
  return (
    <div className={cn("rounded-lg border border-border overflow-hidden", className)} aria-hidden>
      <div className="flex gap-3 border-b border-border bg-muted/30 px-3 h-10 items-center">
        {Array.from({ length: cols }, (_, i) => (
          <Skeleton key={i} className={cn("h-3", i === cols - 1 ? "w-12 ml-auto" : "flex-1 max-w-[7rem]")} />
        ))}
      </div>
      <div className="divide-y divide-border bg-card">
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} className="flex items-center gap-3 px-3 h-10">
            {Array.from({ length: cols }, (_, c) => (
              <Skeleton
                key={c}
                className={cn("h-3", c === cols - 1 ? "w-10 ml-auto" : "flex-1 max-w-[9rem]")}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Client directory rows: avatar + two text lines — fixed h-14. */
export function ClientRowsSkeleton({ rows = 24, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("rounded-lg border border-border bg-card divide-y divide-border", className)} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 h-14">
          <Skeleton className="size-9 rounded-full shrink-0" />
          <div className="flex-1 min-w-0 space-y-1.5">
            <Skeleton className="h-3.5 w-40 max-w-[55%]" />
            <Skeleton className="h-3 w-28 max-w-[40%]" />
          </div>
          <Skeleton className="h-3 w-12 hidden sm:block shrink-0" />
          <Skeleton className="h-3 w-16 hidden md:block shrink-0" />
        </div>
      ))}
    </div>
  )
}

/** Latest-requests / To-issue list rows — fixed py-3 row height (~52px). */
export function RequestPreviewSkeleton({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col min-h-[312px]", className)} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className={cn(
            "flex items-center gap-3 h-[52px]",
            i < rows - 1 && "border-b border-border",
          )}
        >
          <Skeleton className="size-8 rounded-lg shrink-0" />
          <div className="flex-1 min-w-0 space-y-1.5">
            <Skeleton className="h-3.5 w-[70%] max-w-[14rem]" />
            <Skeleton className="h-3 w-[45%] max-w-[10rem]" />
          </div>
          <div className="shrink-0 space-y-1.5 flex flex-col items-end">
            <Skeleton className="h-5 w-16 rounded-full" />
            <Skeleton className="h-2.5 w-10" />
          </div>
        </div>
      ))}
    </div>
  )
}

/** Chart card shell — reserved plot height so swap does not shift layout. */
export function ChartCardSkeleton({
  className,
  tall,
}: {
  className?: string
  tall?: boolean
}) {
  // Match dashboard-charts plot boxes (220 / 240–280).
  const plotH = tall ? "h-[240px] sm:h-[280px]" : "h-[220px]"
  return (
    <Card className={cn("h-full flex flex-col", className)}>
      <CardHeader className="pb-2 shrink-0 h-10">
        <Skeleton className="h-4 w-36" />
      </CardHeader>
      <CardContent className="flex-1">
        <Skeleton className={cn("w-full rounded-lg", plotH)} />
      </CardContent>
    </Card>
  )
}

/**
 * Fixed (not min) slots so queue / pending cards cannot grow the page and
 * spike CLS when display statuses settle. Overflow scrolls inside the slot.
 */
export const TO_ISSUE_QUEUE_SLOT_H = "h-[420px]"
export const PENDING_INVOICE_SLOT_H = "h-[13rem]"

export function ToIssueQueueSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card p-4 space-y-3 overflow-hidden",
        TO_ISSUE_QUEUE_SLOT_H,
        className,
      )}
      aria-hidden
    >
      <Skeleton className="h-4 w-40" />
      <div className="space-y-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  )
}

export function PendingInvoiceSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card p-4 space-y-3 overflow-hidden",
        PENDING_INVOICE_SLOT_H,
        className,
      )}
      aria-hidden
    >
      <Skeleton className="h-4 w-64 max-w-full" />
      <Skeleton className="h-3 w-40" />
      <Skeleton className="h-3 w-52" />
      <Skeleton className="h-3 w-44" />
    </div>
  )
}

/** Batch / kit drawer body while detail loads. */
export function DrawerBodySkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-1 flex-col gap-4 px-4 py-4 min-h-[320px]", className)} aria-hidden>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="space-y-2 h-10">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-4 w-28" />
          </div>
        ))}
      </div>
      <Skeleton className="h-8 w-40" />
      <div className="space-y-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    </div>
  )
}

export function ClientDetailHeaderSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("rounded-lg border border-border bg-card p-4 md:p-5 space-y-4 min-h-[11rem]", className)} aria-hidden>
      <Skeleton className="h-7 w-48 max-w-[70%]" />
      <Skeleton className="h-4 w-32" />
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="space-y-2 rounded-lg bg-muted/40 p-3 min-h-[4.5rem]">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-5 w-10" />
          </div>
        ))}
      </div>
    </div>
  )
}
