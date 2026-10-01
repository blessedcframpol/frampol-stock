"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { StatusPill } from "@/components/fs/status-pill"
import { EmptyState } from "@/components/fs/empty-state"
import { Button } from "@/components/ui/button"
import { MessageSquare, Clock, ChevronRight } from "lucide-react"
import { getSupabaseClient } from "@/lib/supabase/client"
import {
  fetchLatestOpenRequests,
  type StockRequestWithRelations,
} from "@/lib/supabase/stock-requests-db"
import { formatDateDDMMYYYY } from "@/lib/utils"
import { formatClientLabel } from "@/lib/client-label"

const PREVIEW_COUNT = 6

export function LatestRequests() {
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
    <Card className="flex flex-col">
      <CardHeader className="pb-3 flex flex-row items-start justify-between gap-2 space-y-0">
        <CardTitle className="text-base font-semibold text-foreground">Latest requests</CardTitle>
        <Button variant="ghost" size="sm" className="h-8 shrink-0 gap-0.5 text-xs text-muted-foreground hover:text-foreground" asChild>
          <Link href="/requests">
            View all
            <ChevronRight className="size-3.5" />
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-0 flex-1 min-h-0 overflow-auto pt-0">
        {loading ? (
          <p className="text-sm text-muted-foreground py-6 text-center">Loading…</p>
        ) : latest.length === 0 ? (
          <EmptyState message="No open requests." />
        ) : (
          latest.map((req, i) => {
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

            return (
              <div
                key={req.id}
                className={
                  i !== Math.min(PREVIEW_COUNT - 1, latest.length - 1)
                    ? "flex items-center gap-3 py-3 border-b border-border"
                    : "flex items-center gap-3 py-3"
                }
              >
                <Link
                  href={`/requests/${req.id}`}
                  className="flex items-center gap-3 flex-1 min-w-0 group"
                >
                  <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-brand/15 group-hover:bg-brand/20 transition-colors">
                    <MessageSquare className="w-4 h-4 text-brand" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{title}</p>
                    <p className="text-xs text-muted-foreground truncate">{subtitle}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <StatusPill value={req.status} />
                    <div className="flex items-center justify-end gap-1 mt-1 text-[10px] text-muted-foreground">
                      <Clock className="size-3 shrink-0 opacity-80" aria-hidden />
                      <span>{formatDateDDMMYYYY(req.created_at)}</span>
                    </div>
                  </div>
                </Link>
              </div>
            )
          })
        )}
      </CardContent>
    </Card>
  )
}
