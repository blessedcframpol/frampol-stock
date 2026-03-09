"use client"

import { useState, useEffect, useCallback } from "react"
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
import { History, Undo2, Loader2 } from "lucide-react"
import type { QuickScanRecord } from "@/lib/data"
import { formatDateDDMMYYYY } from "@/lib/utils"
import { toast } from "sonner"

export function ScanHistoryContent() {
  const [scans, setScans] = useState<QuickScanRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [undoingId, setUndoingId] = useState<string | null>(null)

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

  async function handleUndo(record: QuickScanRecord) {
    setUndoingId(record.id)
    try {
      const res = await fetch(`/api/quick-scan/${encodeURIComponent(record.id)}`, {
        method: "DELETE",
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? "Failed to undo")
      }
      setScans((prev) => prev.filter((s) => s.id !== record.id))
      toast.success(`Removed scan: ${record.serialNumber} (${record.scanType})`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to undo scan")
    } finally {
      setUndoingId(null)
    }
  }

  return (
    <div className="flex flex-col gap-6 min-w-0">
      <div>
        <h1 className="text-xl md:text-2xl font-bold text-foreground tracking-tight">
          Scan history
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Recent quick scans. Use Undo to remove a scan if it was recorded under the wrong product.
        </p>
      </div>

      <Card className="border-border">
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="w-8 h-8 animate-spin" />
            </div>
          ) : scans.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <History className="w-12 h-12 text-muted-foreground/50 mb-3" />
              <p className="text-sm font-medium text-foreground">No scan history</p>
              <p className="text-sm text-muted-foreground mt-1">
                Quick scans will appear here. Use the dashboard to record new scans.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="text-xs text-muted-foreground font-medium">Date & time</TableHead>
                      <TableHead className="text-xs text-muted-foreground font-medium">Movement</TableHead>
                      <TableHead className="text-xs text-muted-foreground font-medium">Product</TableHead>
                      <TableHead className="text-xs text-muted-foreground font-medium">Serial number</TableHead>
                      <TableHead className="text-xs text-muted-foreground font-medium w-[100px]">Actions</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                  {scans.map((record) => (
                    <TableRow key={record.id}>
                      <TableCell className="text-sm text-foreground whitespace-nowrap">
                        {formatDateDDMMYYYY(record.scannedAt)}
                        <span className="text-muted-foreground text-xs ml-1">
                          {record.scannedAt.includes("T")
                            ? new Date(record.scannedAt).toLocaleTimeString(undefined, {
                                hour: "2-digit",
                                minute: "2-digit",
                              })
                            : ""}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {record.movementType ?? "—"}
                      </TableCell>
                      <TableCell className="text-sm text-foreground">{record.scanType}</TableCell>
                      <TableCell className="font-mono text-sm text-foreground">
                        {record.serialNumber}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive hover:bg-destructive/10 gap-1.5"
                          onClick={() => handleUndo(record)}
                          disabled={undoingId !== null}
                        >
                          {undoingId === record.id ? (
                            <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                          ) : (
                            <Undo2 className="w-4 h-4 shrink-0" />
                          )}
                          <span className="hidden sm:inline">Undo</span>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
