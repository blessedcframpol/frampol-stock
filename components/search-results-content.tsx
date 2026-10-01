"use client"

import { useCallback, useMemo, useState } from "react"
import Link from "next/link"
import { useSearchParams, useRouter } from "next/navigation"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { StatusPill } from "@/components/fs/status-pill"
import { EmptyState } from "@/components/fs/empty-state"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useInventoryStore } from "@/lib/inventory-store"
import { useClients } from "@/lib/supabase/clients-db"
import { useSearchUsers } from "@/lib/supabase/search-users"
import { runSearch, type SearchResults } from "@/lib/search"
import { clientCompanyDetail } from "@/lib/client-label"
import {
  Search,
  Package,
  Users,
  User,
  ChevronRight,
  FileQuestion,
} from "lucide-react"
import { PageHeader } from "@/components/page-nav"

type FilterTab = "all" | "inventory" | "clients" | "users"

export function SearchResultsContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const qFromUrl = searchParams.get("q") ?? ""
  const [filter, setFilter] = useState<FilterTab>("all")
  const [localQuery, setLocalQuery] = useState(qFromUrl)
  const [localQueryForUrl, setLocalQueryForUrl] = useState(qFromUrl)
  if (qFromUrl !== localQueryForUrl) {
    setLocalQueryForUrl(qFromUrl)
    setLocalQuery(qFromUrl)
  }

  const { inventory } = useInventoryStore()
  const { clients } = useClients()
  const users = useSearchUsers()

  const results = useMemo<SearchResults>(() => {
    return runSearch(
      { inventory, clients, users },
      qFromUrl
    )
  }, [inventory, clients, users, qFromUrl])

  const totalCount =
    results.inventory.length + results.clients.length + results.users.length

  const handleSearchSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const q = localQuery.trim()
      if (q) router.push(`/search?q=${encodeURIComponent(q)}`)
    },
    [localQuery, router]
  )

  const showInventory = filter === "all" || filter === "inventory"
  const showClients = filter === "all" || filter === "clients"
  const showUsers = filter === "all" || filter === "users"

  return (
    <div className="flex flex-col gap-6 min-w-0">
      <PageHeader
        title="Search"
        description="Search inventory items, clients, and users. Use the filters to narrow results."
      />

      <form onSubmit={handleSearchSubmit} className="flex gap-2">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search inventory, clients, users..."
            className="pl-9"
            value={localQuery}
            onChange={(e) => setLocalQuery(e.target.value)}
            aria-label="Search"
          />
        </div>
        <Button type="submit">Search</Button>
      </form>

      {!qFromUrl ? (
        <EmptyState
          icon={<FileQuestion />}
          message="Enter a search term. Type in the box above and press Enter to search across inventory, clients, and users."
        />
      ) : totalCount === 0 ? (
        <EmptyState
          icon={<Search />}
          message={`No results for "${qFromUrl}". Try different keywords or check spelling.`}
        />
      ) : (
        <>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>{totalCount} result{totalCount !== 1 ? "s" : ""}</span>
            <span>for &quot;{qFromUrl}&quot;</span>
          </div>

          <Tabs
            value={filter}
            onValueChange={(v) => setFilter(v as FilterTab)}
            className="w-full"
          >
            <TabsList className="w-full sm:w-auto flex flex-wrap gap-1 h-auto p-1 bg-muted/50">
              <TabsTrigger value="all" className="gap-1.5 shrink-0">
                All
                <Badge variant="secondary" className="h-5 min-w-5 px-1 text-[10px] font-semibold">
                  {totalCount}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="inventory" className="gap-1.5 shrink-0">
                <Package className="w-3.5 h-3.5" />
                Inventory
                <Badge variant="secondary" className="h-5 min-w-5 px-1 text-[10px] font-semibold">
                  {results.inventory.length}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="clients" className="gap-1.5 shrink-0">
                <Users className="w-3.5 h-3.5" />
                Clients
                <Badge variant="secondary" className="h-5 min-w-5 px-1 text-[10px] font-semibold">
                  {results.clients.length}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="users" className="gap-1.5 shrink-0">
                <User className="w-3.5 h-3.5" />
                Users
                <Badge variant="secondary" className="h-5 min-w-5 px-1 text-[10px] font-semibold">
                  {results.users.length}
                </Badge>
              </TabsTrigger>
            </TabsList>

            <div className="mt-4 space-y-6">
              {showInventory && results.inventory.length > 0 && (
                <Card className="border-border">
                  <CardContent className="p-0">
                    <div className="px-4 py-3 border-b border-border flex items-center gap-2">
                      <Package className="w-4 h-4 text-muted-foreground" />
                      <h2 className="font-semibold text-foreground">Inventory items</h2>
                      <Badge variant="outline" className="text-xs">
                        {results.inventory.length}
                      </Badge>
                    </div>
                    <ul className="divide-y divide-border">
                      {results.inventory.map((item) => (
                        <li key={item.id}>
                          <Link
                            href={`/inventory?serial=${encodeURIComponent(item.serialNumber)}`}
                            className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-muted/50 transition-colors text-left"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="font-medium text-foreground truncate">
                                {item.name}
                              </p>
                              <p className="text-sm text-muted-foreground truncate">
                                {item.serialNumber}
                                {item.location ? ` · ${item.location}` : ""}
                              </p>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <StatusPill value={item.status} />
                              <ChevronRight className="w-4 h-4 text-muted-foreground" />
                            </div>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}

              {showClients && results.clients.length > 0 && (
                <Card className="border-border">
                  <CardContent className="p-0">
                    <div className="px-4 py-3 border-b border-border flex items-center gap-2">
                      <Users className="w-4 h-4 text-muted-foreground" />
                      <h2 className="font-semibold text-foreground">Clients</h2>
                      <Badge variant="outline" className="text-xs">
                        {results.clients.length}
                      </Badge>
                    </div>
                    <ul className="divide-y divide-border">
                      {results.clients.map((client) => {
                        const detail = [clientCompanyDetail(client), client.email].filter(Boolean).join(" · ")
                        return (
                        <li key={client.id}>
                          <Link
                            href={`/clients/${client.id}`}
                            className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-muted/50 transition-colors text-left"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="font-medium text-foreground truncate">
                                {client.name}
                              </p>
                              {detail ? (
                                <p className="text-sm text-muted-foreground truncate">{detail}</p>
                              ) : null}
                            </div>
                            <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                          </Link>
                        </li>
                        )
                      })}
                    </ul>
                  </CardContent>
                </Card>
              )}

              {showUsers && results.users.length > 0 && (
                <Card className="border-border">
                  <CardContent className="p-0">
                    <div className="px-4 py-3 border-b border-border flex items-center gap-2">
                      <User className="w-4 h-4 text-muted-foreground" />
                      <h2 className="font-semibold text-foreground">Users</h2>
                      <Badge variant="outline" className="text-xs">
                        {results.users.length}
                      </Badge>
                    </div>
                    <ul className="divide-y divide-border">
                      {results.users.map((user) => (
                        <li key={user.id}>
                          <Link
                            href="/settings"
                            className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-muted/50 transition-colors text-left"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="font-medium text-foreground truncate">
                                {user.name}
                              </p>
                              <p className="text-sm text-muted-foreground truncate">
                                {user.email}
                                {user.role ? ` · ${user.role}` : ""}
                              </p>
                            </div>
                            <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}
            </div>
          </Tabs>
        </>
      )}
    </div>
  )
}
