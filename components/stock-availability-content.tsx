"use client"

import { useEffect, useState } from "react"
import { AlertCircle, Boxes, Loader2, Search } from "lucide-react"
import { EmptyState } from "@/components/fs/empty-state"
import { PageHeader } from "@/components/page-nav"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { fetchStockAvailability, type StockAvailabilityRow } from "@/lib/stock-availability"
import { formatCount } from "@/lib/format-display"

const SEARCH_DEBOUNCE_MS = 250

function LowTag() {
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded-md bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning">
      Low
    </span>
  )
}

export function StockAvailabilityContent() {
  const [search, setSearch] = useState("")
  const [query, setQuery] = useState("")
  const [rows, setRows] = useState<StockAvailabilityRow[]>([])
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const loading = loadedQuery !== query

  useEffect(() => {
    const id = window.setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(id)
  }, [search])

  useEffect(() => {
    let cancelled = false
    void fetchStockAvailability(query)
      .then((data) => {
        if (cancelled) return
        setRows(data)
        setError(null)
      })
      .catch((caught: unknown) => {
        if (cancelled) return
        setRows([])
        setError(caught instanceof Error ? caught.message : "Could not load stock")
      })
      .finally(() => {
        if (!cancelled) setLoadedQuery(query)
      })
    return () => {
      cancelled = true
    }
  }, [query])

  return (
    <div className="flex min-w-0 flex-col gap-4 md:gap-6">
      <PageHeader
        title="Stock"
        description="How many units are available to request. Counts only."
        icon={Boxes}
      />

      <div className="relative w-full sm:max-w-sm">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search product or vendor"
          className="min-h-11 rounded-lg bg-background pl-8 text-base sm:min-h-9 sm:text-sm"
          aria-label="Search stock"
        />
      </div>

      {error ? (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          <AlertCircle className="size-5 shrink-0" />
          <p>{error}</p>
        </div>
      ) : loading && rows.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
          Loading stock…
        </div>
      ) : rows.length === 0 ? (
        <EmptyState message={query ? "No products match your search." : "No products yet."} />
      ) : (
        <Card className="min-w-0 overflow-hidden">
          <CardContent className="min-w-0 p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead className="hidden sm:table-cell">Vendor</TableHead>
                  <TableHead className="text-right">Available</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.product_id}>
                    <TableCell className="min-w-0 font-medium">
                      <span className="block">{row.product_name}</span>
                      {row.vendor ? (
                        <span className="block text-xs font-normal text-muted-foreground sm:hidden">
                          {row.vendor}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">
                      {row.vendor ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="inline-flex items-center justify-end gap-2">
                        {row.is_low ? <LowTag /> : null}
                        <span className="tabular-nums font-medium">{formatCount(row.available_count)}</span>
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
