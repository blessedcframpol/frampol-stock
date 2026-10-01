"use client"

import Link from "next/link"
import { ChevronRight } from "lucide-react"
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"

export type BreadcrumbItem = {
  label: string
  href?: string
  onClick?: () => void
}

type BreadcrumbContextValue = {
  items: BreadcrumbItem[]
  setItems: (items: BreadcrumbItem[]) => void
}

const BreadcrumbContext = createContext<BreadcrumbContextValue | null>(null)

function sameTrail(a: BreadcrumbItem[], b: BreadcrumbItem[]) {
  return (
    a.length === b.length &&
    a.every((item, index) => item.label === b[index]?.label && (item.href ?? "") === (b[index]?.href ?? ""))
  )
}

export function PageBreadcrumbProvider({ children }: { children: ReactNode }) {
  const [items, setState] = useState<BreadcrumbItem[]>([])
  const setItems = useCallback((next: BreadcrumbItem[]) => {
    setState((prev) => (sameTrail(prev, next) ? prev : next))
  }, [])
  const value = useMemo(() => ({ items, setItems }), [items, setItems])

  return (
    <BreadcrumbContext.Provider value={value}>
      {children}
    </BreadcrumbContext.Provider>
  )
}

export function PageBreadcrumbSlot() {
  const ctx = useContext(BreadcrumbContext)
  const items = ctx?.items ?? []
  if (items.length === 0) return null

  return (
    <nav aria-label="Breadcrumb" className="min-w-0 px-4 pb-2 md:px-6">
      <ol className="flex min-w-0 flex-wrap items-center gap-1 text-sm text-muted-foreground">
        {items.map((item, index) => {
          const current = index === items.length - 1
          return (
            <li key={`${item.label}-${index}`} className="flex min-w-0 items-center gap-1">
              {index > 0 ? <ChevronRight className="size-3.5 shrink-0" aria-hidden /> : null}
              {current ? (
                <span className="truncate font-medium text-foreground" aria-current="page">
                  {item.label}
                </span>
              ) : item.href ? (
                <Link
                  href={item.href}
                  className="truncate rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {item.label}
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={item.onClick}
                  className="truncate rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {item.label}
                </button>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

export function PageBreadcrumbs({ items }: { items: BreadcrumbItem[] }) {
  const ctx = useContext(BreadcrumbContext)
  const key = items.map((item) => `${item.label}\0${item.href ?? ""}`).join("\n")

  useEffect(() => {
    if (!ctx) return
    ctx.setItems(items)
    return () => ctx.setItems([])
    // `key` is the trail identity. `items` is read from that render so onClick stays with the labels.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, key])

  return null
}
