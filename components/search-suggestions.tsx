"use client"

import Link from "next/link"
import { runSearch, type SearchResults } from "@/lib/search"
import { Package, Users, User, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"

const MAX_INVENTORY = 5
const MAX_CLIENTS = 3
const MAX_USERS = 3

export interface SearchSuggestionsProps {
  /** Current query (will be trimmed for search) */
  query: string
  /** Full search results; caller runs runSearch(inventory, clients, users, query) */
  results: SearchResults
  /** Called when user chooses "See all results" (navigate to /search?q=...) */
  onSeeAll?: () => void
  /** Optional class for the container */
  className?: string
  /** If true, render in a compact style (e.g. inside a sheet) */
  compact?: boolean
}

export function SearchSuggestions({
  query,
  results,
  onSeeAll,
  className,
  compact,
}: SearchSuggestionsProps) {
  const q = query.trim()
  const hasQuery = q.length >= 1

  const inv = results.inventory.slice(0, MAX_INVENTORY)
  const cli = results.clients.slice(0, MAX_CLIENTS)
  const usr = results.users.slice(0, MAX_USERS)
  const total =
    results.inventory.length + results.clients.length + results.users.length

  if (!hasQuery) return null

  if (total === 0) {
    return (
      <div className={cn("py-4 text-center text-sm text-muted-foreground", className)}>
        <p>No matching items. Press Enter to see full search.</p>
        <Link
          href={`/search?q=${encodeURIComponent(q)}`}
          onClick={onSeeAll}
          className="mt-2 inline-block text-sm font-medium text-primary hover:underline"
        >
          Go to search results →
        </Link>
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
            {cli.map((client) => (
              <li key={client.id}>
                <Link
                  href="/clients"
                  className={cn(
                    "flex items-center justify-between gap-2 rounded-md transition-colors text-left",
                    compact
                      ? "px-2 py-1.5 text-sm hover:bg-muted/70"
                      : "px-2 py-2 text-sm hover:bg-muted/70"
                  )}
                >
                  <span className="truncate font-medium text-foreground">
                    {client.name}
                  </span>
                  <span className="text-muted-foreground text-xs truncate max-w-[140px]">
                    {client.company}
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
      <div className="border-t border-border pt-2 mt-2">
        <Link
          href={`/search?q=${encodeURIComponent(q)}`}
          onClick={onSeeAll}
          className="flex items-center justify-center gap-1.5 py-2 text-sm font-medium text-primary hover:underline"
        >
          See all {total} result{total !== 1 ? "s" : ""}
          <ChevronRight className="w-4 h-4" />
        </Link>
      </div>
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
