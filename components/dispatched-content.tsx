"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { StatusPill } from "@/components/fs/status-pill"
import { EmptyState } from "@/components/fs/empty-state"
import { FilterChip } from "@/components/fs/filter-chip"
import { ListToolbar, ListToolbarSearch } from "@/components/fs/list-toolbar"
import { Pagination } from "@/components/fs/pagination"
import { BusinessDateLabel } from "@/components/business-date-label"
import { useOrgTimezone } from "@/hooks/use-org-timezone"
import { PageHeader } from "@/components/page-nav"
import { ArrowUpRight, Loader2 } from "lucide-react"
import { toastFromApiErrorBody, toastFromCaughtError } from "@/lib/toast-reportable-error"
import { BatchLinesDrawer } from "@/components/batch-lines-drawer"
import { DispatchedKitDrawer } from "@/components/dispatched-kit-drawer"
import { SignedStorageLink } from "@/components/signed-storage-link"
import {
  DISPATCHED_MOVEMENTS,
  LEDGER_PAGE_SIZE,
  dispatchResultLabel,
  filteredTotal,
  movementChipIds,
  pageCount,
} from "@/lib/ledger-pages"
import type { DispatchedResultKind, DispatchedRow } from "@/app/api/dispatched/route"
import { canViewFinancials } from "@/lib/permissions"
import { useAuth } from "@/lib/auth-context"

type DispatchedPage = {
  rows: DispatchedRow[]
  total: number
  counts: Record<string, number>
  resultKind: DispatchedResultKind
}

export function DispatchedContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const itemId = searchParams.get("item")
  const timeZone = useOrgTimezone()
  const { role } = useAuth()
  const showFinancials = canViewFinancials(role)
  const [search, setSearch] = useState("")
  const [appliedSearch, setAppliedSearch] = useState("")
  const [movement, setMovement] = useState<string | null>(null)
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [page, setPage] = useState(1)
  const [data, setData] = useState<DispatchedPage>({ rows: [], total: 0, counts: {}, resultKind: "batch" })
  const [viewing, setViewing] = useState<DispatchedRow | null>(null)
  const [reload, setReload] = useState(0)

  function closeKit() {
    const params = new URLSearchParams(searchParams.toString())
    params.delete("item")
    const query = params.toString()
    router.replace(query ? `/inventory/dispatched?${query}` : "/inventory/dispatched", { scroll: false })
  }

  useEffect(() => {
    const timer = setTimeout(() => setAppliedSearch(search.trim()), 300)
    return () => clearTimeout(timer)
  }, [search])

  const filterKey = `${movement ?? ""}|${from}|${to}|${appliedSearch}`
  const [pageFilter, setPageFilter] = useState(filterKey)
  if (pageFilter !== filterKey) {
    setPageFilter(filterKey)
    setPage(1)
  }

  const requestKey = `${page}|${filterKey}|${reload}`
  const [settledKey, setSettledKey] = useState<string | null>(null)
  const loading = settledKey !== requestKey

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const params = new URLSearchParams({
          limit: String(LEDGER_PAGE_SIZE),
          offset: String((page - 1) * LEDGER_PAGE_SIZE),
        })
        if (movement) params.set("movement", movement)
        if (from) params.set("from", from)
        if (to) params.set("to", to)
        if (appliedSearch) params.set("search", appliedSearch)
        const res = await fetch(`/api/dispatched?${params.toString()}`)
        const body = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) {
          toastFromApiErrorBody(body, "Failed to load dispatched items", res.status)
          setData({ rows: [], total: 0, counts: {}, resultKind: "batch" })
          return
        }
        setData({
          rows: Array.isArray(body.rows) ? body.rows : [],
          total: typeof body.total === "number" ? body.total : 0,
          counts: body.counts && typeof body.counts === "object" ? body.counts : {},
          resultKind: body.resultKind === "serial" || body.resultKind === "mixed" ? body.resultKind : "batch",
        })
      } catch (error) {
        if (!cancelled) {
          toastFromCaughtError(error, "Failed to load dispatched items")
          setData({ rows: [], total: 0, counts: {}, resultKind: "batch" })
        }
      } finally {
        if (!cancelled) setSettledKey(requestKey)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [requestKey, page, movement, from, to, appliedSearch])

  const chips = movementChipIds(data.counts, movement, DISPATCHED_MOVEMENTS)
  const total = data.total
  const pages = pageCount(total)

  return (
    <div className="flex flex-col gap-6 min-w-0">
      <PageHeader
        title="Dispatched"
        description={
          <>
            Where dispatched items are now.{" "}
            <Link href="/transaction-history" className="text-brand hover:underline">
              Transaction history
            </Link>
          </>
        }
      />

      <ListToolbar
        search={
          <ListToolbarSearch
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by serial, product, client, invoice..."
            aria-label="Search dispatched items"
          />
        }
        count={loading ? "Loading…" : dispatchResultLabel(total, data.resultKind)}
        secondary={
          <>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              From
              <input
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                className="h-10 rounded-full bg-card px-3 text-foreground"
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              To
              <input
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                className="h-10 rounded-full bg-card px-3 text-foreground"
              />
            </label>
          </>
        }
        primary={<Pagination page={page} pageCount={pages} onPageChange={setPage} />}
      />

      <div className="flex flex-wrap gap-2">
        <FilterChip label="All" count={filteredTotal(data.counts, null)} selected={movement == null} onSelect={() => setMovement(null)} />
        {chips.map((id) => (
          <FilterChip
            key={id}
            label={id}
            count={data.counts[id] ?? 0}
            selected={movement === id}
            onSelect={() => setMovement(movement === id ? null : id)}
          />
        ))}
      </div>

      {loading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="size-8 animate-spin" />
            </div>
          ) : data.rows.length === 0 ? (
            <EmptyState
              icon={<ArrowUpRight />}
              message={
                appliedSearch || movement || from || to
                  ? "No dispatched items match these filters."
                  : "Items moved out (sold, POC, rentals, disposed) will appear here."
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Movement</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead className="text-right">Items</TableHead>
                  <TableHead>Date out</TableHead>
                  {showFinancials ? <TableHead>Invoice</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((row) => (
                    <TableRow
                      key={row.id}
                      className="cursor-pointer"
                      onClick={() => {
                        if (itemId) closeKit()
                        setViewing(row)
                      }}
                    >
                    <TableCell>
                      {row.movement ? <StatusPill value={row.movement} /> : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="max-w-[220px] truncate text-sm text-foreground" title={row.productName}>
                      {row.productName}
                    </TableCell>
                    <TableCell className="max-w-[180px] truncate text-sm text-muted-foreground" title={row.clientDisplay}>
                      {row.clientDisplay}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums text-foreground">
                      {row.grain === "serial" && row.serialNumber ? (
                        <span className="flex w-full items-center justify-end gap-2">
                          <Link
                            href={`/inventory?serial=${encodeURIComponent(row.serialNumber)}`}
                            className="font-mono text-brand hover:underline"
                            onClick={(event) => event.stopPropagation()}
                          >
                            {row.serialNumber}
                          </Link>
                          <button
                            type="button"
                            className="text-xs text-brand hover:underline"
                            onClick={(event) => {
                              event.stopPropagation()
                              setViewing(row)
                            }}
                          >
                            Batch
                          </button>
                        </span>
                      ) : (
                        <span className="tabular-nums">{row.itemCount}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {row.dateOut ? (
                        <BusinessDateLabel date={row.dateOut} createdAt={row.recordedAt} timeZone={timeZone} />
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    {showFinancials ? (
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {row.invoiceNumber || "—"}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
      )}

      {itemId ? (
        <DispatchedKitDrawer key={itemId} itemId={itemId} onClose={closeKit} onChanged={() => setReload((value) => value + 1)} />
      ) : null}

      <BatchLinesDrawer
        open={viewing != null}
        onOpenChange={(open) => {
          if (!open) setViewing(null)
        }}
        title={viewing ? `${viewing.movement ?? "Dispatch"} — ${viewing.productName}` : "Dispatch"}
        description={
          viewing ? `${viewing.lines.length} item${viewing.lines.length === 1 ? "" : "s"}` : null
        }
        detail={
          viewing
            ? {
                movement: viewing.movement ?? "—",
                client: viewing.clientDisplay,
                date: viewing.dateOut ? (
                  <BusinessDateLabel date={viewing.dateOut} createdAt={viewing.recordedAt} timeZone={timeZone} />
                ) : (
                  "—"
                ),
                invoice: viewing.invoiceNumber || "—",
                deliveryNote: viewing.deliveryNoteUrl ? (
                  <SignedStorageLink path={viewing.deliveryNoteUrl} className="text-brand hover:underline">
                    View
                  </SignedStorageLink>
                ) : (
                  "—"
                ),
                recordedBy: viewing.recordedBy || "—",
              }
            : undefined
        }
        lines={(viewing?.lines ?? []).map((line) => ({
          serialNumber: line.serialNumber,
          status: line.status,
          assignedTo: line.assignedTo ?? undefined,
        }))}
        showInvoice={showFinancials}
      />
    </div>
  )
}
