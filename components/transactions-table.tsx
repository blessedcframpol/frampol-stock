"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useAuth } from "@/lib/auth-context"
import { canViewFinancials } from "@/lib/permissions"
import type { TransactionBatchSummary } from "@/lib/transaction-batches"
import { cn, formatDateDDMMYYYY } from "@/lib/utils"
import { FileText, Loader2 } from "lucide-react"
import { toastFromApiErrorBody, toastFromCaughtError } from "@/lib/toast-reportable-error"
import { SESSION_EXPIRED_MESSAGE } from "@/lib/unauthorized"

const RECENT_BATCH_LIMIT = 10

const statusStyles: Record<string, string> = {
  Inbound: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  Sale: "bg-red-500/10 text-red-500 dark:text-red-400",
  "POC Out": "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  "POC Return": "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  Rentals: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  "Rental Return": "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  Transfer: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  Dispose: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
  Reversal: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
}

export function TransactionsTable() {
  const [batches, setBatches] = useState<TransactionBatchSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const { role } = useAuth()
  const showFinancials = canViewFinancials(role)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch("/api/transaction-batches")
        if (cancelled) return
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          toastFromApiErrorBody(data, "Failed to load recent transactions", res.status)
          setLoadError(
            res.status === 401 ? SESSION_EXPIRED_MESSAGE : "Could not load recent transactions."
          )
          return
        }
        const data = await res.json().catch(() => null)
        if (cancelled) return
        if (!Array.isArray(data)) {
          toastFromApiErrorBody(data, "Failed to load recent transactions", res.status)
          setLoadError("Could not load recent transactions.")
          return
        }
        setLoadError(null)
        setBatches(data as TransactionBatchSummary[])
      } catch (e) {
        if (!cancelled) {
          toastFromCaughtError(e, "Failed to load recent transactions")
          setLoadError("Could not load recent transactions.")
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const recent = batches.slice(0, RECENT_BATCH_LIMIT)

  return (
    <Card className="h-full min-h-[300px] sm:min-h-[340px] flex flex-col">
      <CardHeader className="pb-3 flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base font-semibold text-foreground">Recent transactions</CardTitle>
        <Button variant="link" asChild className="h-auto p-0 text-sm text-primary shrink-0">
          <Link href="/transaction-history">View transaction history</Link>
        </Button>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 overflow-auto overflow-x-auto">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="w-8 h-8 animate-spin" />
          </div>
        ) : loadError ? (
          <p role="alert" className="text-sm text-destructive py-8 text-center">
            {loadError}
          </p>
        ) : recent.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">No transactions yet.</p>
        ) : (
          <Table className="min-w-[560px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-xs text-muted-foreground font-medium hidden lg:table-cell">Date</TableHead>
                <TableHead className="text-xs text-muted-foreground font-medium">Movement</TableHead>
                <TableHead className="text-xs text-muted-foreground font-medium">Product</TableHead>
                <TableHead className="text-xs text-muted-foreground font-medium hidden md:table-cell">Client</TableHead>
                <TableHead className="text-xs text-muted-foreground font-medium">Items</TableHead>
                {showFinancials && (
                  <TableHead className="text-xs text-muted-foreground font-medium hidden lg:table-cell">Invoice</TableHead>
                )}
                <TableHead className="text-xs text-muted-foreground font-medium hidden xl:table-cell w-24">Delivery note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recent.map((entry) => (
                <TableRow key={entry.batchKey}>
                  <TableCell className="text-sm text-muted-foreground hidden lg:table-cell whitespace-nowrap">
                    {formatDateDDMMYYYY(entry.date)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="secondary"
                      className={cn("text-[10px] font-medium border-0", statusStyles[entry.movementType] ?? "")}
                    >
                      {entry.movementType}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-foreground max-w-[140px] truncate" title={entry.productLabel}>
                    {entry.productLabel}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground hidden md:table-cell max-w-[160px] truncate" title={entry.clientDisplay}>
                    {entry.clientDisplay}
                  </TableCell>
                  <TableCell className="text-sm text-foreground tabular-nums">
                    {entry.count} item{entry.count !== 1 ? "s" : ""}
                  </TableCell>
                  {showFinancials && (
                    <TableCell className="font-mono text-xs text-muted-foreground hidden lg:table-cell">
                      {entry.invoiceNumber || "\u2014"}
                    </TableCell>
                  )}
                  <TableCell className="hidden xl:table-cell">
                    {entry.deliveryNoteUrl ? (
                      <a
                        href={entry.deliveryNoteUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        <FileText className="w-3.5 h-3.5 shrink-0" />
                        View
                      </a>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
