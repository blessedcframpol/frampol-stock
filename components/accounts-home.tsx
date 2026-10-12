"use client"

import Link from "next/link"
import { useEffect, useMemo, useState } from "react"
import { Truck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useOrgTimezone } from "@/hooks/use-org-timezone"
import { useRequestDisplayStatuses } from "@/hooks/use-request-display-statuses"
import { todayBusinessDate } from "@/lib/business-date.mjs"
import { formatClientLabel } from "@/lib/client-label"
import { ageInDays, formatAgeDays } from "@/lib/format-display"
import { requestIsAllFortinet } from "@/lib/issue-scan-feedback"
import { loadProfileLabels } from "@/lib/profile-labels"
import { getSupabaseClient } from "@/lib/supabase/client"
import {
  fetchLatestOpenRequests,
  type StockRequestWithRelations,
} from "@/lib/supabase/stock-requests-db"
import { requestItemsSummary } from "@/lib/stock-request-statuses"

const OPEN_REQUEST_LIMIT = 200

function clientOf(r: StockRequestWithRelations): string {
  return r.client ? formatClientLabel(r.client) : r.client_id
}

/**
 * Accounts home, shown above the invoice tabs: invoices waiting on a number (by requester),
 * Fortinet requests accounts can issue, and the not-invoiced report.
 */
export function AccountsHome({ onShowNotInvoiced }: { onShowNotInvoiced?: () => void }) {
  const timeZone = useOrgTimezone()
  const today = todayBusinessDate(timeZone)
  const [open, setOpen] = useState<StockRequestWithRelations[] | null>(null)
  const [names, setNames] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const sb = getSupabaseClient()
        const rows = await fetchLatestOpenRequests(sb, OPEN_REQUEST_LIMIT)
        if (cancelled) return
        setOpen(rows)
        const labels = await loadProfileLabels(
          sb,
          rows.map((r) => r.created_by)
        )
        if (!cancelled) setNames(labels)
      } catch {
        if (!cancelled) setOpen([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const displayStatuses = useRequestDisplayStatuses(open ?? [])

  const pendingByRequester = useMemo(() => {
    const groups = new Map<string, StockRequestWithRelations[]>()
    for (const r of open ?? []) {
      if (r.invoice_status !== "pending") continue
      const list = groups.get(r.created_by) ?? []
      list.push(r)
      groups.set(r.created_by, list)
    }
    return [...groups.entries()]
      .map(([id, rows]) => ({
        id,
        rows: [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at)),
      }))
      .sort((a, b) => b.rows.length - a.rows.length)
  }, [open])
  const pendingTotal = pendingByRequester.reduce((n, g) => n + g.rows.length, 0)

  const fortinetToIssue = useMemo(
    () =>
      (open ?? [])
        .filter((r) => {
          const s = displayStatuses[r.id]
          return (
            (s === "being_reviewed" || s === "partially_issued") &&
            requestIsAllFortinet(r.stock_request_lines ?? [])
          )
        })
        .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [open, displayStatuses]
  )

  return (
    <div className="grid grid-cols-1 gap-3 md:gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">
            Stock requests waiting for an invoice number ({pendingTotal})
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {open === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : pendingByRequester.length === 0 ? (
            <p className="text-sm text-muted-foreground">No requests are waiting for an invoice number.</p>
          ) : (
            pendingByRequester.map((g) => (
              <div key={g.id} className="flex flex-col gap-1">
                <p className="text-sm font-medium text-foreground">
                  {names.get(g.id) ?? `User ${g.id.slice(0, 8)}`}{" "}
                  <span className="font-normal text-muted-foreground">
                    · {g.rows.length} request{g.rows.length !== 1 ? "s" : ""}
                  </span>
                </p>
                <ul className="flex flex-col gap-1 text-sm">
                  {g.rows.map((r) => {
                    const days = ageInDays(r.created_at, today)
                    return (
                      <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <Link href={`/requests/${r.id}`} className="min-w-0 text-brand hover:underline">
                          {r.request_number} · {clientOf(r)}
                        </Link>
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                          {days == null ? "—" : `Waiting ${formatAgeDays(days)}`}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3 md:gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Fortinet to issue ({fortinetToIssue.length})</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {open === null ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : fortinetToIssue.length === 0 ? (
              <p className="text-sm text-muted-foreground">No Fortinet requests are waiting to be issued.</p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {fortinetToIssue.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {r.request_number} · {clientOf(r)}
                      </p>
                      <p className="line-clamp-1 text-xs text-muted-foreground">
                        {requestItemsSummary(r.stock_request_lines ?? [])}
                      </p>
                    </div>
                    <Button asChild size="sm" className="min-h-11 shrink-0 gap-1 sm:min-h-9">
                      <Link href={`/requests/${r.id}/fulfill`}>
                        <Truck className="size-3.5" />
                        Issue
                      </Link>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <Link href="/requests" className="text-sm text-brand hover:underline">
              View all requests
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Not invoiced report</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-muted-foreground">Approved 00000 sales and their reasons.</span>
            <Link
              href="/invoices?tab=not_invoiced"
              className="text-brand hover:underline"
              onClick={() => onShowNotInvoiced?.()}
            >
              Open report
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
