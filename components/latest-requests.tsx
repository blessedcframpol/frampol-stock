"use client"

import Link from "next/link"
import { useEffect, useMemo, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { RequestStatusPill } from "@/components/request-status-pill"
import { Button } from "@/components/ui/button"
import { MessageSquare, Clock, ChevronRight, Truck } from "lucide-react"
import { getSupabaseClient } from "@/lib/supabase/client"
import {
  fetchLatestOpenRequests,
  fetchProfileLabels,
  type StockRequestWithRelations,
} from "@/lib/supabase/stock-requests-db"
import { formatDateDDMMYYYY } from "@/lib/utils"
import { formatClientLabel } from "@/lib/client-label"
import { todayBusinessDate } from "@/lib/business-date.mjs"
import { useOrgTimezone } from "@/hooks/use-org-timezone"
import { ageInDays, formatAgeDays } from "@/lib/format-display"
import { useRequestDisplayStatuses } from "@/hooks/use-request-display-statuses"
import { displayStatusLabel, requestItemsSummary } from "@/lib/stock-request-statuses"
import { useAuth } from "@/lib/auth-context"
import { useEffectiveRole } from "@/lib/dev-role-preview"
import { ADMIN } from "@/lib/permissions"
import { requestIsAllFortinet } from "@/lib/issue-scan-feedback"

const PREVIEW_COUNT = 6

export function LatestRequests() {
  const { user } = useAuth()
  const role = useEffectiveRole()
  const isAdmin = role === ADMIN
  const timeZone = useOrgTimezone()
  const today = todayBusinessDate(timeZone)
  const [latest, setLatest] = useState<StockRequestWithRelations[]>([])
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function run() {
      try {
        const sb = getSupabaseClient()
        // Pull enough open rows so admin "To issue" can sort oldest-first after status resolve.
        const data = await fetchLatestOpenRequests(sb, isAdmin ? 40 : PREVIEW_COUNT)
        if (!cancelled) setLatest(data)
        if (isAdmin && data.length) {
          const labels = await fetchProfileLabels(
            sb,
            data.map((r) => r.created_by)
          )
          if (!cancelled) setNames(labels)
        }
      } catch {
        if (!cancelled) setLatest([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [isAdmin])

  const displayStatuses = useRequestDisplayStatuses(latest)

  const adminToIssue = useMemo(() => {
    if (!isAdmin) return []
    return [...latest]
      .filter((r) => {
        const s = displayStatuses[r.id]
        return s === "being_reviewed" || s === "partially_issued"
      })
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(0, PREVIEW_COUNT)
  }, [isAdmin, latest, displayStatuses])

  const rows = isAdmin ? adminToIssue : latest.slice(0, PREVIEW_COUNT)

  function requesterName(id: string): string {
    if (id === user?.id) return "You"
    return names.get(id) ?? `User ${id.slice(0, 8)}`
  }

  return (
    <Card className="flex h-full min-h-[300px] flex-col sm:min-h-[340px]">
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="text-base font-semibold text-foreground">
          {isAdmin ? "To issue" : "Latest requests"}
        </CardTitle>
        <Button variant="ghost" size="sm" className="h-8 shrink-0 gap-0.5 text-xs text-muted-foreground hover:text-foreground" asChild>
          <Link href="/requests">
            View all
            <ChevronRight className="size-3.5" />
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-0 overflow-auto pt-0">
        {loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            {rows.map((req, i) => {
              const lineCount = (req.stock_request_lines ?? []).length
              const title = req.client
                ? formatClientLabel(req.client)
                : lineCount
                  ? `${lineCount} line request`
                  : "Stock request"
              const displayStatus = displayStatuses[req.id]
              const days = ageInDays(req.created_at, today)
              const fullDate = formatDateDDMMYYYY(req.created_at)
              const fortinet = requestIsAllFortinet(req.stock_request_lines ?? [])
              const subtitle = isAdmin
                ? [
                    req.type,
                    requesterName(req.created_by),
                    requestItemsSummary(req.stock_request_lines ?? []),
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : (() => {
                    const subtitleParts: string[] = []
                    if (lineCount > 0) {
                      const first = req.stock_request_lines?.[0]?.product_name
                      subtitleParts.push(
                        first ? `${first}${lineCount > 1 ? ` +${lineCount - 1}` : ""}` : `${lineCount} lines`
                      )
                    }
                    return subtitleParts.join(" · ") || displayStatusLabel(displayStatus)
                  })()

              return (
                <div
                  key={req.id}
                  className={
                    i !== Math.min(PREVIEW_COUNT - 1, rows.length - 1)
                      ? "flex items-center gap-3 border-b border-border py-3"
                      : "flex items-center gap-3 py-3"
                  }
                >
                  <Link
                    href={isAdmin ? `/requests/${req.id}/fulfill` : `/requests/${req.id}`}
                    className="group flex min-w-0 flex-1 items-center gap-3"
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand/15 transition-colors group-hover:bg-brand/20">
                      {isAdmin ? (
                        <Truck className="h-4 w-4 text-brand" />
                      ) : (
                        <MessageSquare className="h-4 w-4 text-brand" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {req.request_number} · {title}
                        {fortinet && isAdmin ? (
                          <span className="ml-1.5 rounded border border-border bg-muted/40 px-1 py-0.5 text-[10px] font-medium text-muted-foreground">
                            Fortinet
                          </span>
                        ) : null}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <RequestStatusPill status={displayStatus} />
                      <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
                        <Clock className="size-3 shrink-0 opacity-80" aria-hidden />
                        <span title={fullDate}>{days == null ? fullDate : formatAgeDays(days)}</span>
                      </div>
                    </div>
                  </Link>
                </div>
              )
            })}
            {rows.length === 0 ? (
              <p className="mt-auto pt-3 text-xs text-muted-foreground">
                {isAdmin ? "Nothing waiting to issue" : "No other open requests"}
              </p>
            ) : rows.length < PREVIEW_COUNT && !isAdmin ? (
              <p className="mt-auto pt-3 text-xs text-muted-foreground">No other open requests</p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  )
}
