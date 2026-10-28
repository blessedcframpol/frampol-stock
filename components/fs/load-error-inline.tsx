"use client"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** Inline failed-load affordance — never leave a skeleton spinning forever. */
export function LoadErrorInline({
  onRetry,
  message = "Couldn't load",
  className,
}: {
  onRetry: () => void
  message?: string
  className?: string
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-center justify-center gap-x-1 gap-y-2 py-10 text-sm text-muted-foreground",
        className,
      )}
    >
      <span>{message}</span>
      <span aria-hidden>—</span>
      <Button type="button" variant="link" className="h-auto p-0 text-sm text-brand" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}
