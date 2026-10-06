"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { StatusPill } from "@/components/fs/status-pill"
import { Button } from "@/components/ui/button"
import { MessageSquare, Clock, ChevronRight } from "lucide-react"
import { getSupabaseClient } from "@/lib/supabase/client"
import {
  fetchLatestOpenRequests,
  type StockRequestWithRelations,
} from "@/lib/supabase/stock-requests-db"
import { formatDateDDMMYYYY } from "@/lib/utils"
import { formatClientLabel } from "@/lib/client-label"
import { todayBusinessDate } from "@/lib/business-date.mjs"
import { useOrgTimezone } from "@/hooks/use-org-timezone"
import { ageInDays, formatAgeDays } from "@/lib/format-display"

const PREVIEW_COUNT = 6

export function LatestRequests() {
  const timeZone = useOrgTimezone()
  const today = todayBusinessDate(timeZone)
  const [latest, setLatest] = useState<StockRequestWithRelations[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function run() {
      try {
        const sb = getSupabaseClient()
        const data = await fetchLatestOpenRequests(sb, PREVIEW_COUNT)
        if (!cancelled) setLatest(data)
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
  }, [])

  return (
    <Card className="flex h-full min-h-[300px] flex-col sm:min-h-[340px]">
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="text-base font-semibold text-foreground">Latest requests</CardTitle>
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
            {latest.map((req, i) => {
              const lineCount = (req.stock_request_lines ?? []).length
              const title = req.client
                ? formatClientLabel(req.client)
                : lineCount
                  ? `${lineCount} line request`
                  : "Stock request"
              const subtitleParts: string[] = []
              if (lineCount > 0) {
                const first = req.stock_request_lines?.[0]?.product_name
                subtitleParts.push(first ? `${first}${lineCount > 1 ? ` +${lineCount - 1}` : ""}` : `${lineCount} lines`)
              }
              const subtitle = subtitleParts.join(" · ") || req.status
              const days = ageInDays(req.created_at, today)
              const fullDate = formatDateDDMMYYYY(req.created_at)

              return (
                <div
                  key={req.id}
                  className={
                    i !== Math.min(PREVIEW_COUNT - 1, latest.length - 1)
                      ? "flex items-center gap-3 border-b border-border py-3"
                      : "flex items-center gap-3 py-3"
                  }
                >
                  <Link
                    href={`/requests/${req.id}`}
                    className="group flex min-w-0 flex-1 items-center gap-3"
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand/15 transition-colors group-hover:bg-brand/20">
                      <MessageSquare className="h-4 w-4 text-brand" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{title}</p>
                      <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <StatusPill value={req.status} />
                      <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
                        <Clock className="size-3 shrink-0 opacity-80" aria-hidden />
                        <span title={fullDate}>{days == null ? fullDate : formatAgeDays(days)}</span>
                      </div>
                    </div>
                  </Link>
                </div>
              )
            })}
            {latest.length < PREVIEW_COUNT ? (
              <p className="mt-auto pt-3 text-xs text-muted-foreground">No other open requests</p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  )
}
