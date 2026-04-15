"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
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
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { ArrowLeft, CheckCircle2, AlertTriangle, Loader2 } from "lucide-react"
import type { StockTakeRecord, StockTakeSnapshotItem } from "@/lib/data"
import { formatDateDDMMYYYY } from "@/lib/utils"
import { toast } from "sonner"
import { toastFromApiErrorBody, toastFromCaughtError } from "@/lib/toast-reportable-error"
import { cn } from "@/lib/utils"

const statusStyles: Record<string, string> = {
  "In Stock": "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  Sold: "bg-red-500/10 text-red-500 dark:text-red-400",
  POC: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  Rented: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  Maintenance: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  "RMA Hold": "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  Disposed: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
}

export function StockTakeHistoryDetailContent({ id }: { id: string }) {
  const [record, setRecord] = useState<StockTakeRecord | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(`/api/stock-takes/${id}`)
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          if (res.status === 404) setRecord(null)
          else if (!cancelled) toastFromApiErrorBody(data, "Failed to load stock take")
          return
        }
        if (!cancelled) setRecord(data as StockTakeRecord)
      } catch (e) {
        if (!cancelled) toastFromCaughtError(e, "Failed to load stock take")
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [id])

  if (loading) {
    return (
      <div className="flex flex-col gap-6 p-4 md:p-6">
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="size-6 animate-spin mr-2" />
          Loading…
        </div>
      </div>
    )
  }

  if (!record) {
    return (
      <div className="flex flex-col gap-6 p-4 md:p-6">
        <p className="text-muted-foreground">Stock take not found.</p>
        <Link href="/inventory/stock-take/history">
          <Button variant="outline">Back to history</Button>
        </Link>
      </div>
    )
  }

  const s = record.resultSnapshot

  return (
    <div className="flex flex-col gap-4 md:gap-6 min-w-0 p-4 md:p-6">
      <div className="flex items-center gap-2">
        <Link href="/inventory/stock-take/history">
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Back to history">
            <ArrowLeft className="size-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-foreground tracking-tight">Stock take</h1>
          <p className="text-sm text-muted-foreground">
            {formatDateDDMMYYYY(record.completedAt.slice(0, 10))} at {record.completedAt.slice(11, 16)} — read-only
          </p>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold text-foreground">Results</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="matched" className="w-full">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="matched" className="text-xs sm:text-sm">
                Matched ({s.matched.length})
              </TabsTrigger>
              <TabsTrigger value="notInSystem" className="text-xs sm:text-sm">
                Not in system ({s.notInSystem.length})
              </TabsTrigger>
              <TabsTrigger value="notScanned" className="text-xs sm:text-sm">
                Not scanned ({s.notScanned.length})
              </TabsTrigger>
            </TabsList>
            <TabsContent value="matched" className="mt-3">
              <SnapshotResultTable
                items={s.matched}
                emptyIcon={<CheckCircle2 className="size-6" />}
                emptyTitle="No matches"
                emptyDesc="No scanned serials were in inventory at this time."
                statusStyles={statusStyles}
              />
            </TabsContent>
            <TabsContent value="notInSystem" className="mt-3">
              <NotInSystemList
                serials={s.notInSystem}
                emptyIcon={<AlertTriangle className="size-6" />}
                emptyTitle="None"
                emptyDesc="All scanned serials were in the system."
              />
            </TabsContent>
            <TabsContent value="notScanned" className="mt-3">
              <SnapshotResultTable
                items={s.notScanned}
                emptyIcon={<AlertTriangle className="size-6" />}
                emptyTitle="None missing"
                emptyDesc="Every inventory item was scanned."
                statusStyles={statusStyles}
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
  statusStyles,
}: {
  items: StockTakeSnapshotItem[]
  emptyIcon: React.ReactNode
  emptyTitle: string
  emptyDesc: string
  statusStyles: Record<string, string>
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
          {items.map((item, i) => (
            <TableRow key={`${item.serialNumber}-${i}`}>
              <TableCell className="font-mono text-sm">{item.serialNumber}</TableCell>
              <TableCell>{item.name}</TableCell>
              <TableCell>
                <span className={cn("text-xs rounded-md px-2 py-0.5", statusStyles[item.status] ?? "bg-muted text-muted-foreground")}>
                  {item.status}
                </span>
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
        {serials.map((serial, i) => (
          <div
            key={`${serial}-${i}`}
            className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 font-mono text-sm"
          >
            <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            {serial}
            <span className="text-muted-foreground text-xs">(not in inventory)</span>
          </div>
        ))}
      </div>
    </ScrollArea>
  )
}
