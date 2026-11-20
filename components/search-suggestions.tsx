"use client"

import Link from "next/link"
import type { SearchResults } from "@/lib/search"
import type { HeaderRequestHit } from "@/lib/header-search"
import { HEADER_SEARCH_MIN_CHARS } from "@/lib/header-search"
import { Package, Users, User, FileText, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { clientCompanyDetail } from "@/lib/client-label"

const MAX_INVENTORY = 5
const MAX_CLIENTS = 3
const MAX_USERS = 3
const MAX_REQUESTS = 5

export interface SearchSuggestionsProps {
  /** Current query (will be trimmed for search) */
  query: string
  /** Full search results; caller runs runSearch or fetchHeaderSearch */
  results: SearchResults & { requests?: HeaderRequestHit[] }
  /** clientId → contact name when the hit came via a contact search */
  viaContactByClientId?: Map<string, string>
  /** Called when user chooses "See all results" */
  onSeeAll?: () => void
  /** Destination for "See all" (role-scoped; omit to hide the link). */
  seeAllHref?: string | null
  /** Optional class for the container */
  className?: string
  /** If true, render in a compact style (e.g. inside a sheet) */
  compact?: boolean
  /** Show a short “type more” hint below the min character threshold */
  loading?: boolean
}

export function SearchSuggestions({
  query,
  results,
  viaContactByClientId,
  onSeeAll,
  seeAllHref,
  className,
  compact,
  loading,
}: SearchSuggestionsProps) {
  const q = query.trim()
  const hasQuery = q.length >= 1

  const inv = results.inventory.slice(0, MAX_INVENTORY)
  const products = (results.products ?? []).slice(0, MAX_INVENTORY)
  const cli = results.clients.slice(0, MAX_CLIENTS)
  const usr = results.users.slice(0, MAX_USERS)
  const reqs = (results.requests ?? []).slice(0, MAX_REQUESTS)
  const total =
    results.inventory.length +
    (results.products?.length ?? 0) +
    results.clients.length +
    results.users.length +
    (results.requests?.length ?? 0)

  if (!hasQuery) return null

  if (q.length < HEADER_SEARCH_MIN_CHARS) {
    return (
      <div className={cn("py-3 text-center text-sm text-muted-foreground", className)}>
        Type at least {HEADER_SEARCH_MIN_CHARS} characters to search.
      </div>
    )
  }

  if (loading && total === 0) {
    return (
      <div className={cn("py-3 text-center text-sm text-muted-foreground", className)}>
        Searching…
      </div>
    )
  }

  if (total === 0) {
    return (
      <div className={cn("py-4 text-center text-sm text-muted-foreground", className)}>
        <p>No matching items{seeAllHref ? ". Press Enter to see full search." : "."}</p>
        {seeAllHref ? (
          <Link
            href={seeAllHref}
            onClick={onSeeAll}
            className="mt-2 inline-block text-sm font-medium text-brand hover:underline"
          >
            Go to search results →
          </Link>
        ) : null}
      </div>
    )
  }

  const content = (
    <>
      {inv.length > 0 && (
        <div className={compact ? "mb-2" : "mb-3"}>
          <p
            className={cn(
              "font-medium text-muted-foreground flex items-center gap-1.5",
              compact ? "text-xs mb-1" : "text-xs mb-1.5"
            )}
          >
            <Package className="w-3.5 h-3.5" />
            Inventory
          </p>
          <ul className="space-y-0.5">
            {inv.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/inventory?serial=${encodeURIComponent(item.serialNumber)}`}
                  className={cn(
                    "flex items-center justify-between gap-2 rounded-md transition-colors text-left",
                    compact
                      ? "px-2 py-1.5 text-sm hover:bg-muted/70"
                      : "px-2 py-2 text-sm hover:bg-muted/70"
                  )}
                >
                  <span className="truncate font-medium text-foreground">
                    {item.name}
                  </span>
                  <span className="text-muted-foreground text-xs font-mono shrink-0 truncate max-w-[120px]">
                    {item.serialNumber}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {products.length > 0 && (
        <div className={compact ? "mb-2" : "mb-3"}>
          <p
            className={cn(
              "font-medium text-muted-foreground flex items-center gap-1.5",
              compact ? "text-xs mb-1" : "text-xs mb-1.5"
            )}
          >
            <Package className="w-3.5 h-3.5" />
            Products
          </p>
          <ul className="space-y-0.5">
            {products.map((product) => (
              <li key={product.productId}>
                <Link
                  href={`/stock?q=${encodeURIComponent(product.name)}`}
                  className={cn(
                    "flex items-center justify-between gap-2 rounded-md transition-colors text-left",
                    compact
                      ? "px-2 py-1.5 text-sm hover:bg-muted/70"
                      : "px-2 py-2 text-sm hover:bg-muted/70"
                  )}
                >
                  <span className="truncate font-medium text-foreground">{product.name}</span>
                  <span className="text-muted-foreground text-xs shrink-0 truncate max-w-[120px]">
                    {product.vendor}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {cli.length > 0 && (
        <div className={compact ? "mb-2" : "mb-3"}>
          <p
            className={cn(
              "font-medium text-muted-foreground flex items-center gap-1.5",
              compact ? "text-xs mb-1" : "text-xs mb-1.5"
            )}
          >
            <Users className="w-3.5 h-3.5" />
            Clients
          </p>
          <ul className="space-y-0.5">
            {cli.map((client) => {
              const via = viaContactByClientId?.get(client.id)
              return (
              <li key={client.id}>
                <Link
                  href={`/clients/${client.id}`}
                  className={cn(
                    "flex flex-col gap-0.5 rounded-md transition-colors text-left",
                    compact
                      ? "px-2 py-1.5 text-sm hover:bg-muted/70"
                      : "px-2 py-2 text-sm hover:bg-muted/70"
                  )}
                >
                  <span className="flex items-center justify-between gap-2 min-w-0">
                    <span className="truncate font-medium text-foreground">
                      {client.name}
                    </span>
                    {clientCompanyDetail(client) ? (
                      <span className="text-muted-foreground text-xs truncate max-w-[140px]">
                        {clientCompanyDetail(client)}
                      </span>
                    ) : null}
                  </span>
                  {via ? (
                    <span className="text-xs text-muted-foreground truncate">via contact {via}</span>
                  ) : null}
                </Link>
              </li>
              )
            })}
          </ul>
        </div>
      )}
      {reqs.length > 0 && (
        <div className={compact ? "mb-2" : "mb-3"}>
          <p
            className={cn(
              "font-medium text-muted-foreground flex items-center gap-1.5",
              compact ? "text-xs mb-1" : "text-xs mb-1.5"
            )}
          >
            <FileText className="w-3.5 h-3.5" />
            Requests
          </p>
          <ul className="space-y-0.5">
            {reqs.map((request) => (
              <li key={request.id}>
                <Link
                  href={`/requests/${request.id}`}
                  className={cn(
                    "flex items-center justify-between gap-2 rounded-md transition-colors text-left",
                    compact
                      ? "px-2 py-1.5 text-sm hover:bg-muted/70"
                      : "px-2 py-2 text-sm hover:bg-muted/70"
                  )}
                >
                  <span className="truncate font-medium tabular-nums text-foreground">
                    {request.requestNumber}
                  </span>
                  <span className="text-muted-foreground text-xs shrink-0 truncate max-w-[120px]">
                    {request.type}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {usr.length > 0 && (
        <div className={compact ? "mb-2" : "mb-3"}>
          <p
            className={cn(
              "font-medium text-muted-foreground flex items-center gap-1.5",
              compact ? "text-xs mb-1" : "text-xs mb-1.5"
            )}
          >
            <User className="w-3.5 h-3.5" />
            Users
          </p>
          <ul className="space-y-0.5">
            {usr.map((user) => (
              <li key={user.id}>
                <Link
                  href="/settings"
                  className={cn(
                    "flex items-center justify-between gap-2 rounded-md transition-colors text-left",
                    compact
                      ? "px-2 py-1.5 text-sm hover:bg-muted/70"
                      : "px-2 py-2 text-sm hover:bg-muted/70"
                  )}
                >
                  <span className="truncate font-medium text-foreground">
                    {user.name}
                  </span>
                  <span className="text-muted-foreground text-xs truncate max-w-[140px]">
                    {user.role ?? user.email}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {seeAllHref ? (
        <div className="border-t border-border pt-2 mt-2">
          <Link
            href={seeAllHref}
            onClick={onSeeAll}
            className="flex items-center justify-center gap-1.5 py-2 text-sm font-medium text-brand hover:underline"
          >
            See all {total} result{total !== 1 ? "s" : ""}
            <ChevronRight className="w-4 h-4" />
          </Link>
        </div>
      ) : null}
    </>
  )

  return (
    <div
      className={cn(
        "min-w-0 overflow-auto",
        compact ? "max-h-[40vh]" : "max-h-[min(360px,60vh)]",
        className
      )}
    >
      {content}
    </div>
  )
}
