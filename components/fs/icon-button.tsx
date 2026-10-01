import Link from "next/link"
import { cn } from "@/lib/utils"

const iconButtonClass =
  "inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-card text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"

export function IconButton({
  label,
  href,
  className,
  children,
  ...props
}: {
  label: string
  href?: string
  className?: string
  children: React.ReactNode
} & Omit<React.ComponentProps<"button">, "children" | "aria-label">) {
  if (href) {
    return (
      <Link href={href} aria-label={label} className={cn(iconButtonClass, className)}>
        {children}
      </Link>
    )
  }
  return (
    <button type="button" aria-label={label} className={cn(iconButtonClass, className)} {...props}>
      {children}
    </button>
  )
}
