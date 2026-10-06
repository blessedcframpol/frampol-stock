"use client"

import { useEffect, useMemo, useState } from "react"
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
import { StockPoolChip } from "@/components/stock-pool-chip"
import { EmptyState } from "@/components/fs/empty-state"
import { FilterChip } from "@/components/fs/filter-chip"
import { ListToolbar, ListToolbarSearch } from "@/components/fs/list-toolbar"
import { Pagination } from "@/components/fs/pagination"
import { BusinessDateLabel } from "@/components/business-date-label"
import { useOrgTimezone } from "@/hooks/use-org-timezone"
import { todayBusinessDate } from "@/lib/business-date.mjs"
import { announceAlertsUpdated, canRecordReturn } from "@/lib/alerts"
import { isOverdueHolding } from "@/lib/bulk-resolve"
import { PageHeader } from "@/components/page-nav"
import { ArrowUpRight, Loader2 } from "lucide-react"
import { ChangeGroupDialog } from "@/components/change-group-dialog"
import { ResolveHoldingsDialog } from "@/components/resolve-holdings-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import type { InventoryItem } from "@/lib/data"
import { canChangeStockPool, canViewFinancials } from "@/lib/permissions"
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
import { useAuth } from "@/lib/auth-context"
import { useInventoryStore } from "@/lib/inventory-store"

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
  const today = todayBusinessDate(timeZone)
  const { role } = useAuth()
  const { inventory, refetchLedger } = useInventoryStore()
  const canChangeGroup = canChangeStockPool(role)
  const canResolve = canRecordReturn(role)
  const [selectedKits, setSelectedKits] = useState<Map<string, InventoryItem>>(() => new Map())
  const [groupOpen, setGroupOpen] = useState(false)
  const [resolveOpen, setResolveOpen] = useState(false)
  const [resolveKits, setResolveKits] = useState<InventoryItem[]>([])
  const resolveParam = searchParams.get("resolve")
  const [consumedResolve, setConsumedResolve] = useState<string | null>(null)
  const poolBySerial = useMemo(() => {
    const pools = new Map<string, string | undefined>()
    for (const item of inventory) {
      if (!item.deletedAt) pools.set(item.serialNumber, item.stockPool)
    }
    return pools
  }, [inventory])
  const itemBySerial = useMemo(() => {
    const map = new Map<string, InventoryItem>()
    for (const item of inventory) {
      if (!item.deletedAt) map.set(item.serialNumber, item)
    }
    return map
  }, [inventory])

  if (resolveParam && resolveParam !== consumedResolve && inventory.length > 0) {
    const ids = new Set(resolveParam.split(",").map((id) => id.trim()).filter(Boolean))
    const kits = inventory.filter((item) => ids.has(item.id) && isOverdueHolding(item, today))
    setConsumedResolve(resolveParam)
    if (kits.length > 0) {
      setResolveKits(kits)
      setResolveOpen(true)
    }
  }

  useEffect(() => {
    if (!consumedResolve || searchParams.get("resolve") !== consumedResolve) return
    const params = new URLSearchParams(searchParams.toString())
    params.delete("resolve")
    const query = params.toString()
    router.replace(query ? `/inventory/dispatched?${query}` : "/inventory/dispatched", { scroll: false })
  }, [consumedResolve, router, searchParams])

  function eligibleKits(row: DispatchedRow): InventoryItem[] {
    const lines =
      row.grain === "serial" && row.serialNumber
        ? row.lines.filter((line) => line.serialNumber === row.serialNumber)
        : row.lines
    const kits: InventoryItem[] = []
    const seen = new Set<string>()
    for (const line of lines) {
      const item = itemBySerial.get(line.serialNumber)
      if (!item || seen.has(item.id)) continue
      if (item.status !== "In Stock" && item.status !== "Rented") continue
      seen.add(item.id)
      kits.push(item)
    }
    return kits
  }

  function resolveKitsIn(row: DispatchedRow): InventoryItem[] {
    if (!canResolve) return []
    const lines =
      row.grain === "serial" && row.serialNumber
        ? row.lines.filter((line) => line.serialNumber === row.serialNumber)
        : row.lines
    const kits: InventoryItem[] = []
    const seen = new Set<string>()
    for (const line of lines) {
      const item = itemBySerial.get(line.serialNumber)
      if (!item || seen.has(item.id) || !isOverdueHolding(item, today)) continue
      seen.add(item.id)
      kits.push(item)
    }
    return kits
  }

  function selectableKits(row: DispatchedRow): InventoryItem[] {
    const kits: InventoryItem[] = []
    const seen = new Set<string>()
    for (const kit of [...(canChangeGroup ? eligibleKits(row) : []), ...resolveKitsIn(row)]) {
      if (seen.has(kit.id)) continue
      seen.add(kit.id)
      kits.push(kit)
    }
    return kits
  }

  function toggleRow(row: DispatchedRow) {
    const kits = selectableKits(row)
    setSelectedKits((prev) => {
      const next = new Map(prev)
      const allOn = kits.length > 0 && kits.every((kit) => next.has(kit.id))
      if (allOn) kits.forEach((kit) => next.delete(kit.id))
      else kits.forEach((kit) => next.set(kit.id, kit))
      return next
    })
  }

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

      {(canChangeGroup || canResolve) && selectedKits.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-foreground">{selectedKits.size} selected</span>
          {canChangeGroup && [...selectedKits.values()].some((kit) => kit.status === "In Stock" || kit.status === "Rented") ? (
            <Button type="button" size="sm" variant="outline" onClick={() => setGroupOpen(true)}>
              Change group ({[...selectedKits.values()].filter((kit) => kit.status === "In Stock" || kit.status === "Rented").length})
            </Button>
          ) : null}
          {canResolve && [...selectedKits.values()].some((kit) => isOverdueHolding(kit, today)) ? (
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setResolveKits([...selectedKits.values()].filter((kit) => isOverdueHolding(kit, today)))
                setResolveOpen(true)
              }}
            >
              Resolve selected
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="ghost" onClick={() => setSelectedKits(new Map())}>
            Clear
          </Button>
        </div>
      ) : null}

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
                  {canChangeGroup || canResolve ? (
                    <TableHead className="w-10 px-2">
                      <Checkbox
                        checked={
                          data.rows.some((row) => selectableKits(row).length > 0) &&
                          data.rows.every((row) => selectableKits(row).every((kit) => selectedKits.has(kit.id)))
                        }
                        onCheckedChange={(value) => {
                          setSelectedKits((prev) => {
                            const next = new Map(prev)
                            for (const row of data.rows) {
                              for (const kit of selectableKits(row)) {
                                if (value === true) next.set(kit.id, kit)
                                else next.delete(kit.id)
                              }
                            }
                            return next
                          })
                        }}
                        aria-label="Select kits on this page"
                      />
                    </TableHead>
                  ) : null}
                  <TableHead>Movement</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead className="text-right">Items</TableHead>
                  <TableHead>Date out</TableHead>
                  {showFinancials ? <TableHead>Invoice</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((row) => {
                    const kits = selectableKits(row)
                    return (
                    <TableRow
                      key={row.id}
                      className="cursor-pointer"
                      onClick={() => {
                        if (itemId) closeKit()
                        setViewing(row)
                      }}
                    >
                    {canChangeGroup || canResolve ? (
                      <TableCell className="w-10 px-2" onClick={(event) => event.stopPropagation()}>
                        <Checkbox
                          checked={kits.length > 0 && kits.every((kit) => selectedKits.has(kit.id))}
                          disabled={kits.length === 0}
                          onCheckedChange={() => toggleRow(row)}
                          aria-label={`Select kits in ${row.productName}`}
                        />
                      </TableCell>
                    ) : null}
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
                          <StockPoolChip pool={row.serialNumber ? poolBySerial.get(row.serialNumber) : undefined} />
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
                    )
                })}
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
          stockPool: poolBySerial.get(line.serialNumber),
        }))}
        showInvoice={showFinancials}
      />
      <ResolveHoldingsDialog
        open={resolveOpen}
        kits={resolveKits}
        onOpenChange={setResolveOpen}
        onCompleted={async () => {
          setSelectedKits(new Map())
          await refetchLedger()
          setReload((value) => value + 1)
          announceAlertsUpdated()
        }}
      />
      <ChangeGroupDialog
        open={groupOpen}
        onOpenChange={setGroupOpen}
        kits={[...selectedKits.values()].filter((kit) => kit.status === "In Stock" || kit.status === "Rented")}
        onSaved={async () => {
          setSelectedKits(new Map())
          await refetchLedger()
          setReload((value) => value + 1)
        }}
      />
    </div>
  )
}
