"use client"

import { useState, useEffect, useMemo } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import {
  ScanBarcode,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  PackageX,
  Download,
  Save,
  Loader2,
  History,
} from "lucide-react"
import type { InventoryItem, ItemStatus } from "@/lib/data"
import { useInventoryStore } from "@/lib/inventory-store"
import { compareStockTake, buildStockTakeSnapshot } from "@/lib/stock-take"
import Link from "next/link"
import { toast } from "sonner"
import { toastFromApiErrorBody, toastFromCaughtError } from "@/lib/toast-reportable-error"
import { cn } from "@/lib/utils"

const STOCK_TAKE_STORAGE_KEY = "fram-stock-take-scans"

const statusStyles: Record<ItemStatus, string> = {
  "In Stock": "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  Sold: "bg-red-500/10 text-red-500 dark:text-red-400",
  POC: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  Rented: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  Maintenance: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  "RMA Hold": "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  Disposed: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
}

function loadSessionFromStorage(): string {
  if (typeof window === "undefined") return ""
  try {
    return sessionStorage.getItem(STOCK_TAKE_STORAGE_KEY) ?? ""
  } catch {
    return ""
  }
}

function saveSessionToStorage(value: string) {
  if (typeof window === "undefined") return
  try {
    if (value) sessionStorage.setItem(STOCK_TAKE_STORAGE_KEY, value)
    else sessionStorage.removeItem(STOCK_TAKE_STORAGE_KEY)
  } catch {
    // ignore
  }
}

function exportStockTakeCsv(
  matched: InventoryItem[],
  notInSystem: string[],
  notScanned: InventoryItem[]
) {
  const rows: string[][] = []
  rows.push(["Result", "Serial", "Name", "Status", "Location"])
  for (const item of matched) {
    rows.push(["Matched", item.serialNumber, item.name, item.status, item.location])
  }
  for (const serial of notInSystem) {
    rows.push(["Not in system", serial, "", "", ""])
  }
  for (const item of notScanned) {
    rows.push(["Not scanned", item.serialNumber, item.name, item.status, item.location])
  }
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n")
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `stock-take-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

export function StockTakeContent() {
  const { inventory } = useInventoryStore()
  const [serialNumbers, setSerialNumbers] = useState(() => loadSessionFromStorage())
  const [hasCompared, setHasCompared] = useState(false)

  const serialList = useMemo(
    () =>
      serialNumbers
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    [serialNumbers]
  )
  const uniqueSerials = useMemo(() => [...new Set(serialList)], [serialList])
  const inListDuplicateCount = serialList.length - uniqueSerials.length

  useEffect(() => {
    saveSessionToStorage(serialNumbers)
  }, [serialNumbers])

  const result = useMemo(
    () => (uniqueSerials.length > 0 ? compareStockTake(uniqueSerials, inventory) : null),
    [uniqueSerials, inventory]
  )

  function handleSerialChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value
    setSerialNumbers(v.includes("\n") ? v.replace(/\n+/g, ", ").replace(/,+\s*,/g, ", ") : v)
  }

  function handleSerialPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = e.clipboardData.getData("text")
    if (pasted.includes("\n") || pasted.includes(",")) {
      e.preventDefault()
      const normalized = pasted
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .join(", ")
      setSerialNumbers((prev) => (prev ? `${prev}, ${normalized}` : normalized))
    }
  }

  const [isSaving, setIsSaving] = useState(false)

  const clearAll = () => {
    setSerialNumbers("")
    setHasCompared(false)
    toast.success("Cleared")
  }

  const handleSaveToHistory = async () => {
    if (!result || uniqueSerials.length === 0) return
    setIsSaving(true)
    try {
      const snapshot = buildStockTakeSnapshot(uniqueSerials, result)
      const res = await fetch("/api/stock-takes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resultSnapshot: snapshot }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        toastFromApiErrorBody(data, "Failed to save stock take")
        return
      }
      setSerialNumbers("")
      setHasCompared(false)
      saveSessionToStorage("")
      toast.success("Stock take saved to history")
    } catch (e) {
      toastFromCaughtError(e, "Failed to save stock take")
    } finally {
      setIsSaving(false)
    }
  }

  const handleCompare = () => {
    if (uniqueSerials.length === 0) {
      toast.error("Scan or enter at least one serial number")
      return
    }
    setHasCompared(true)
    toast.success("Comparison complete")
  }

  const handleExport = () => {
    if (!result) return
    exportStockTakeCsv(result.matched, result.notInSystem, result.notScanned)
    toast.success("CSV downloaded")
  }

  return (
    <div className="flex flex-col gap-4 md:gap-6 min-w-0 p-4 md:p-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-foreground tracking-tight text-balance">Stock take</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Scan or paste serials, then compare with current inventory to find matches, unknown items, and missing counts.
          </p>
        </div>
        <Link href="/inventory/stock-take/history">
          <Button variant="outline" size="sm" className="gap-2 shrink-0">
            <History className="size-4" />
            History
          </Button>
        </Link>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="border-dashed border-primary/30 bg-primary/[0.02]">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold text-foreground flex items-center gap-2">
              <ScanBarcode className="w-4 h-4 text-primary" />
              Scan Items
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label className="text-xs text-muted-foreground">
                Serial numbers (comma or newline separated; paste a list to add commas)
              </Label>
              <Textarea
                placeholder="SL-001, SL-002, SL-003 or one per line..."
                value={serialNumbers}
                onChange={handleSerialChange}
                onPaste={handleSerialPaste}
                className="font-mono text-xs min-h-[100px] sm:min-h-[120px] bg-card text-foreground border-border"
              />
              {serialList.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {uniqueSerials.length} item{uniqueSerials.length !== 1 ? "s" : ""} to scan
                  </span>
                  {inListDuplicateCount > 0 && (
                    <span>
                      ({inListDuplicateCount} duplicate{inListDuplicateCount !== 1 ? "s" : ""} in list, will use unique only)
                    </span>
                  )}
                </div>
              )}
            </div>
            {uniqueSerials.length > 0 && (
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="text-xs bg-primary/10 text-primary border-0">
                  {uniqueSerials.length} item{uniqueSerials.length !== 1 ? "s" : ""} scanned
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs text-muted-foreground hover:text-foreground"
                  onClick={clearAll}
                >
                  <Trash2 className="size-4 mr-1" />
                  Clear all
                </Button>
              </div>
            )}
            <Button
              type="button"
              onClick={handleCompare}
              disabled={uniqueSerials.length === 0}
              className="w-full"
            >
              Compare with system
            </Button>
            <p className="text-[11px] text-muted-foreground">
              Paste or type serial numbers (e.g. from barcode scanner). Use commas or new lines; pasted lines are auto-separated. Then click Compare to see matched, not in system, and not scanned.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-base font-semibold text-foreground">Results</CardTitle>
            {result && (
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={handleSaveToHistory}
                  disabled={isSaving}
                >
                  {isSaving ? <Loader2 className="size-4 mr-1 animate-spin" /> : <Save className="size-4 mr-1" />}
                  Save to history
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={handleExport}>
                  <Download className="size-4 mr-1" />
                  Export CSV
                </Button>
              </div>
            )}
          </CardHeader>
          <CardContent>
            {!hasCompared || !result ? (
              <Empty>
                <EmptyMedia variant="icon">
                  <PackageX className="size-6" />
                </EmptyMedia>
                <EmptyHeader>
                  <EmptyTitle>No results yet</EmptyTitle>
                  <EmptyDescription>
                    Add serials and click &quot;Compare with system&quot; to see matched items, items not in the system, and items not scanned.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <Tabs defaultValue="matched" className="w-full">
                <TabsList className="grid w-full grid-cols-3">
                  <TabsTrigger value="matched" className="text-xs sm:text-sm">
                    Matched ({result.matched.length})
                  </TabsTrigger>
                  <TabsTrigger value="notInSystem" className="text-xs sm:text-sm">
                    Not in system ({result.notInSystem.length})
                  </TabsTrigger>
                  <TabsTrigger value="notScanned" className="text-xs sm:text-sm">
                    Not scanned ({result.notScanned.length})
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="matched" className="mt-3">
                  <ResultTable
                    items={result.matched}
                    emptyIcon={<CheckCircle2 className="size-6" />}
                    emptyTitle="No matches"
                    emptyDesc="Scanned serials that exist in inventory appear here."
                    statusStyles={statusStyles}
                  />
                </TabsContent>
                <TabsContent value="notInSystem" className="mt-3">
                  <NotInSystemList
                    serials={result.notInSystem}
                    emptyIcon={<AlertTriangle className="size-6" />}
                    emptyTitle="None"
                    emptyDesc="All scanned serials were found in the system."
                  />
                </TabsContent>
                <TabsContent value="notScanned" className="mt-3">
                  <ResultTable
                    items={result.notScanned}
                    emptyIcon={<AlertTriangle className="size-6" />}
                    emptyTitle="None missing"
                    emptyDesc="Every inventory item was scanned."
                    statusStyles={statusStyles}
                  />
                </TabsContent>
              </Tabs>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function ResultTable({
  items,
  emptyIcon,
  emptyTitle,
  emptyDesc,
  statusStyles,
}: {
  items: InventoryItem[]
  emptyIcon: React.ReactNode
  emptyTitle: string
  emptyDesc: string
  statusStyles: Record<ItemStatus, string>
}) {
  if (items.length === 0) {
    return (
      <Empty>
        <EmptyMedia variant="icon">{emptyIcon}</EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>{emptyTitle}</EmptyTitle>
          <EmptyDescription>{emptyDesc}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <ScrollArea className="h-[280px] rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Serial</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Location</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <TableRow key={item.id}>
              <TableCell className="font-mono text-sm">{item.serialNumber}</TableCell>
              <TableCell>{item.name}</TableCell>
              <TableCell>
                <Badge className={cn("text-xs", statusStyles[item.status])} variant="secondary">
                  {item.status}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">{item.location}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ScrollArea>
  )
}

function NotInSystemList({
  serials,
  emptyIcon,
  emptyTitle,
  emptyDesc,
}: {
  serials: string[]
  emptyIcon: React.ReactNode
  emptyTitle: string
  emptyDesc: string
}) {
  if (serials.length === 0) {
    return (
      <Empty>
        <EmptyMedia variant="icon">{emptyIcon}</EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>{emptyTitle}</EmptyTitle>
          <EmptyDescription>{emptyDesc}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <ScrollArea className="h-[280px] rounded-md border">
      <div className="p-2 space-y-1">
        {serials.map((s) => (
          <div
            key={s}
            className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 font-mono text-sm"
          >
            <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            {s}
            <span className="text-muted-foreground text-xs">(not in inventory)</span>
          </div>
        ))}
      </div>
    </ScrollArea>
  )
}
