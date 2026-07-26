"use client"

import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export const pageTitleClass =
  "text-xl md:text-2xl font-bold text-foreground tracking-tight text-balance"

type PageBackLinkProps = {
  href?: string
  onClick?: () => void
  label?: string
  className?: string
}

/** Consistent back control for sub-pages and in-page drill-down. */
export function PageBackLink({ href, onClick, label = "Back", className }: PageBackLinkProps) {
  const content = (
    <>
      <ArrowLeft className="size-4 shrink-0" aria-hidden />
      {label}
    </>
  )
  const buttonClass = cn("gap-1 -ml-2 shrink-0 self-start", className)

  if (href) {
    return (
      <Button variant="ghost" size="sm" asChild className={buttonClass}>
        <Link href={href}>{content}</Link>
      </Button>
    )
  }

  return (
    <Button variant="ghost" size="sm" type="button" className={buttonClass} onClick={onClick}>
      {content}
    </Button>
  )
}

type PageHeaderProps = {
  title: string
  description?: string
  back?: { href?: string; onClick?: () => void; label?: string }
  icon?: React.ComponentType<{ className?: string }>
  actions?: React.ReactNode
  className?: string
}

/** Page title block used across dashboard routes (with optional back link). */
export function PageHeader({ title, description, back, icon: Icon, actions, className }: PageHeaderProps) {
  const titleRow = (
    <div
      className={cn(
        "flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between min-w-0",
        !back && className
      )}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          {Icon ? <Icon className="size-6 shrink-0 text-foreground" aria-hidden /> : null}
          <h1 className={pageTitleClass}>{title}</h1>
        </div>
        {description ? <p className="text-sm text-muted-foreground mt-1">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2 shrink-0">{actions}</div> : null}
    </div>
  )

  if (back) {
    return (
      <div className={cn("flex flex-col gap-2 min-w-0 items-start", className)}>
        <PageBackLink {...back} />
        {titleRow}
      </div>
    )
  }

  return titleRow
}
