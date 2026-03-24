"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { MessageSquare, Clock, ChevronRight } from "lucide-react"
import { getSupabaseClient } from "@/lib/supabase/client"
import {
  fetchLatestOpenRequests,
  type StockRequestWithRelations,
} from "@/lib/supabase/stock-requests-db"
import { formatDateDDMMYYYY } from "@/lib/utils"

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
    <Card className="h-full min-h-[300px] sm:min-h-[340px] flex flex-col">
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
          <p className="text-sm text-muted-foreground py-6 text-center">No open requests.</p>
        ) : (
          latest.map((req, i) => {
            const lineCount = (req.stock_request_lines ?? []).length
            const title =
              req.client?.company ??
              req.client?.name ??
              (lineCount ? `${lineCount} line request` : "Stock request")
            const subtitleParts: string[] = []
            if (req.client?.name && req.client?.company) subtitleParts.push(req.client.name)
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
                  <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-indigo-500/10 group-hover:bg-indigo-500/15 transition-colors">
                    <MessageSquare className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{title}</p>
                    <p className="text-xs text-muted-foreground truncate">{subtitle}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <Badge
                      variant="secondary"
                      className="text-[10px] font-medium border-0 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                    >
                      {req.status.replace("_", " ")}
                    </Badge>
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
