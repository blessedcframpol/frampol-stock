"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
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
import { StatusPill } from "@/components/fs/status-pill"
import { EmptyState } from "@/components/fs/empty-state"
import { CheckCircle2, AlertTriangle, Loader2, Copy, Download } from "lucide-react"
import { PageHeader } from "@/components/page-nav"
import { PageBreadcrumbs } from "@/components/page-breadcrumbs"
import type { StockTakeRecord, StockTakeSnapshotItem } from "@/lib/data"
import { buildStockTakeScopeLabel } from "@/lib/stock-take"
import { formatDateDDMMYYYY } from "@/lib/utils"
import { toast } from "sonner"
import { toastFromApiErrorBody, toastFromCaughtError } from "@/lib/toast-reportable-error"
import { SESSION_EXPIRED_MESSAGE } from "@/lib/unauthorized"
import { buildCsvFilename } from "@/lib/utils"

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

function exportStockTakeSectionCsv(
  section: "matched" | "notInSystem" | "notScanned" | "outOfScope",
  matched: StockTakeSnapshotItem[],
  notInSystem: string[],
  notScanned: StockTakeSnapshotItem[],
  outOfScope: StockTakeSnapshotItem[],
  completedAtIso: string
) {
  const rows: string[][] = []
  if (section === "matched") {
    rows.push(["Serial", "Name", "Status", "Location"])
    for (const item of matched) rows.push([item.serialNumber, item.name, item.status, item.location])
  } else if (section === "notInSystem") {
    rows.push(["Serial", "Result"])
    for (const serial of notInSystem) rows.push([serial, "Not in system"])
  } else if (section === "outOfScope") {
    rows.push(["Serial", "Name", "Status", "Location"])
    for (const item of outOfScope) rows.push([item.serialNumber, item.name, item.status, item.location])
  } else {
    rows.push(["Serial", "Name", "Status", "Location"])
    for (const item of notScanned) rows.push([item.serialNumber, item.name, item.status, item.location])
  }
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n")
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  const sectionLabel =
    section === "matched"
      ? "matched"
      : section === "notInSystem"
        ? "not in system"
        : section === "outOfScope"
          ? "out of scope"
          : "not scanned"
  a.download = buildCsvFilename(["Stock take history", sectionLabel], completedAtIso)
  a.click()
  URL.revokeObjectURL(url)
}

export function StockTakeHistoryDetailContent({ id }: { id: string }) {
  const [record, setRecord] = useState<StockTakeRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(`/api/stock-takes/${id}`)
        const data = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) {
          if (res.status === 404) {
            setLoadError(null)
            setRecord(null)
            return
          }
          toastFromApiErrorBody(data, "Failed to load stock take", res.status)
          setLoadError(
            res.status === 401 ? SESSION_EXPIRED_MESSAGE : "Could not load this stock take."
          )
          return
        }
        const loaded =
          data && typeof data === "object" && "id" in data ? (data as StockTakeRecord) : null
        setLoadError(null)
        setRecord(loaded)
      } catch (e) {
        if (!cancelled) {
          toastFromCaughtError(e, "Failed to load stock take")
          setLoadError("Could not load this stock take.")
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [id])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="size-6 animate-spin mr-2" />
        Loading…
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="flex flex-col gap-4">
        <PageBreadcrumbs
          items={[
            { label: "Inventory", href: "/inventory" },
            { label: "Stock take", href: "/inventory/stock-take" },
            { label: "History", href: "/inventory/stock-take/history" },
            { label: "Stock take" },
          ]}
        />
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
      </div>
    )
  }

  if (!record) {
    return (
      <div className="flex flex-col gap-4">
        <PageBreadcrumbs
          items={[
            { label: "Inventory", href: "/inventory" },
            { label: "Stock take", href: "/inventory/stock-take" },
            { label: "History", href: "/inventory/stock-take/history" },
            { label: "Stock take" },
          ]}
        />
        <p className="text-muted-foreground">Stock take not found.</p>
      </div>
    )
  }

  const s = record.resultSnapshot
  const stockTakeCompletedAt = record.completedAt
  const scopeLabel = s.scope ? buildStockTakeScopeLabel(s.scope) : "Full warehouse (In Stock)"
  const outOfScope = s.outOfScope ?? []

  async function handleCopySection(section: "matched" | "notInSystem" | "notScanned" | "outOfScope") {
    const serials =
      section === "matched"
        ? s.matched.map((i) => i.serialNumber)
        : section === "notInSystem"
          ? s.notInSystem
          : section === "outOfScope"
            ? outOfScope.map((i) => i.serialNumber)
            : s.notScanned.map((i) => i.serialNumber)
    await copySerialLinesToClipboard(serials, `Copied ${serials.length} serial(s)`)
  }

  function handleExportSection(section: "matched" | "notInSystem" | "notScanned" | "outOfScope") {
    exportStockTakeSectionCsv(section, s.matched, s.notInSystem, s.notScanned, outOfScope, stockTakeCompletedAt)
    toast.success("Section CSV downloaded")
  }

  return (
    <div className="flex flex-col gap-4 md:gap-6 min-w-0">
      <PageHeader
        title="Stock take"
        description={`${scopeLabel} · ${formatDateDDMMYYYY(record.completedAt.slice(0, 10))} at ${record.completedAt.slice(11, 16)} — read-only`}
      />
      <PageBreadcrumbs
        items={[
          { label: "Inventory", href: "/inventory" },
          { label: "Stock take", href: "/inventory/stock-take" },
          { label: "History", href: "/inventory/stock-take/history" },
          { label: formatDateDDMMYYYY(record.completedAt.slice(0, 10)) },
        ]}
      />

      {s.expectedCount != null && (
        <p className="text-sm text-muted-foreground -mt-2">
          Expected {s.expectedCount} item{s.expectedCount !== 1 ? "s" : ""} in scope
        </p>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold text-foreground">Results</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="matched" className="w-full">
            <TabsList className="grid w-full grid-cols-2 sm:grid-cols-4 h-auto">
              <TabsTrigger value="matched" className="text-xs sm:text-sm">
                Matched ({s.matched.length})
              </TabsTrigger>
              <TabsTrigger value="notInSystem" className="text-xs sm:text-sm">
                Not in system ({s.notInSystem.length})
              </TabsTrigger>
              <TabsTrigger value="notScanned" className="text-xs sm:text-sm">
                Not scanned ({s.notScanned.length})
              </TabsTrigger>
              <TabsTrigger value="outOfScope" className="text-xs sm:text-sm">
                Out of scope ({outOfScope.length})
              </TabsTrigger>
            </TabsList>
            <TabsContent value="matched" className="mt-3">
              <div className="mb-2 flex items-center justify-end gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => void handleCopySection("matched")}>
                  <Copy className="size-4 mr-1" />
                  Copy serials
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => handleExportSection("matched")}>
                  <Download className="size-4 mr-1" />
                  Export section
                </Button>
              </div>
              <SnapshotResultTable
                items={s.matched}
                emptyIcon={<CheckCircle2 className="size-6" />}
                emptyTitle="No matches"
                emptyDesc="No scanned serials were in inventory at this time."
              />
            </TabsContent>
            <TabsContent value="notInSystem" className="mt-3">
              <div className="mb-2 flex items-center justify-end gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => void handleCopySection("notInSystem")}>
                  <Copy className="size-4 mr-1" />
                  Copy serials
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => handleExportSection("notInSystem")}>
                  <Download className="size-4 mr-1" />
                  Export section
                </Button>
              </div>
              <NotInSystemList
                serials={s.notInSystem}
                emptyIcon={<AlertTriangle className="size-6" />}
                emptyTitle="None"
                emptyDesc="All scanned serials were in the system."
              />
            </TabsContent>
            <TabsContent value="notScanned" className="mt-3">
              <div className="mb-2 flex items-center justify-end gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => void handleCopySection("notScanned")}>
                  <Copy className="size-4 mr-1" />
                  Copy serials
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => handleExportSection("notScanned")}>
                  <Download className="size-4 mr-1" />
                  Export section
                </Button>
              </div>
              <SnapshotResultTable
                items={s.notScanned}
                emptyIcon={<AlertTriangle className="size-6" />}
                emptyTitle="None missing"
                emptyDesc="Every in-scope inventory item was scanned."
              />
            </TabsContent>
            <TabsContent value="outOfScope" className="mt-3">
              <div className="mb-2 flex items-center justify-end gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => void handleCopySection("outOfScope")}>
                  <Copy className="size-4 mr-1" />
                  Copy serials
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => handleExportSection("outOfScope")}>
                  <Download className="size-4 mr-1" />
                  Export section
                </Button>
              </div>
              <SnapshotResultTable
                items={outOfScope}
                emptyIcon={<CheckCircle2 className="size-6" />}
                emptyTitle="None"
                emptyDesc="All scanned serials were within this stock take scope."
              />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  )
}

function SnapshotResultTable({
  items,
  emptyIcon,
  emptyTitle,
  emptyDesc,
}: {
  items: StockTakeSnapshotItem[]
  emptyIcon: React.ReactNode
  emptyTitle: string
  emptyDesc: string
}) {
  if (items.length === 0) {
    return <EmptyState icon={emptyIcon} message={`${emptyTitle}. ${emptyDesc}`} />
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
          {items.map((item, i) => (
            <TableRow key={`${item.serialNumber}-${i}`}>
              <TableCell className="font-mono text-sm">{item.serialNumber}</TableCell>
              <TableCell>{item.name}</TableCell>
              <TableCell>
                <StatusPill value={item.status} />
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
    return <EmptyState icon={emptyIcon} message={`${emptyTitle}. ${emptyDesc}`} />
  }
  return (
    <ScrollArea className="h-[280px] rounded-md border">
      <div className="p-2 space-y-1">
        {serials.map((serial, i) => (
          <div
            key={`${serial}-${i}`}
            className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 font-mono text-sm"
          >
            <AlertTriangle className="size-4 shrink-0 text-warning" />
            {serial}
            <span className="text-muted-foreground text-xs">(not in inventory)</span>
          </div>
        ))}
      </div>
    </ScrollArea>
  )
}
