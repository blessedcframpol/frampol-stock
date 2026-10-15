import { cn } from "@/lib/utils"

export function AtlasLinkPendingPill({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-md border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-950 dark:text-amber-100",
        className,
      )}
    >
      Atlas link pending
    </span>
  )
}
