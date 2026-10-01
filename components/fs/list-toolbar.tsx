import { Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

export function ListToolbar({
  search,
  count,
  secondary,
  primary,
  className,
}: {
  search?: React.ReactNode
  count?: React.ReactNode
  secondary?: React.ReactNode
  primary?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between", className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        {search}
        {count != null ? <p className="text-sm text-muted-foreground tabular-nums">{count}</p> : null}
      </div>
      {(secondary || primary) && (
        <div className="flex flex-wrap items-center gap-2">
          {secondary}
          {primary}
        </div>
      )}
    </div>
  )
}

export function ListToolbarSearch({
  className,
  ...props
}: React.ComponentProps<typeof Input>) {
  return (
    <div className="relative w-full sm:max-w-xs">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input
        className={cn(
          "h-10 rounded-full border-0 bg-card pl-10 text-foreground shadow-none placeholder:text-muted-foreground",
          className,
        )}
        {...props}
      />
    </div>
  )
}
