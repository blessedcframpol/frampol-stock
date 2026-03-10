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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { History, Undo2, Loader2, Search } from "lucide-react"
import type { QuickScanRecord } from "@/lib/data"
import { formatDateDDMMYYYY } from "@/lib/utils"
import { toast } from "sonner"

/** One row in scan history: a single submission (bulk or one item). */
type ScanBatchEntry = {
  batchKey: string
  scannedAt: string
  movementType: string | undefined
  scanType: string
  count: number
  clientDisplay: string
  records: QuickScanRecord[]
}

function groupScansByBatch(scans: QuickScanRecord[]): ScanBatchEntry[] {
  const byBatch = new Map<string, QuickScanRecord[]>()
  for (const r of scans) {
    const key = r.batchId ?? r.id
    const list = byBatch.get(key) ?? []
    list.push(r)
    byBatch.set(key, list)
  }
  return Array.from(byBatch.entries())
    .map(([batchKey, records]) => {
      const first = records[0]!
      const clientDisplay = first.clientName
        ? first.clientCompany
          ? `${first.clientName} · ${first.clientCompany}`
          : first.clientName
        : first.clientCompany ?? "—"
      return {
        batchKey,
        scannedAt: first.scannedAt,
        movementType: first.movementType,
        scanType: first.scanType,
        count: records.length,
        clientDisplay,
        records,
      }
    })
    .sort((a, b) => new Date(b.scannedAt).getTime() - new Date(a.scannedAt).getTime())
}

export function ScanHistoryContent() {
  const [scans, setScans] = useState<QuickScanRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [undoingBatchKey, setUndoingBatchKey] = useState<string | null>(null)
  const [viewingBatch, setViewingBatch] = useState<ScanBatchEntry | null>(null)
  const [batchSearch, setBatchSearch] = useState("")
  const [pageSearch, setPageSearch] = useState("")

  const batches = useMemo(() => groupScansByBatch(scans), [scans])

  const filteredBatches = useMemo(() => {
    if (!pageSearch.trim()) return batches
    const q = pageSearch.trim().toLowerCase()
    return batches.filter((entry) => {
      const dateStr = formatDateDDMMYYYY(entry.scannedAt).toLowerCase()
      const movement = (entry.movementType ?? "").toLowerCase()
      const product = entry.scanType.toLowerCase()
      const client = entry.clientDisplay.toLowerCase()
      const serialMatch = entry.records.some((r) => r.serialNumber.toLowerCase().includes(q))
      return (
        dateStr.includes(q) ||
        movement.includes(q) ||
        product.includes(q) ||
        client.includes(q) ||
        serialMatch
      )
    })
  }, [batches, pageSearch])

  const fetchScans = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/quick-scan")
      if (!res.ok) throw new Error("Failed to load scans")
      const data = await res.json()
      setScans(Array.isArray(data) ? data : [])
    } catch {
      toast.error("Failed to load scan history")
      setScans([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchScans()
  }, [fetchScans])

  async function handleUndo(entry: ScanBatchEntry) {
    setUndoingBatchKey(entry.batchKey)
    try {
      const res = await fetch(
        `/api/quick-scan?batchId=${encodeURIComponent(entry.batchKey)}`,
        { method: "DELETE" }
      )
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? "Failed to undo")
      }
      setScans((prev) =>
        prev.filter((s) => (s.batchId ?? s.id) !== entry.batchKey)
      )
      toast.success(
        entry.count === 1
          ? `Removed scan: ${entry.records[0]!.serialNumber} (${entry.scanType})`
          : `Removed ${entry.count} items (${entry.scanType})`
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to undo scan")
    } finally {
      setUndoingBatchKey(null)
    }
  }

  return (
    <div className="flex flex-col gap-6 min-w-0">
      <div>
        <h1 className="text-xl md:text-2xl font-bold text-foreground tracking-tight">
          Scan history
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          One entry per submission (single or bulk). Use Undo to remove that entire scan batch.
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
              <p className="text-sm font-medium text-foreground">No scan history</p>
              <p className="text-sm text-muted-foreground mt-1">
                Quick scans will appear here as one entry per submission (single or bulk).
              </p>
            </div>
          ) : (
            <>
              <div className="p-4 border-b border-border">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    placeholder="Search by date, movement, product, client, or serial..."
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
                      <TableHead className="text-xs text-muted-foreground font-medium w-[100px]">Actions</TableHead>
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
                      className="cursor-pointer hover:bg-muted/50 transition-colors"
                      onClick={() => {
                        setViewingBatch(entry)
                        setBatchSearch("")
                      }}
                    >
                      <TableCell className="text-sm text-foreground whitespace-nowrap">
                        {formatDateDDMMYYYY(entry.scannedAt)}
                        <span className="text-muted-foreground text-xs ml-1">
                          {entry.scannedAt.includes("T")
                            ? new Date(entry.scannedAt).toLocaleTimeString(undefined, {
                                hour: "2-digit",
                                minute: "2-digit",
                              })
                            : ""}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {entry.movementType ?? "—"}
                      </TableCell>
                      <TableCell className="text-sm text-foreground">{entry.scanType}</TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-[180px] truncate" title={entry.clientDisplay}>
                        {entry.clientDisplay}
                      </TableCell>
                      <TableCell className="text-sm text-foreground tabular-nums">
                        {entry.count} item{entry.count !== 1 ? "s" : ""}
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive hover:bg-destructive/10 gap-1.5"
                            onClick={() => handleUndo(entry)}
                            disabled={undoingBatchKey !== null}
                          >
                            {undoingBatchKey === entry.batchKey ? (
                              <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                            ) : (
                              <Undo2 className="w-4 h-4 shrink-0" />
                            )}
                            <span className="hidden sm:inline">Undo</span>
                          </Button>
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
                ? `${viewingBatch.scanType} — ${viewingBatch.count} item${viewingBatch.count === 1 ? "" : "s"}`
                : "Batch items"}
            </DialogTitle>
          </DialogHeader>
          {viewingBatch && (
            <>
              <Input
                placeholder="Search serial numbers..."
                value={batchSearch}
                onChange={(e) => setBatchSearch(e.target.value)}
                className="flex-shrink-0"
                autoFocus
              />
              <div className="flex flex-col gap-1 min-h-0 overflow-hidden">
                <BatchItemsList
                  records={viewingBatch.records}
                  search={batchSearch.trim()}
                />
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function BatchItemsList({
  records,
  search,
}: {
  records: QuickScanRecord[]
  search: string
}) {
  const filtered = useMemo(() => {
    if (!search) return records
    const q = search.toLowerCase()
    return records.filter((r) =>
      r.serialNumber.toLowerCase().includes(q)
    )
  }, [records, search])

  return (
    <div className="border border-border rounded-md overflow-hidden flex-1 min-h-0 flex flex-col">
      <div className="overflow-y-auto flex-1 min-h-0 p-1 max-h-[50vh]">
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            {search ? "No serial numbers match your search." : "No items."}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {filtered.map((r) => (
              <li
                key={r.id}
                className="font-mono text-sm py-1.5 px-2 rounded hover:bg-muted/50"
              >
                {r.serialNumber}
              </li>
            ))}
          </ul>
        )}
      </div>
      {search && (
        <p className="text-xs text-muted-foreground px-2 py-1.5 border-t border-border">
          Showing {filtered.length} of {records.length}
        </p>
      )}
    </div>
  )
}
