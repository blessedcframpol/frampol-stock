"use client"

import { useState, useEffect, useMemo, useRef } from "react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { StatusPill } from "@/components/fs/status-pill"
import { EmptyState } from "@/components/fs/empty-state"
import { FilterChip } from "@/components/fs/filter-chip"
import { ListToolbar, ListToolbarSearch } from "@/components/fs/list-toolbar"
import { Pagination } from "@/components/fs/pagination"
import { BatchLinesDrawer, type BatchDrawerLine } from "@/components/batch-lines-drawer"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import Link from "next/link"
import { PageHeader } from "@/components/page-nav"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { History, Undo2, Loader2, Download, MoreHorizontal } from "lucide-react"
import { INTERNAL_LOCATIONS, isInternalLocation } from "@/lib/data"
import { useInventoryStore } from "@/lib/inventory-store"
import { fetchTransactionBatchPage, type TransactionBatchSummary } from "@/lib/transaction-batches"
import {
  LEDGER_PAGE_SIZE,
  filteredTotal,
  historyBatchCountLabel,
  movementChipIds,
  pageCount,
  reversalAffordances,
} from "@/lib/ledger-pages"
import { BusinessDateLabel } from "@/components/business-date-label"
import { useOrgTimezone } from "@/hooks/use-org-timezone"
import { formatRecordedAt } from "@/lib/business-date.mjs"
import { toast } from "sonner"
import { toastFromApiErrorBody, toastFromCaughtError } from "@/lib/toast-reportable-error"
import { reportAppEvent } from "@/lib/report-app-event"
import { useAuth } from "@/lib/auth-context"
import { canExportAllTransactions, canReverseQuickScanBatches, canViewFinancials } from "@/lib/permissions"
import { REVERSAL_PREDECESSORS } from "@/lib/movement-transitions.mjs"

const HISTORY_MOVEMENT_ORDER = [
  "Inbound",
  "Sale",
  "POC Out",
  "POC Return",
  "Rentals",
  "Rental Return",
  "Sale Return",
  "Transfer",
  "Dispose",
  "Decommissioned",
  "Inspection Pass",
  "Inspection Fail",
  "Remediation Loaner Issue",
  "Reversal",
  "Reversed",
]
import { SignedStorageLink } from "@/components/signed-storage-link"
import { reversalResultLine, type RestorePlanRow, type ReversePlanRow } from "@/lib/quick-scan-reversal-inventory"

const MIN_REASON_LENGTH = 15

function getFilenameFromContentDisposition(contentDisposition: string | null): string | null {
  if (!contentDisposition) return null
  const match = /filename="([^"]+)"/i.exec(contentDisposition)
  if (!match) return null
  return match[1]?.trim() || null
}

export function TransactionHistoryContent() {
  const timeZone = useOrgTimezone()
  const { inventory } = useInventoryStore()
  const poolBySerial = useMemo(() => {
    const pools = new Map<string, string | undefined>()
    for (const item of inventory) {
      if (!item.deletedAt) pools.set(item.serialNumber, item.stockPool)
    }
    return pools
  }, [inventory])
  const { role } = useAuth()
  const canReverse = canReverseQuickScanBatches(role)
  const canExport = canExportAllTransactions(role)
  const showFinancials = canViewFinancials(role)
  const [batches, setBatches] = useState<TransactionBatchSummary[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [total, setTotal] = useState(0)
  const [reloadToken, setReloadToken] = useState(0)
  const [exporting, setExporting] = useState(false)
  const [reversingBatchKey, setReversingBatchKey] = useState<string | null>(null)
  const [viewingBatch, setViewingBatch] = useState<TransactionBatchSummary | null>(null)
  const [pageSearch, setPageSearch] = useState("")
  const [appliedSearch, setAppliedSearch] = useState("")
  const [movement, setMovement] = useState<string | null>(null)
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [page, setPage] = useState(1)
  const [reverseTarget, setReverseTarget] = useState<TransactionBatchSummary | null>(null)
  const [reverseReason, setReverseReason] = useState("")
  const [confirmStatus, setConfirmStatus] = useState<Record<string, string>>({})
  const [reversePlan, setReversePlan] = useState<ReversePlanRow[] | null>(null)
  const [enteredFields, setEnteredFields] = useState<Record<string, { location: string; returnDate: string }>>({})
  const [restoreTarget, setRestoreTarget] = useState<TransactionBatchSummary | null>(null)
  const [restoreReason, setRestoreReason] = useState("")
  const [restorePlan, setRestorePlan] = useState<{ kind: string; rows: RestorePlanRow[] } | null>(null)
  const planRequest = useRef(0)

  useEffect(() => {
    const timer = setTimeout(() => setAppliedSearch(pageSearch.trim()), 300)
    return () => clearTimeout(timer)
  }, [pageSearch])

  const filterKey = `${movement ?? ""}|${from}|${to}|${appliedSearch}`
  const [pageFilter, setPageFilter] = useState(filterKey)
  if (pageFilter !== filterKey) {
    setPageFilter(filterKey)
    setPage(1)
  }

  const requestKey = `${page}|${filterKey}|${reloadToken}`
  const [settledKey, setSettledKey] = useState<string | null>(null)
  const loading = settledKey !== requestKey

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const next = await fetchTransactionBatchPage({
          limit: LEDGER_PAGE_SIZE,
          offset: (page - 1) * LEDGER_PAGE_SIZE,
          movement,
          from,
          to,
          search: appliedSearch,
        })
        if (cancelled) return
        setBatches(next.batches)
        setCounts(next.counts)
        setTotal(next.total)
      } catch (e) {
        if (cancelled) return
        const status = typeof e === "object" && e && "status" in e ? Number(e.status) : 500
        const body = typeof e === "object" && e && "body" in e ? e.body : {}
        if (typeof e === "object" && e && "body" in e) {
          toastFromApiErrorBody(body, "Failed to load transaction history", status)
        } else {
          toastFromCaughtError(e, "Failed to load transaction history")
        }
        setBatches([])
        setCounts({})
        setTotal(0)
      } finally {
        if (!cancelled) setSettledKey(requestKey)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [requestKey, page, movement, from, to, appliedSearch])

  function focusBatch(batchId: string) {
    setMovement(null)
    setFrom("")
    setTo("")
    setPageSearch(batchId)
    setAppliedSearch(batchId)
    setPage(1)
    setViewingBatch(null)
  }

  async function submitReverse() {
    if (!reverseTarget?.reverseBatchId) return
    const reason = reverseReason.trim()
    if (reason.length < MIN_REASON_LENGTH) {
      toast.error(`Please enter a reason (at least ${MIN_REASON_LENGTH} characters).`)
      void reportAppEvent({
        severity: "warn",
        source: "client",
        context: "batch_reversal_validation",
        message: "Batch reversal blocked: reason too short",
        metadata: {
          batchId: reverseTarget.reverseBatchId,
          reasonLength: reason.length,
          minReasonLength: MIN_REASON_LENGTH,
        },
      })
      return
    }
    setReversingBatchKey(reverseTarget.reverseBatchId)
    try {
      const res = await fetch("/api/quick-scan/reverse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchId: reverseTarget.reverseBatchId,
          reason,
          confirmed: (reversePlan ?? [])
            .filter((row) => row.needs.includes("status"))
            .map((row) => ({
              transactionId: row.transactionId,
              status: confirmStatus[row.transactionId] || row.status || "",
            })),
          entered: (reversePlan ?? [])
            .filter((row) => row.needs.includes("location") || row.needs.includes("return_date"))
            .map((row) => ({
              transactionId: row.transactionId,
              location: enteredFields[row.transactionId]?.location ?? "",
              returnDate: enteredFields[row.transactionId]?.returnDate ?? "",
            })),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toastFromApiErrorBody(data, "Failed to reverse batch", res.status)
        return
      }
      toast.success(
        reverseTarget.count === 1
          ? `Reversed scan: ${reverseTarget.serials[0]!} (${reverseTarget.productLabel})`
          : `Reversed ${reverseTarget.count} items (${reverseTarget.productLabel})`,
        typeof data.message === "string" && data.message.trim()
          ? { description: data.message.trim() }
          : undefined
      )
      setReverseTarget(null)
      setReverseReason("")
      setReversePlan(null)
      setReloadToken((token) => token + 1)
    } catch (e) {
      toastFromCaughtError(e, "Failed to reverse batch")
    } finally {
      setReversingBatchKey(null)
    }
  }

  function closeReverse() {
    planRequest.current += 1
    setReverseTarget(null)
    setReverseReason("")
    setReversePlan(null)
    setEnteredFields({})
    setConfirmStatus({})
  }

  async function openReverse(entry: TransactionBatchSummary) {
    if (!entry.reverseBatchId) return
    const request = ++planRequest.current
    setReverseTarget(entry)
    setReverseReason("")
    setReversePlan(null)
    setEnteredFields({})
    setConfirmStatus({})
    try {
      const res = await fetch(`/api/quick-scan/reverse?batchId=${encodeURIComponent(entry.reverseBatchId)}`)
      const data = await res.json().catch(() => ({}))
      if (request !== planRequest.current) return
      if (!res.ok) {
        toastFromApiErrorBody(data, "Could not preview this reversal", res.status)
        closeReverse()
        return
      }
      const rows = Array.isArray(data.rows) ? (data.rows as ReversePlanRow[]) : []
      setReversePlan(rows)
      setConfirmStatus(Object.fromEntries(rows.map((row) => [row.transactionId, row.status ?? ""])))
      setEnteredFields(
        Object.fromEntries(
          rows.map((row) => [
            row.transactionId,
            {
              location: row.location && isInternalLocation(row.location) ? row.location : "",
              returnDate: row.returnDate ?? "",
            },
          ])
        )
      )
    } catch (error) {
      if (request !== planRequest.current) return
      toastFromCaughtError(error, "Could not preview this reversal")
      closeReverse()
    }
  }

  function closeRestore() {
    planRequest.current += 1
    setRestoreTarget(null)
    setRestoreReason("")
    setRestorePlan(null)
  }

  async function openRestore(entry: TransactionBatchSummary) {
    if (!entry.reverseBatchId) return
    const request = ++planRequest.current
    setRestoreTarget(entry)
    setRestoreReason("")
    setRestorePlan(null)
    try {
      const res = await fetch(`/api/quick-scan/restore?batchId=${encodeURIComponent(entry.reverseBatchId)}`)
      const data = await res.json().catch(() => ({}))
      if (request !== planRequest.current) return
      if (!res.ok) {
        toastFromApiErrorBody(data, "Could not preview this restore", res.status)
        closeRestore()
        return
      }
      setRestorePlan({
        kind: typeof data.kind === "string" ? data.kind : "",
        rows: Array.isArray(data.rows) ? data.rows : [],
      })
    } catch (error) {
      if (request !== planRequest.current) return
      toastFromCaughtError(error, "Could not preview this restore")
      closeRestore()
    }
  }

  async function submitRestore() {
    if (!restoreTarget?.reverseBatchId) return
    const reason = restoreReason.trim()
    if (reason.length < MIN_REASON_LENGTH) {
      toast.error(`Please enter a reason (at least ${MIN_REASON_LENGTH} characters).`)
      return
    }
    setReversingBatchKey(restoreTarget.reverseBatchId)
    try {
      const res = await fetch("/api/quick-scan/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId: restoreTarget.reverseBatchId, reason }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toastFromApiErrorBody(data, "Failed to restore batch", res.status)
        return
      }
      toast.success(`Restored ${restoreTarget.productLabel}`)
      closeRestore()
      setReloadToken((token) => token + 1)
    } catch (error) {
      toastFromCaughtError(error, "Failed to restore batch")
    } finally {
      setReversingBatchKey(null)
    }
  }

  const reverseMissing = (reversePlan ?? []).some((row) => {
    const entered = enteredFields[row.transactionId]
    if (row.needs.includes("location") && !entered?.location) return true
    if (row.needs.includes("return_date") && !entered?.returnDate) return true
    if (row.needs.includes("status") && !(confirmStatus[row.transactionId] || row.status)) return true
    return false
  })

  async function handleExportAllTransactions() {
    if (!canExport || exporting) return
    setExporting(true)
    try {
      const res = await fetch("/api/admin/transactions/export")
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        toastFromApiErrorBody(data, "Failed to export transactions", res.status)
        return
      }
      const blob = await res.blob()
      const filename =
        getFilenameFromContentDisposition(res.headers.get("content-disposition")) ??
        `all-transactions-${new Date().toISOString().slice(0, 10)}.csv`
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
      toast.success("Transaction export downloaded")
    } catch (e) {
      toastFromCaughtError(e, "Failed to export transactions")
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="flex flex-col gap-6 min-w-0">
      <PageHeader
        title="Transaction history"
        description={
          <>
            The log of every stock movement.{" "}
            <Link href="/inventory/dispatched" className="text-brand hover:underline">
              Dispatched
            </Link>
          </>
        }
        actions={
          canExport ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => void handleExportAllTransactions()}
            disabled={exporting}
          >
            {exporting ? (
              <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
            ) : (
              <Download className="w-4 h-4 mr-1.5" />
            )}
            Export all transactions
          </Button>
          ) : undefined
        }
      />

      <ListToolbar
        search={
          <ListToolbarSearch
            type="search"
            value={pageSearch}
            onChange={(event) => setPageSearch(event.target.value)}
            placeholder="Search by serial, product, client, invoice, or batch..."
            aria-label="Search transaction history"
          />
        }
        count={loading ? "Loading…" : historyBatchCountLabel(total, counts.Reversed ?? 0, movement)}
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
        primary={<Pagination page={page} pageCount={pageCount(total)} onPageChange={setPage} />}
      />

      <div className="flex flex-wrap gap-2">
        <FilterChip
          label="All"
          count={filteredTotal(counts, null)}
          selected={movement == null}
          onSelect={() => setMovement(null)}
        />
        {movementChipIds(counts, movement, HISTORY_MOVEMENT_ORDER).map((id) => (
          <FilterChip
            key={id}
            label={id}
            count={counts[id] ?? 0}
            selected={movement === id}
            onSelect={() => setMovement(movement === id ? null : id)}
          />
        ))}
      </div>

          {loading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="size-8 animate-spin" />
            </div>
          ) : batches.length === 0 ? (
            <EmptyState
              icon={<History />}
              message={
                appliedSearch || movement || from || to
                  ? "No batches match these filters."
                  : "No transaction history. Movements from Quick Scan and Stock movement appear here as one row per batch."
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date & time</TableHead>
                  <TableHead>Movement</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead className="text-right">Items</TableHead>
                  {showFinancials ? <TableHead>Invoice</TableHead> : null}
                  <TableHead>Delivery note</TableHead>
                  {canReverse ? <TableHead className="w-12"><span className="sr-only">Actions</span></TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {batches.map((entry) => {
                  const affordance = reversalAffordances({
                    role,
                    isReversed: entry.isReversed,
                    movementType: entry.movementType,
                    reverseBatchId: entry.reverseBatchId,
                    reversesBatchId: entry.reversesBatchId,
                    reversedByBatchId: entry.reversedByBatchId,
                  })
                  return (
                    <TableRow
                      key={entry.batchKey}
                      className={`cursor-pointer ${entry.isReversed ? "opacity-70" : ""}`}
                      onClick={() => setViewingBatch(entry)}
                    >
                      <TableCell className="text-sm text-foreground">
                        <BusinessDateLabel date={entry.date} createdAt={entry.recordedAt} timeZone={timeZone} />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <StatusPill value={entry.movementType || "—"} />
                          {entry.movementType === "Reversal" && entry.originalMovementType ? (
                            <StatusPill value={entry.originalMovementType}>of {entry.originalMovementType}</StatusPill>
                          ) : null}
                          {affordance.showReversedPill ? (
                            affordance.linksToBatchId ? (
                              <button
                                type="button"
                                className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  focusBatch(affordance.linksToBatchId!)
                                }}
                              >
                                <StatusPill value="Reversed" />
                              </button>
                            ) : (
                              <StatusPill value="Reversed" />
                            )
                          ) : null}
                          {entry.movementType === "Reversal" && affordance.linksToBatchId ? (
                            <button
                              type="button"
                              className="text-xs text-brand hover:underline"
                              onClick={(event) => {
                                event.stopPropagation()
                                focusBatch(affordance.linksToBatchId!)
                              }}
                            >
                              Original
                            </button>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-[180px] truncate text-sm text-foreground" title={entry.productLabel}>
                        {entry.productLabel}
                      </TableCell>
                      <TableCell className="max-w-[180px] truncate text-sm text-muted-foreground" title={entry.clientDisplay}>
                        {entry.clientId ? (
                          <Link
                            href={`/clients/${entry.clientId}`}
                            className="text-brand hover:underline"
                            onClick={(event) => event.stopPropagation()}
                          >
                            {entry.clientDisplay}
                          </Link>
                        ) : (
                          entry.clientDisplay
                        )}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums text-foreground">
                        {entry.count}
                      </TableCell>
                      {showFinancials ? (
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {entry.invoiceNumber || "—"}
                        </TableCell>
                      ) : null}
                      <TableCell>
                        {entry.deliveryNoteUrl ? (
                          <SignedStorageLink path={entry.deliveryNoteUrl} className="text-xs text-brand hover:underline">
                            View
                          </SignedStorageLink>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      {canReverse ? (
                        <TableCell onClick={(event) => event.stopPropagation()}>
                          {affordance.showReverse || affordance.showRestore ? (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" className="size-8" aria-label="Batch actions">
                                  <MoreHorizontal className="size-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                {affordance.showReverse ? (
                                  <DropdownMenuItem
                                    className="text-destructive focus:text-destructive"
                                    disabled={reversingBatchKey !== null}
                                    onSelect={() => void openReverse(entry)}
                                  >
                                    <Undo2 className="size-4" />
                                    Reverse
                                  </DropdownMenuItem>
                                ) : null}
                                {affordance.showRestore ? (
                                  <DropdownMenuItem
                                    disabled={reversingBatchKey !== null}
                                    onSelect={() => void openRestore(entry)}
                                  >
                                    <Undo2 className="size-4" />
                                    Restore
                                  </DropdownMenuItem>
                                ) : null}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : null}
                        </TableCell>
                      ) : null}
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
      )}

      <BatchLinesDrawer
        open={!!viewingBatch}
        onOpenChange={(open) => {
          if (!open) setViewingBatch(null)
        }}
        title={
          viewingBatch
            ? viewingBatch.movementType === "Reversal" && viewingBatch.originalMovementType
              ? `Reversal of ${viewingBatch.originalMovementType} — ${viewingBatch.productLabel}`
              : `${viewingBatch.movementType ?? "—"} — ${viewingBatch.productLabel}`
            : "Batch items"
        }
        description={
          viewingBatch
            ? `${viewingBatch.count} item${viewingBatch.count === 1 ? "" : "s"}`
            : null
        }
        detail={viewingBatch ? {
          movement:
            viewingBatch.movementType === "Reversal" && viewingBatch.originalMovementType
              ? `Reversal of ${viewingBatch.originalMovementType}`
              : viewingBatch.movementType ?? "—",
          client: viewingBatch.clientId ? (
            <Link
              href={`/clients/${viewingBatch.clientId}`}
              className="text-brand hover:underline"
            >
              {viewingBatch.clientDisplay !== "—" ? viewingBatch.clientDisplay : "View client"}
            </Link>
          ) : (
            viewingBatch.clientDisplay
          ),
          date: (
            <BusinessDateLabel date={viewingBatch.date} createdAt={viewingBatch.recordedAt} timeZone={timeZone} />
          ),
          invoice: viewingBatch.invoiceNumber || "—",
          deliveryNote: viewingBatch.deliveryNoteUrl ? (
            <SignedStorageLink path={viewingBatch.deliveryNoteUrl} className="text-brand hover:underline">
              View
            </SignedStorageLink>
          ) : (
            "—"
          ),
          recordedBy: viewingBatch.recordedBy || "—",
          extra: [
            viewingBatch.fromLocation
              ? { label: "From", value: viewingBatch.fromLocation }
              : null,
            viewingBatch.toLocation ? { label: "To", value: viewingBatch.toLocation } : null,
            viewingBatch.movementType === "Dispose" && viewingBatch.disposalReasonSummary
              ? { label: "Disposal reason", value: viewingBatch.disposalReasonSummary }
              : null,
            viewingBatch.movementType === "Dispose" && viewingBatch.authorisedBySummary
              ? { label: "Authorised by", value: viewingBatch.authorisedBySummary }
              : null,
            viewingBatch.notesSummary
              ? {
                  label: viewingBatch.movementType === "Reversal" ? "Reversal reason" : "Notes",
                  value: viewingBatch.notesSummary,
                  span: 2 as const,
                }
              : null,
            viewingBatch.movementType === "Reversal" && viewingBatch.reversesBatchId
              ? {
                  label: "Reversed batch",
                  value: <span className="font-mono">{viewingBatch.reversesBatchId}</span>,
                  span: 2 as const,
                }
              : null,
          ].filter((fact) => fact != null),
        } : undefined}
        notice={viewingBatch && viewingBatch.isReversed && viewingBatch.movementType !== "Reversal" ? (
            <div className="mx-4 mb-3 space-y-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
              <p className="font-medium text-foreground">{viewingBatch.reversalKind === "void" ? "Voided" : "Reversed"}</p>
              {viewingBatch.reversedAt && (
                <p className="text-xs text-muted-foreground">
                  {formatRecordedAt(viewingBatch.reversedAt, null, timeZone)}
                  {viewingBatch.reversedByName ? ` by ${viewingBatch.reversedByName}` : ""}
                </p>
              )}
              {viewingBatch.reversedByBatchId ? (
                <button
                  type="button"
                  className="text-sm text-brand hover:underline"
                  onClick={() => {
                    setPageSearch(viewingBatch.reversedByBatchId ?? "")
                    setViewingBatch(null)
                  }}
                >
                  View reversal
                </button>
              ) : null}
              {viewingBatch.reversalReason && (
                <p className="text-muted-foreground whitespace-pre-wrap">{viewingBatch.reversalReason}</p>
              )}
            </div>
          ) : null}
        lines={viewingBatch ? drawerLines(viewingBatch, poolBySerial) : []}
        showInvoice={showFinancials}
        dimmed={viewingBatch?.isReversed}
      />

      <Dialog open={!!reverseTarget} onOpenChange={(open) => { if (!open) closeReverse() }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reverse batch</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            A receipt that created the item is moved to trash. Fields that cannot be reconstructed are entered here
            and stored on the reversal as entered at reversal.
          </p>
          {reversePlan === null ? (
            <p className="text-sm text-muted-foreground">Loading the kit this reversal will write…</p>
          ) : (
            reversePlan.map((row) => {
              const movementType = reverseTarget?.movementType ?? ""
              const options =
                movementType in REVERSAL_PREDECESSORS
                  ? REVERSAL_PREDECESSORS[movementType as keyof typeof REVERSAL_PREDECESSORS]
                  : row.status
                    ? [row.status]
                    : []
              const entered = enteredFields[row.transactionId] ?? { location: "", returnDate: "" }
              return (
                <div key={row.transactionId} className="space-y-2">
                  <p className="text-sm">
                    {reversalResultLine(row, {
                      status: confirmStatus[row.transactionId],
                      location: entered.location,
                      returnDate: entered.returnDate,
                    })}
                  </p>
                  <p className="font-mono text-xs text-muted-foreground">{row.serial}</p>
                  {row.needs.includes("status") ? (
                    <div className="space-y-1">
                      <Label>Status for {row.serial}</Label>
                      <select
                        className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground"
                        value={confirmStatus[row.transactionId] || row.status || ""}
                        onChange={(event) =>
                          setConfirmStatus((prev) => ({ ...prev, [row.transactionId]: event.target.value }))
                        }
                      >
                        {options.map((status) => (
                          <option key={status} value={status}>
                            {status}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                  {row.needs.includes("location") ? (
                    <div className="space-y-1">
                      <Label>Warehouse for {row.serial}</Label>
                      <select
                        className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground"
                        value={entered.location}
                        onChange={(event) =>
                          setEnteredFields((prev) => ({
                            ...prev,
                            [row.transactionId]: { ...entered, location: event.target.value },
                          }))
                        }
                      >
                        <option value="">Choose a warehouse</option>
                        {INTERNAL_LOCATIONS.map((location) => (
                          <option key={location} value={location}>
                            {location}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                  {row.needs.includes("return_date") ? (
                    <div className="space-y-1">
                      <Label>Return date for {row.serial}</Label>
                      <input
                        type="date"
                        required
                        className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground"
                        value={entered.returnDate}
                        onChange={(event) =>
                          setEnteredFields((prev) => ({
                            ...prev,
                            [row.transactionId]: { ...entered, returnDate: event.target.value },
                          }))
                        }
                      />
                    </div>
                  ) : null}
                </div>
              )
            })
          )}
          <div className="space-y-2">
            <Label htmlFor="reverse-reason">Reason (required, min {MIN_REASON_LENGTH} characters)</Label>
            <Textarea
              id="reverse-reason"
              value={reverseReason}
              onChange={(e) => setReverseReason(e.target.value)}
              placeholder="e.g. Client cancelled order — sale recorded in error."
              className="min-h-[100px] resize-y"
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={closeReverse} disabled={reversingBatchKey !== null}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void submitReverse()}
              disabled={reversingBatchKey !== null || reversePlan === null || reverseMissing}
            >
              {reversingBatchKey !== null ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Reversing…
                </>
              ) : (
                "Confirm reverse"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!restoreTarget} onOpenChange={(open) => { if (!open) closeRestore() }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Restore batch</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            The reversal stays in the history. Restoring writes the movement&apos;s result back onto the kit. A voided
            receipt counts again and does not change stock.
          </p>
          {restorePlan === null ? (
            <p className="text-sm text-muted-foreground">Loading the kit this restore will write…</p>
          ) : restorePlan.kind === "void" ? (
            <p className="text-sm">Kit will return to: no stock change</p>
          ) : (
            restorePlan.rows.map((row) => (
              <p key={row.transactionId} className="text-sm">
                {reversalResultLine(
                  { softDelete: false, status: row.status, client: row.client, location: row.location, returnDate: row.returnDate },
                  {}
                )}
                <span className="mt-1 block font-mono text-xs text-muted-foreground">{row.serial}</span>
              </p>
            ))
          )}
          <div className="space-y-2">
            <Label htmlFor="restore-reason">Reason (required, min {MIN_REASON_LENGTH} characters)</Label>
            <Textarea
              id="restore-reason"
              value={restoreReason}
              onChange={(event) => setRestoreReason(event.target.value)}
              placeholder="e.g. Reversal was recorded against the wrong batch."
              className="min-h-[100px] resize-y"
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={closeRestore} disabled={reversingBatchKey !== null}>
              Cancel
            </Button>
            <Button onClick={() => void submitRestore()} disabled={reversingBatchKey !== null || restorePlan === null}>
              {reversingBatchKey !== null ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Restoring…
                </>
              ) : (
                "Confirm restore"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function drawerLines(
  batch: TransactionBatchSummary,
  poolBySerial: Map<string, string | undefined>
): BatchDrawerLine[] {
  const source =
    batch.lines && batch.lines.length > 0
      ? batch.lines
      : batch.serials.map((serialNumber) => ({ serialNumber }))
  return source.map((line) => ({
    serialNumber: line.serialNumber,
    stockPool: poolBySerial.get(line.serialNumber),
  }))
}
