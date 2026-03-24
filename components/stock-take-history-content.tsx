"use client"

import { useState, useEffect, useCallback } from "react"
import Link from "next/link"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { History, Loader2, ChevronRight, ClipboardList } from "lucide-react"
import type { StockTakeRecord } from "@/lib/data"
import { formatDateDDMMYYYY } from "@/lib/utils"
import { toast } from "sonner"
import { toastFromApiErrorBody, toastFromCaughtError } from "@/lib/toast-reportable-error"

export function StockTakeHistoryContent() {
  const [list, setList] = useState<StockTakeRecord[]>([])
  const [loading, setLoading] = useState(true)

  const fetchList = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/stock-takes")
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toastFromApiErrorBody(data, "Failed to load stock take history")
        setList([])
        return
      }
      setList(Array.isArray(data) ? data : [])
    } catch (e) {
      toastFromCaughtError(e, "Failed to load stock take history")
      setList([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchList()
  }, [fetchList])

  return (
    <div className="flex flex-col gap-4 md:gap-6 min-w-0 p-4 md:p-6">
      <div>
        <h1 className="text-xl md:text-2xl font-bold text-foreground tracking-tight text-balance">Stock take history</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Read-only list of completed stock takes. Open one to see how it went.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold text-foreground flex items-center gap-2">
            <History className="w-4 h-4 text-primary" />
            Completed stock takes
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="size-6 animate-spin mr-2" />
              Loading…
            </div>
          ) : list.length === 0 ? (
            <Empty>
              <EmptyMedia variant="icon">
                <ClipboardList className="size-6" />
              </EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>No stock takes yet</EmptyTitle>
                <EmptyDescription>
                  Complete a stock take and click &quot;Save to history&quot; to see it here.
                </EmptyDescription>
              </EmptyHeader>
              <Link href="/inventory/stock-take">
                <Button variant="outline">Go to Stock take</Button>
              </Link>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Scanned</TableHead>
                  <TableHead className="text-right">Matched</TableHead>
                  <TableHead className="text-right">Not in system</TableHead>
                  <TableHead className="text-right">Not scanned</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((record) => {
                  const s = record.resultSnapshot
                  return (
                    <TableRow key={record.id}>
                      <TableCell className="font-medium">
                        {formatDateDDMMYYYY(record.completedAt.slice(0, 10))}
                        <span className="text-muted-foreground text-xs ml-1">
                          {record.completedAt.slice(11, 16)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">{s.scannedSerials.length}</TableCell>
                      <TableCell className="text-right">{s.matched.length}</TableCell>
                      <TableCell className="text-right">{s.notInSystem.length}</TableCell>
                      <TableCell className="text-right">{s.notScanned.length}</TableCell>
                      <TableCell>
                        <Link href={`/inventory/stock-take/history/${record.id}`}>
                          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="View">
                            <ChevronRight className="size-4" />
                          </Button>
                        </Link>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
