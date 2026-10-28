"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { Copy, Loader2, MoreHorizontal } from "lucide-react"
import { DrawerBodySkeleton } from "@/components/fs/content-skeletons"
import { LoadErrorInline } from "@/components/fs/load-error-inline"
import { toast } from "sonner"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { StatusPill } from "@/components/fs/status-pill"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BusinessDateLabel } from "@/components/business-date-label"
import { SignedStorageLink } from "@/components/signed-storage-link"
import { DIRECT_NO_REQUEST, requestHref } from "@/lib/batch-request-context"
import { displayInitials } from "@/lib/format-display"
import { formatRecordedAt } from "@/lib/business-date.mjs"
import {
  invoicePendingDays,
  movementBatchDrawerTitle,
  movementBatchStatePill,
  type MovementBatchDrawerPayload,
} from "@/lib/movement-batch-drawer"
import { displayInvoiceNumber, realInvoiceNumberProblem, type InvoiceState } from "@/lib/invoices"
import { canManageInvoices, canReverseQuickScanBatches } from "@/lib/permissions"
import { useAuth } from "@/lib/auth-context"
import { getSupabaseClient } from "@/lib/supabase/client"

const SERIAL_SEARCH_MIN = 10

async function copySerials(serials: string[], toastLabel: string) {
  const text = serials.join("\n")
  if (!text.trim()) {
    toast.error("Nothing to copy")
    return
  }
  try {
    await navigator.clipboard.writeText(text)
    toast.success(toastLabel)
  } catch {
    toast.error("Could not copy — check browser permissions for clipboard")
  }
}

function PersonCell({
  name,
  sub,
}: {
  name: string
  sub?: React.ReactNode
}) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <Avatar className="size-8 shrink-0 border border-border">
        <AvatarFallback className="bg-muted text-xs font-semibold text-foreground">
          {displayInitials(name)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">{name}</p>
        {sub ? <div className="text-xs text-muted-foreground">{sub}</div> : null}
      </div>
    </div>
  )
}

function InvoiceDetailsBlock({
  batchId,
  state,
  timeZone,
  onChanged,
}: {
  batchId: string
  state?: InvoiceState
  timeZone: string
  onChanged: () => void
}) {
  const { role } = useAuth()
  const canEdit = canManageInvoices(role)
  const [showChange, setShowChange] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [number, setNumber] = useState("")
  const [reason, setReason] = useState("")
  const [adding, setAdding] = useState(false)

  if (!state) return null

  async function addNumber() {
    const problem = realInvoiceNumberProblem(number)
    if (problem) {
      toast.error(problem)
      return
    }
    setAdding(true)
    try {
      const { error } = await getSupabaseClient().rpc("set_batch_invoice", {
        p_batch_id: batchId,
        p_choice: "number",
        p_invoice_number: number.trim(),
        p_reason: null,
      })
      if (error) throw new Error(error.message)
      toast.success("Invoice number added")
      setNumber("")
      setShowAdd(false)
      onChanged()
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not add invoice number")
    } finally {
      setAdding(false)
    }
  }

  async function changeNumber() {
    const problem = realInvoiceNumberProblem(number)
    if (problem) {
      toast.error(problem)
      return
    }
    if (reason.trim().length < 15) {
      toast.error("A reason of at least 15 characters is required")
      return
    }
    setAdding(true)
    try {
      const { error } = await getSupabaseClient().rpc("set_batch_invoice", {
        p_batch_id: batchId,
        p_choice: "number",
        p_invoice_number: number.trim(),
        p_reason: reason.trim(),
      })
      if (error) throw new Error(error.message)
      toast.success("Invoice number updated")
      setNumber("")
      setReason("")
      setShowChange(false)
      onChanged()
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not change invoice")
    } finally {
      setAdding(false)
    }
  }

  const pendingDays = state.status === "pending" ? invoicePendingDays(state.enteredAt, timeZone) : null

  return (
    <div className="space-y-2 text-sm">
      {state.status === "invoiced" ? (
        <p className="font-mono text-foreground">{displayInvoiceNumber(state.invoiceNumber)}</p>
      ) : state.status === "pending" ? (
        <p className="text-foreground">
          Pending
          {pendingDays != null ? ` · ${pendingDays} day${pendingDays === 1 ? "" : "s"}` : ""}
        </p>
      ) : (
        <p className="text-foreground">{displayInvoiceNumber(state.invoiceNumber)}</p>
      )}
      {state.status === "invoiced" && canEdit ? (
        <button
          type="button"
          className="text-xs text-brand hover:underline"
          onClick={() => setShowChange((v) => !v)}
        >
          Change
        </button>
      ) : null}
      {showChange && canEdit ? (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
          <Input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="New invoice number" className="h-9" />
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for the change" rows={2} />
          <Button type="button" size="sm" disabled={adding} onClick={() => void changeNumber()}>
            Save change
          </Button>
        </div>
      ) : null}
      {state.status === "pending" && canEdit ? (
        showAdd ? (
          <div className="flex flex-col gap-2 rounded-md border border-border p-3">
            <Input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="Invoice number" className="h-9" />
            <Button type="button" size="sm" disabled={adding} onClick={() => void addNumber()}>
              Save
            </Button>
          </div>
        ) : (
          <button type="button" className="text-xs text-brand hover:underline" onClick={() => setShowAdd(true)}>
            Add number
          </button>
        )
      ) : null}
    </div>
  )
}

export function MovementBatchDrawer({
  open,
  onOpenChange,
  batchKey,
  seed,
  timeZone,
  showFinancials,
  isReversed,
  reversalKind,
  onReverse,
  onRestore,
  onReload,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  batchKey: string
  seed?: Partial<MovementBatchDrawerPayload> & { originalMovementType?: string }
  timeZone: string
  showFinancials: boolean
  isReversed?: boolean
  reversalKind?: "reversal" | "void"
  onReverse?: () => void
  onRestore?: () => void
  onReload?: () => void
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  const { role } = useAuth()
  const viewer = role === "viewer"
  const [detail, setDetail] = useState<MovementBatchDrawerPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [retryToken, setRetryToken] = useState(0)
  const [search, setSearch] = useState("")
  const [tab, setTab] = useState("items")
  const [footerAddInvoiceOpen, setFooterAddInvoiceOpen] = useState(false)
  const [footerInvoiceNumber, setFooterInvoiceNumber] = useState("")
  const [footerAddingInvoice, setFooterAddingInvoice] = useState(false)

  useEffect(() => {
    if (!open) {
      setDetail(null)
      setSearch("")
      setTab("items")
      setFooterAddInvoiceOpen(false)
      setFooterInvoiceNumber("")
      return
    }
    let cancelled = false
    setLoading(true)
    setLoadError(false)
    void fetch(`/api/movement-batches/detail?batchKey=${encodeURIComponent(batchKey)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(typeof data?.error === "string" ? data.error : "Failed to load batch")
        return data as MovementBatchDrawerPayload
      })
      .then((payload) => {
        if (cancelled) return
        setDetail({
          ...payload,
          isReversed: isReversed ?? payload.isReversed,
          reversalKind: reversalKind ?? payload.reversalKind,
        })
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        toast.error(cause instanceof Error ? cause.message : "Could not load batch")
        if (!seed) {
          setDetail(null)
          setLoadError(true)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // seed is optional first paint only — omit from deps to avoid identity churn
    // eslint-disable-next-line react-hooks/exhaustive-deps -- retryToken / batchKey drive reload
  }, [open, batchKey, isReversed, reversalKind, retryToken])

  const merged = useMemo(() => {
    if (!detail && !seed) return null
    return {
      ...(seed ?? {}),
      ...(detail ?? {}),
      batchKey,
      lines: detail?.lines ?? seed?.lines ?? [],
      timeline: detail?.timeline ?? [],
    } as MovementBatchDrawerPayload & { originalMovementType?: string }
  }, [detail, seed, batchKey])

  const showSearch = (merged?.lines.length ?? 0) > SERIAL_SEARCH_MIN
  const filteredLines = useMemo(() => {
    const lines = merged?.lines ?? []
    const query = showSearch ? search.trim().toLowerCase() : ""
    if (!query) return lines
    return lines.filter((line) => line.serialNumber.toLowerCase().includes(query))
  }, [merged?.lines, search, showSearch])

  const title = merged
    ? movementBatchDrawerTitle({
        movementType: merged.movementType,
        originalMovementType: seed?.originalMovementType,
        count: merged.count,
        productLabel: merged.productLabel,
        lines: merged.lines,
      })
    : "Batch"

  const statePill = merged
    ? movementBatchStatePill({
        isReversed: merged.isReversed ?? isReversed,
        reversalKind: merged.reversalKind ?? reversalKind,
        invoiceState: merged.invoiceState,
        enteredAt: merged.invoiceState?.enteredAt,
        timeZone,
      })
    : null

  const requesterName = merged?.request?.requesterName
  const issuerName = merged?.recordedBy?.trim() || "Unknown"
  const issuerTime = merged?.recordedAt

  const historyCount = merged?.timeline.length ?? 0
  const detailsFields = merged
    ? [
        merged.request
          ? {
              label: "Request",
              value: (
                <div className="space-y-2">
                  <Link href={requestHref(merged.request.requestId)} className="text-brand hover:underline">
                    {merged.request.requestNumber}
                  </Link>
                  {merged.request.atlasTaskUrl ? (
                    <Button variant="outline" size="sm" className="h-8" asChild>
                      <a href={merged.request.atlasTaskUrl} target="_blank" rel="noreferrer">
                        Open in Atlas
                      </a>
                    </Button>
                  ) : null}
                </div>
              ),
            }
          : null,
        showFinancials && merged.invoiceBatchId && (merged.movementType === "Sale" || merged.movementType === "Rentals")
          ? {
              label: "Invoice",
              value: (
                <InvoiceDetailsBlock
                  batchId={merged.invoiceBatchId}
                  state={merged.invoiceState}
                  timeZone={timeZone}
                  onChanged={() => {
                    onReload?.()
                    if (open) {
                      void fetch(`/api/movement-batches/detail?batchKey=${encodeURIComponent(batchKey)}`)
                        .then((r) => r.json())
                        .then((payload) => setDetail(payload))
                    }
                  }}
                />
              ),
            }
          : null,
        merged.deliveryNoteUrl
          ? {
              label: "Delivery note",
              value: (
                <SignedStorageLink path={merged.deliveryNoteUrl} className="text-brand hover:underline">
                  View
                </SignedStorageLink>
              ),
            }
          : null,
        merged.notesSummary
          ? { label: merged.movementType === "Reversal" ? "Reversal reason" : "Notes", value: merged.notesSummary }
          : null,
      ].filter(Boolean)
    : []

  const invoicePending =
    showFinancials &&
    merged?.invoiceBatchId &&
    (merged.movementType === "Sale" || merged.movementType === "Rentals") &&
    merged.invoiceState?.status === "pending"

  const showFooter =
    !viewer &&
    (canManageInvoices(role) || canReverseQuickScanBatches(role) || (merged?.lines.length ?? 0) > 0)

  async function addInvoiceFromFooter() {
    if (!merged?.invoiceBatchId) return
    const problem = realInvoiceNumberProblem(footerInvoiceNumber)
    if (problem) {
      toast.error(problem)
      return
    }
    setFooterAddingInvoice(true)
    try {
      const { error } = await getSupabaseClient().rpc("set_batch_invoice", {
        p_batch_id: merged.invoiceBatchId,
        p_choice: "number",
        p_invoice_number: footerInvoiceNumber.trim(),
        p_reason: null,
      })
      if (error) throw new Error(error.message)
      toast.success("Invoice number added")
      setFooterInvoiceNumber("")
      setFooterAddInvoiceOpen(false)
      onReload?.()
      const payload = await fetch(`/api/movement-batches/detail?batchKey=${encodeURIComponent(batchKey)}`).then((r) =>
        r.json(),
      )
      setDetail(payload)
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not add invoice number")
    } finally {
      setFooterAddingInvoice(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="flex w-full max-w-none flex-col gap-0 overflow-hidden p-0 max-md:h-[100dvh] max-md:max-w-none md:w-[480px] md:max-w-[480px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          headingRef.current?.focus()
        }}
      >
        <SheetHeader className="shrink-0 space-y-2 border-b border-border px-4 pb-3 pt-4 pr-12 text-left">
          <SheetTitle ref={headingRef} tabIndex={-1} className="text-left text-base leading-snug outline-none">
            {title}
          </SheetTitle>
          {merged ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <BusinessDateLabel date={merged.date} createdAt={merged.recordedAt} timeZone={timeZone} />
              <StatusPill value={merged.movementType} />
              {statePill ? <StatusPill value={statePill} /> : null}
            </div>
          ) : null}
        </SheetHeader>

        {loading && !merged ? (
          <DrawerBodySkeleton />
        ) : loadError && !merged ? (
          <LoadErrorInline onRetry={() => setRetryToken((n) => n + 1)} />
        ) : merged ? (
          <>
            <div className="shrink-0 border-b border-border px-4 py-3">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="min-w-0 space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Client</p>
                  {merged.clientId ? (
                    <Link href={`/clients/${merged.clientId}`} className="text-sm text-brand hover:underline">
                      {merged.clientDisplay}
                    </Link>
                  ) : (
                    <p className="text-sm text-foreground">{merged.clientDisplay}</p>
                  )}
                </div>
                <div className="min-w-0 space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Requested by</p>
                  {merged.request ? (
                    <PersonCell
                      name={requesterName || "—"}
                      sub={
                        <Link href={requestHref(merged.request.requestId)} className="text-brand hover:underline">
                          {merged.request.requestNumber}
                        </Link>
                      }
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground">{DIRECT_NO_REQUEST}</p>
                  )}
                </div>
                <div className="min-w-0 space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Issued by</p>
                  <PersonCell
                    name={issuerName}
                    sub={
                      issuerTime ? (
                        <span>{formatRecordedAt(issuerTime, merged.date, timeZone)}</span>
                      ) : undefined
                    }
                  />
                </div>
              </div>
            </div>

            <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
              <TabsList className="mx-4 mt-2 grid w-auto shrink-0 grid-cols-3">
                <TabsTrigger value="items">Items ({merged.lines.length})</TabsTrigger>
                <TabsTrigger value="details">Details ({detailsFields.length})</TabsTrigger>
                <TabsTrigger value="history">History ({historyCount})</TabsTrigger>
              </TabsList>

              <TabsContent value="items" className="mt-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
                <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
                  {showSearch ? (
                    <Input
                      aria-label="Search serial numbers"
                      placeholder="Search serial numbers..."
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      className="h-8 min-w-0 flex-1"
                    />
                  ) : (
                    <span className="sr-only">Serial numbers</span>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button type="button" variant="outline" size="sm" className="ml-auto h-8 shrink-0">
                        <Copy className="mr-1.5 size-3.5" />
                        Copy all
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onSelect={() =>
                          void copySerials(
                            filteredLines.map((l) => l.serialNumber),
                            search.trim() && showSearch
                              ? `Copied ${filteredLines.length} serials (filtered)`
                              : `Copied ${filteredLines.length} serials`,
                          )
                        }
                      >
                        {search.trim() && showSearch ? `Copy filtered (${filteredLines.length})` : `Copy all (${filteredLines.length})`}
                      </DropdownMenuItem>
                      {showSearch && search.trim() ? (
                        <DropdownMenuItem
                          onSelect={() =>
                            void copySerials(
                              merged.lines.map((l) => l.serialNumber),
                              `Copied ${merged.lines.length} serials (all in batch)`,
                            )
                          }
                        >
                          Copy all in batch ({merged.lines.length})
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
                  {filteredLines.length === 0 ? (
                    <p className="py-4 text-center text-sm text-muted-foreground">No items.</p>
                  ) : (
                    <ul className="space-y-2">
                      {filteredLines.map((line) => (
                        <li
                          key={line.serialNumber}
                          className="rounded-md border border-border bg-card px-3 py-2"
                        >
                          <div className="flex items-start gap-2">
                            <div className="min-w-0 flex-1">
                              <p className="font-mono text-sm text-foreground">{line.serialNumber}</p>
                              {line.productName ? (
                                <p className="truncate text-xs text-muted-foreground">{line.productName}</p>
                              ) : null}
                              {line.requiresCloudKey && line.cloudKey ? (
                                <p className="font-mono text-xs text-muted-foreground">Cloud key {line.cloudKey}</p>
                              ) : null}
                            </div>
                            {line.status ? <StatusPill value={line.status} className="shrink-0 text-xs" /> : null}
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="size-7 shrink-0"
                              onClick={() => void copySerials([line.serialNumber], "Copied serial")}
                            >
                              <Copy className="size-3.5" />
                              <span className="sr-only">Copy serial</span>
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </TabsContent>

              <TabsContent value="details" className="mt-0 min-h-0 flex-1 overflow-y-auto px-4 py-3 data-[state=inactive]:hidden">
                {detailsFields.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No extra details for this batch.</p>
                ) : (
                  <dl className="space-y-4">
                    {detailsFields.map((field) => (
                      <div key={field!.label}>
                        <dt className="text-xs font-medium text-muted-foreground">{field!.label}</dt>
                        <dd className="mt-1 text-sm text-foreground">{field!.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </TabsContent>

              <TabsContent value="history" className="mt-0 min-h-0 flex-1 overflow-y-auto px-4 py-3 data-[state=inactive]:hidden">
                {historyCount === 0 ? (
                  <p className="text-sm text-muted-foreground">No history recorded.</p>
                ) : (
                  <ol className="relative border-l border-border pl-4">
                    {merged.timeline.map((entry, index) => (
                      <li key={`${entry.at}-${index}`} className="mb-4 ml-1">
                        <p className="text-sm font-medium text-foreground">{entry.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatRecordedAt(entry.at, null, timeZone)}
                          {entry.actorName ? ` · ${entry.actorName}` : ""}
                        </p>
                        {entry.changeFrom && entry.changeTo ? (
                          <p className="text-sm text-foreground">
                            {entry.changeFrom} → {entry.changeTo}
                          </p>
                        ) : null}
                        {entry.reason ? <p className="text-sm text-muted-foreground">{entry.reason}</p> : null}
                        {entry.detail && entry.kind !== "requested" ? (
                          <p className="text-sm text-muted-foreground">{entry.detail}</p>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                )}
              </TabsContent>
            </Tabs>

            {showFooter ? (
              <div className="flex shrink-0 items-center gap-2 border-t border-border bg-background px-4 py-3">
                {canReverseQuickScanBatches(role) && (onReverse || onRestore) ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button type="button" variant="outline" size="icon" className="size-9 shrink-0" aria-label="Batch actions">
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      {onReverse ? (
                        <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={onReverse}>
                          Reverse
                        </DropdownMenuItem>
                      ) : null}
                      {onRestore ? <DropdownMenuItem onSelect={onRestore}>Restore</DropdownMenuItem> : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
                <div className="ml-auto flex flex-wrap gap-2">
                  {canManageInvoices(role) && invoicePending ? (
                    <Button type="button" size="sm" onClick={() => setFooterAddInvoiceOpen(true)}>
                      Add invoice number
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void copySerials(
                        merged.lines.map((l) => l.serialNumber),
                        `Copied ${merged.lines.length} serial numbers`,
                      )
                    }
                  >
                    Copy all
                  </Button>
                </div>
              </div>
            ) : null}
            <Dialog open={footerAddInvoiceOpen} onOpenChange={setFooterAddInvoiceOpen}>
              <DialogContent className="max-w-sm">
                <DialogHeader>
                  <DialogTitle>Add invoice number</DialogTitle>
                </DialogHeader>
                <Input
                  value={footerInvoiceNumber}
                  onChange={(e) => setFooterInvoiceNumber(e.target.value)}
                  placeholder="Invoice number"
                  className="h-9"
                />
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setFooterAddInvoiceOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="button" disabled={footerAddingInvoice} onClick={() => void addInvoiceFromFooter()}>
                    Save
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
