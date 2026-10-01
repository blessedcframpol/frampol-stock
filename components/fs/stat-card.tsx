import { ArrowUpRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { IconButton } from "@/components/fs/icon-button"

export function StatCard({
  label,
  value,
  caption,
  href,
  linkLabel,
  variant = "default",
}: {
  label: string
  value: React.ReactNode
  caption?: string
  href?: string
  linkLabel?: string
  variant?: "default" | "highlight"
}) {
  const highlight = variant === "highlight"
  return (
    <div
      className={cn(
        "relative rounded-2xl p-5",
        highlight ? "bg-primary text-primary-foreground" : "bg-card text-card-foreground",
      )}
    >
      {href && linkLabel ? (
        <IconButton
          href={href}
          label={linkLabel}
          className={cn("absolute top-4 right-4", highlight && "bg-background text-foreground")}
        >
          <ArrowUpRight className="size-4" aria-hidden />
        </IconButton>
      ) : null}
      <p
        className={cn(
          "text-sm font-medium uppercase tracking-wide",
          highlight ? "text-primary-foreground" : "text-muted-foreground",
          href && "pr-12",
        )}
      >
        {label}
      </p>
      <p className="mt-2 text-3xl font-semibold tabular-nums tracking-tight">{value}</p>
      {caption ? (
        <p className={cn("mt-1 text-sm", highlight ? "text-primary-foreground" : "text-muted-foreground")}>
          {caption}
        </p>
      ) : null}
    </div>
  )
}
