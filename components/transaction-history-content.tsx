"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { History, Undo2, Loader2, Search, Copy, ChevronsUpDown } from "lucide-react"
import { INTERNAL_LOCATIONS, type InternalLocation } from "@/lib/data"
import type { TransactionBatchSummary } from "@/lib/transaction-batches"
import { cn } from "@/lib/utils"
import { formatDateDDMMYYYY } from "@/lib/utils"
import { toast } from "sonner"
import { toastFromApiErrorBody, toastFromCaughtError } from "@/lib/toast-reportable-error"
import { useAuth } from "@/lib/auth-context"
import { canReverseQuickScanBatches } from "@/lib/permissions"
import { isQuickScanStockReversibleMovement } from "@/lib/quick-scan-reversal-inventory"

const MIN_REASON_LENGTH = 15

function filterSerialsBySearch(serials: string[], search: string): string[] {
  const q = search.trim().toLowerCase()
  if (!q) return serials
  return serials.filter((s) => s.toLowerCase().includes(q))
}

async function copySerialLinesToClipboard(serials: string[], toastLabel: string) {
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

export function TransactionHistoryContent() {
  const { role } = useAuth()
  const canReverse = canReverseQuickScanBatches(role)
  const [batches, setBatches] = useState<TransactionBatchSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [reversingBatchKey, setReversingBatchKey] = useState<string | null>(null)
  const [viewingBatch, setViewingBatch] = useState<TransactionBatchSummary | null>(null)
  const [batchSearch, setBatchSearch] = useState("")
  const [pageSearch, setPageSearch] = useState("")
  const [reverseTarget, setReverseTarget] = useState<TransactionBatchSummary | null>(null)
  const [reverseReason, setReverseReason] = useState("")
  const [returnLocation, setReturnLocation] = useState<InternalLocation>(INTERNAL_LOCATIONS[0])
  const [locationOpen, setLocationOpen] = useState(false)
  const [locationSearch, setLocationSearch] = useState("")

  const displayedSerials = useMemo(() => {
    if (!viewingBatch) return []
    return filterSerialsBySearch(viewingBatch.serials, batchSearch)
  }, [viewingBatch, batchSearch])

  const filteredBatches = useMemo(() => {
    if (!pageSearch.trim()) return batches
    const q = pageSearch.trim().toLowerCase()
    return [...batches].filter((entry) => {
      const dateStr = formatDateDDMMYYYY(entry.date).toLowerCase()
      const movement = (entry.movementType ?? "").toLowerCase()
      const product = entry.productLabel.toLowerCase()
      const client = entry.clientDisplay.toLowerCase()
      const reason = (entry.reversalReason ?? "").toLowerCase()
      const serialMatch = entry.serials.some((s) => s.toLowerCase().includes(q))
      const inv = (entry.invoiceNumber ?? "").toLowerCase()
      return (
        dateStr.includes(q) ||
        movement.includes(q) ||
        product.includes(q) ||
        client.includes(q) ||
        reason.includes(q) ||
        serialMatch ||
        inv.includes(q)
      )
    })
  }, [batches, pageSearch])

  const fetchBatches = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/transaction-batches")
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toastFromApiErrorBody(data, "Failed to load transaction history")
        setBatches([])
        return
      }
      setBatches(Array.isArray(data) ? data : [])
    } catch (e) {
      toastFromCaughtError(e, "Failed to load transaction history")
      setBatches([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchBatches()
  }, [fetchBatches])

  async function submitReverse() {
    if (!reverseTarget?.reverseBatchId) return
    const reason = reverseReason.trim()
    if (reason.length < MIN_REASON_LENGTH) {
      toast.error(`Please enter a reason (at least ${MIN_REASON_LENGTH} characters).`)
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
          returnLocation,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toastFromApiErrorBody(data, "Failed to reverse batch")
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
      setReturnLocation(INTERNAL_LOCATIONS[0])
      setLocationSearch("")
      setLocationOpen(false)
      await fetchBatches()
    } catch (e) {
      toastFromCaughtError(e, "Failed to reverse batch")
    } finally {
      setReversingBatchKey(null)
    }
  }

  function openReverse(entry: TransactionBatchSummary) {
    setReverseTarget(entry)
    setReverseReason("")
    setReturnLocation(INTERNAL_LOCATIONS[0])
    setLocationSearch("")
    setLocationOpen(false)
  }

  return (
    <div className="flex flex-col gap-6 min-w-0">
      <div>
        <h1 className="text-xl md:text-2xl font-bold text-foreground tracking-tight">
          Transaction history
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          One row per stock movement batch (same data as <span className="text-foreground font-medium">Recent transactions</span> on the dashboard). Admins can reverse supported quick-scan batches with a reason and return location (Sale, POC Out, Rentals, Dispose, Transfer).
        </p>
      </div>

      <Card className="border-border">
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="w-8 h-8 animate-spin" />
            </div>
          ) : batches.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <History className="w-12 h-12 text-muted-foreground/50 mb-3" />
              <p className="text-sm font-medium text-foreground">No transaction history</p>
              <p className="text-sm text-muted-foreground mt-1">
                Movements from Quick Scan and Stock movement appear here as one row per batch.
              </p>
            </div>
          ) : (
            <>
              <div className="p-4 border-b border-border">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    placeholder="Search by date, movement, product, client, serial, or reversal reason..."
                    value={pageSearch}
                    onChange={(e) => setPageSearch(e.target.value)}
                    className="pl-9 bg-card text-foreground border-border"
                  />
                </div>
                {pageSearch.trim() && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Showing {filteredBatches.length} of {batches.length} entr{batches.length === 1 ? "y" : "ies"}
                  </p>
                )}
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="text-xs text-muted-foreground font-medium">Date & time</TableHead>
                      <TableHead className="text-xs text-muted-foreground font-medium">Movement</TableHead>
                      <TableHead className="text-xs text-muted-foreground font-medium">Product</TableHead>
                      <TableHead className="text-xs text-muted-foreground font-medium">Client</TableHead>
                      <TableHead className="text-xs text-muted-foreground font-medium">Items</TableHead>
                      <TableHead className="text-xs text-muted-foreground font-medium w-[120px]">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredBatches.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center py-12 text-muted-foreground text-sm">
                          No entries match your search.
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredBatches.map((entry) => (
                        <TableRow
                          key={entry.batchKey}
                          className={`cursor-pointer hover:bg-muted/50 transition-colors ${entry.isReversed ? "opacity-70 bg-muted/20" : ""}`}
                          onClick={() => {
                            setViewingBatch(entry)
                            setBatchSearch("")
                          }}
                        >
                          <TableCell className="text-sm text-foreground whitespace-nowrap">
                            {formatDateDDMMYYYY(entry.date)}
                            <span className="text-muted-foreground text-xs ml-1">
                              {entry.date.includes("T")
                                ? new Date(entry.date).toLocaleTimeString(undefined, {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })
                                : ""}
                            </span>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            <div className="flex flex-col gap-1 items-start">
                              <span>{entry.movementType ?? "—"}</span>
                              {entry.isReversed && (
                                <Badge variant="secondary" className="text-[10px] font-normal">
                                  Reversed
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-sm text-foreground">{entry.productLabel}</TableCell>
                          <TableCell className="text-sm text-muted-foreground max-w-[180px] truncate" title={entry.clientDisplay}>
                            {entry.clientDisplay}
                          </TableCell>
                          <TableCell className="text-sm text-foreground tabular-nums">
                            {entry.count} item{entry.count !== 1 ? "s" : ""}
                          </TableCell>
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center gap-1">
                              {canReverse &&
                              !entry.isReversed &&
                              entry.reverseBatchId &&
                              isQuickScanStockReversibleMovement(entry.movementType) ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-destructive hover:text-destructive hover:bg-destructive/10 gap-1.5"
                                  onClick={() => openReverse(entry)}
                                  disabled={reversingBatchKey !== null}
                                >
                                  <Undo2 className="w-4 h-4 shrink-0" />
                                  <span className="hidden sm:inline">Reverse</span>
                                </Button>
                              ) : (
                                <span className="text-xs text-muted-foreground px-2">—</span>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={!!viewingBatch}
        onOpenChange={(open) => {
          if (!open) {
            setViewingBatch(null)
            setBatchSearch("")
          }
        }}
      >
        <DialogContent className="max-w-md max-h-[85vh] flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {viewingBatch
                ? `${viewingBatch.productLabel} — ${viewingBatch.count} item${viewingBatch.count === 1 ? "" : "s"}`
                : "Batch items"}
            </DialogTitle>
          </DialogHeader>
          {viewingBatch && viewingBatch.isReversed && (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm space-y-1">
              <p className="font-medium text-foreground">Reversed</p>
              {viewingBatch.reversedAt && (
                <p className="text-xs text-muted-foreground">
                  {formatDateDDMMYYYY(viewingBatch.reversedAt)}
                  {viewingBatch.reversedAt.includes("T") &&
                    ` · ${new Date(viewingBatch.reversedAt).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}`}
                </p>
              )}
              {viewingBatch.reversalReason && (
                <p className="text-muted-foreground whitespace-pre-wrap">{viewingBatch.reversalReason}</p>
              )}
            </div>
          )}
          {viewingBatch && (
            <>
              <Input
                placeholder="Search serial numbers..."
                value={batchSearch}
                onChange={(e) => setBatchSearch(e.target.value)}
                className="flex-shrink-0"
                autoFocus
              />
              <div className="flex flex-wrap items-center justify-end gap-2 flex-shrink-0">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={() =>
                    void copySerialLinesToClipboard(
                      displayedSerials,
                      batchSearch.trim()
                        ? `Copied ${displayedSerials.length} serial number${displayedSerials.length !== 1 ? "s" : ""} (filtered)`
                        : `Copied ${displayedSerials.length} serial number${displayedSerials.length !== 1 ? "s" : ""}`
                    )
                  }
                >
                  <Copy className="w-3.5 h-3.5 mr-1.5" />
                  {batchSearch.trim()
                    ? `Copy filtered (${displayedSerials.length})`
                    : `Copy all (${displayedSerials.length})`}
                </Button>
              </div>
              <div className="flex flex-col gap-1 min-h-0 overflow-hidden">
                <BatchItemsList
                  serials={viewingBatch.serials}
                  search={batchSearch.trim()}
                  dimmed={viewingBatch.isReversed}
                />
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!reverseTarget}
        onOpenChange={(open) => {
          if (!open) {
            setReverseTarget(null)
            setReverseReason("")
            setReturnLocation(INTERNAL_LOCATIONS[0])
            setLocationSearch("")
            setLocationOpen(false)
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reverse batch</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            For Sale, POC Out, Rentals, and Dispose, items return to{" "}
            <span className="text-foreground font-medium">In stock</span> at the location you choose. Transfer reversals put each item at the transfer&apos;s origin when it matches; otherwise pick a fallback below.
          </p>
          <div className="space-y-2">
            <Label>Return to location</Label>
            <Popover open={locationOpen} onOpenChange={setLocationOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  role="combobox"
                  aria-expanded={locationOpen}
                  className="w-full justify-between h-10 font-normal"
                >
                  <span className="truncate">{returnLocation}</span>
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                <Command shouldFilter={false}>
                  <CommandInput
                    placeholder="Search locations..."
                    value={locationSearch}
                    onValueChange={setLocationSearch}
                  />
                  <CommandList>
                    <CommandEmpty>No location found.</CommandEmpty>
                    <CommandGroup>
                      {INTERNAL_LOCATIONS.filter((loc) =>
                        locationSearch.trim()
                          ? loc.toLowerCase().includes(locationSearch.trim().toLowerCase())
                          : true
                      ).map((loc) => (
                        <CommandItem
                          key={loc}
                          value={loc}
                          onSelect={() => {
                            setReturnLocation(loc)
                            setLocationSearch("")
                            setLocationOpen(false)
                          }}
                        >
                          {loc}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
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
            <Button
              variant="outline"
              onClick={() => {
                setReverseTarget(null)
                setReverseReason("")
                setReturnLocation(INTERNAL_LOCATIONS[0])
                setLocationSearch("")
                setLocationOpen(false)
              }}
              disabled={reversingBatchKey !== null}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void submitReverse()} disabled={reversingBatchKey !== null}>
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
    </div>
  )
}

function BatchItemsList({
  serials,
  search,
  dimmed,
}: {
  serials: string[]
  search: string
  dimmed?: boolean
}) {
  const filtered = useMemo(() => filterSerialsBySearch(serials, search), [serials, search])

  return (
    <div className="border border-border rounded-md overflow-hidden flex-1 min-h-0 flex flex-col">
      <div className="overflow-y-auto flex-1 min-h-0 p-1 max-h-[50vh]">
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            {search ? "No serial numbers match your search." : "No items."}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {filtered.map((serial, idx) => (
              <li
                key={`${serial}-${idx}`}
                className={`group flex items-center gap-1 font-mono text-sm py-1 px-1 rounded hover:bg-muted/50 ${dimmed ? "line-through text-muted-foreground" : ""}`}
              >
                <span className="flex-1 min-w-0 pl-1 py-0.5 select-text break-all">{serial}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 opacity-60 group-hover:opacity-100"
                  title="Copy serial"
                  onClick={() => void copySerialLinesToClipboard([serial], "Copied serial")}
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span className="sr-only">Copy serial</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {search && (
        <p className="text-xs text-muted-foreground px-2 py-1.5 border-t border-border">
          Showing {filtered.length} of {serials.length}
        </p>
      )}
    </div>
  )
}
