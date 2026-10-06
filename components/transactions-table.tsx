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
import { Button } from "@/components/ui/button"
import { StatusPill } from "@/components/fs/status-pill"
import { EmptyState } from "@/components/fs/empty-state"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useAuth } from "@/lib/auth-context"
import { canViewFinancials } from "@/lib/permissions"
import {
  fetchTransactionBatchPage,
  type TransactionBatchSummary,
} from "@/lib/transaction-batches"
import { BusinessDateLabel } from "@/components/business-date-label"
import { useOrgTimezone } from "@/hooks/use-org-timezone"
import { FileText, Loader2 } from "lucide-react"
import { toastFromApiErrorBody, toastFromCaughtError } from "@/lib/toast-reportable-error"
import { SESSION_EXPIRED_MESSAGE } from "@/lib/unauthorized"
import { SignedStorageLink } from "@/components/signed-storage-link"
import { formatCount } from "@/lib/format-display"

const RECENT_BATCH_LIMIT = 10

export function TransactionsTable() {
  const timeZone = useOrgTimezone()
  const [batches, setBatches] = useState<TransactionBatchSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const { role } = useAuth()
  const showFinancials = canViewFinancials(role)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const page = await fetchTransactionBatchPage({ limit: RECENT_BATCH_LIMIT, offset: 0, active: true })
        if (cancelled) return
        setLoadError(null)
        setBatches(page.batches)
      } catch (e) {
        if (cancelled) return
        const status = typeof e === "object" && e && "status" in e ? Number(e.status) : 500
        const body = typeof e === "object" && e && "body" in e ? e.body : {}
        if (typeof e === "object" && e && "body" in e) {
          toastFromApiErrorBody(body, "Failed to load recent transactions", status)
        } else {
          toastFromCaughtError(e, "Failed to load recent transactions")
        }
        setLoadError(
          status === 401 ? SESSION_EXPIRED_MESSAGE : "Could not load recent transactions."
        )
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
        <Button variant="link" asChild className="h-auto p-0 text-sm text-brand shrink-0">
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
          <EmptyState message="No transactions yet." />
        ) : (
          <Table className="min-w-[560px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="hidden lg:table-cell">Date</TableHead>
                <TableHead>Movement</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="hidden md:table-cell">Client</TableHead>
                <TableHead className="text-right">Items</TableHead>
                {showFinancials && (
                  <TableHead className="hidden lg:table-cell min-w-[9.5rem]">Invoice</TableHead>
                )}
                <TableHead className="hidden xl:table-cell w-24">Delivery note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recent.map((entry) => (
                <TableRow key={entry.batchKey}>
                  <TableCell className="text-sm text-muted-foreground hidden lg:table-cell whitespace-nowrap">
                    <BusinessDateLabel date={entry.date} createdAt={entry.recordedAt} timeZone={timeZone} />
                  </TableCell>
                  <TableCell>
                    <StatusPill value={entry.movementType ?? ""} />
                  </TableCell>
                  <TableCell className="text-sm text-foreground max-w-[140px] truncate" title={entry.productLabel}>
                    {entry.productLabel}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground hidden md:table-cell max-w-[160px] truncate" title={entry.clientDisplay}>
                    {entry.clientDisplay}
                  </TableCell>
                  <TableCell className="text-right text-sm tabular-nums text-foreground">
                    {formatCount(entry.count)} item{entry.count !== 1 ? "s" : ""}
                  </TableCell>
                  {showFinancials && (
                    <TableCell className="text-xs text-muted-foreground hidden lg:table-cell whitespace-nowrap">
                      {entry.invoiceNumber || "\u2014"}
                    </TableCell>
                  )}
                  <TableCell className="hidden xl:table-cell">
                    {entry.deliveryNoteUrl ? (
                      <SignedStorageLink
                        path={entry.deliveryNoteUrl}
                        className="inline-flex items-center gap-1 text-xs text-brand hover:underline"
                      >
                        <FileText className="w-3.5 h-3.5 shrink-0" />
                        View
                      </SignedStorageLink>
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
