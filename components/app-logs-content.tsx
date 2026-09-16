"use client"

import { useCallback, useEffect, useRef, useState } from "react"
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
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { ScrollText, Loader2 } from "lucide-react"
import { useAuth } from "@/lib/auth-context"
import { canViewAppLogs } from "@/lib/permissions"
import { PageBackLink, PageHeader } from "@/components/page-nav"
import { toastFromApiErrorBody, toastFromCaughtError } from "@/lib/toast-reportable-error"
import { formatDateDDMMYYYY } from "@/lib/utils"
import { cn } from "@/lib/utils"

export type AppEventLogRow = {
  id: string
  created_at: string
  severity: string
  source: string
  context: string
  message: string
  detail: string | null
  metadata: unknown
  user_id: string | null
  request_id: string | null
}

const severityBadge: Record<string, string> = {
  error: "bg-destructive/15 text-destructive",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  info: "bg-muted text-foreground",
}

const PAGE_SIZE = 50

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${formatDateDDMMYYYY(iso)} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
}

export function AppLogsContent() {
  const { role } = useAuth()
  const allowed = canViewAppLogs(role)
  const [rows, setRows] = useState<AppEventLogRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [severity, setSeverity] = useState<string>("all")
  const [contextPrefix, setContextPrefix] = useState("")
  const [detailRow, setDetailRow] = useState<AppEventLogRow | null>(null)
  // A replace fetch bumps this. A slower replace or append must not apply after it.
  const fetchGen = useRef(0)

  const fetchPage = useCallback(
    async (opts: { append: boolean; before?: string; isStale?: () => boolean }): Promise<"applied" | "stale"> => {
      const gen = opts.append ? fetchGen.current : ++fetchGen.current
      const stale = () => (opts.isStale?.() ?? false) || fetchGen.current !== gen
      const params = new URLSearchParams()
      params.set("limit", String(PAGE_SIZE))
      if (opts.before) params.set("before", opts.before)
      if (severity !== "all") params.set("severity", severity)
      const ctx = contextPrefix.trim()
      if (ctx) params.set("context", ctx)
      const res = await fetch(`/api/app-logs?${params.toString()}`)
      const data = await res.json().catch(() => ({}))
      if (stale()) return "stale"
      if (!res.ok) {
        toastFromApiErrorBody(data, "Failed to load event logs", res.status)
        if (!opts.append) setRows([])
        return "applied"
      }
      const list = Array.isArray(data) ? (data as AppEventLogRow[]) : []
      if (stale()) return "stale"
      if (opts.append) {
        setRows((prev) => [...prev, ...list])
      } else {
        setRows(list)
      }
      return "applied"
    },
    [severity, contextPrefix]
  )

  useEffect(() => {
    if (!allowed) return
    let cancelled = false
    void (async () => {
      try {
        const result = await fetchPage({ append: false, isStale: () => cancelled })
        if (result === "stale") return
      } catch (e) {
        if (!cancelled) toastFromCaughtError(e, "Failed to load event logs")
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [allowed, fetchPage])

  async function applyFilters() {
    if (!allowed) return
    setLoading(true)
    let ownsLoading = true
    try {
      const result = await fetchPage({ append: false })
      ownsLoading = result !== "stale"
    } catch (e) {
      toastFromCaughtError(e, "Failed to load event logs")
    } finally {
      if (ownsLoading) setLoading(false)
    }
  }

  async function loadMore() {
    if (!allowed || rows.length === 0) return
    const last = rows[rows.length - 1]
    if (!last) return
    setLoadingMore(true)
    try {
      await fetchPage({ append: true, before: last.created_at })
    } catch (e) {
      toastFromCaughtError(e, "Failed to load more")
    } finally {
      setLoadingMore(false)
    }
  }

  if (!allowed) {
    return (
      <div className="flex flex-col gap-4 min-w-0 items-start">
        <PageBackLink href="/" label="Dashboard" />
        <p className="text-sm text-muted-foreground">You do not have access to error logs.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 md:gap-6 min-w-0">
      <PageHeader
        title="Error and event logs"
        description="Persisted operational failures (movement persist, server 5xx). Use request ID to correlate with API responses."
        icon={ScrollText}
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">Filters</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col sm:flex-row flex-wrap gap-4 items-end">
          <div className="space-y-2 w-full sm:w-48">
            <Label className="text-xs text-muted-foreground">Severity</Label>
            <Select value={severity} onValueChange={setSeverity}>
              <SelectTrigger>
                <SelectValue placeholder="All" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="error">error</SelectItem>
                <SelectItem value="warn">warn</SelectItem>
                <SelectItem value="info">info</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2 flex-1 min-w-[200px]">
            <Label className="text-xs text-muted-foreground">Context prefix</Label>
            <Input
              placeholder="e.g. movement_persist"
              value={contextPrefix}
              onChange={(e) => setContextPrefix(e.target.value)}
            />
          </div>
          <Button type="button" onClick={() => void applyFilters()} disabled={loading}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Apply"}
          </Button>
        </CardContent>
      </Card>

      <Card className="flex flex-col min-h-[240px]">
        <CardContent className="p-0 flex-1 min-h-0 overflow-auto overflow-x-auto">
          {loading && rows.length === 0 ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground text-sm gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading…
            </div>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 px-4">No log entries match the current filters.</p>
          ) : (
            <Table className="min-w-[900px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-xs text-muted-foreground font-medium whitespace-nowrap">When</TableHead>
                  <TableHead className="text-xs text-muted-foreground font-medium">Sev</TableHead>
                  <TableHead className="text-xs text-muted-foreground font-medium">Src</TableHead>
                  <TableHead className="text-xs text-muted-foreground font-medium">Context</TableHead>
                  <TableHead className="text-xs text-muted-foreground font-medium">Message</TableHead>
                  <TableHead className="text-xs text-muted-foreground font-medium hidden lg:table-cell">Request</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setDetailRow(r)}>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap font-mono">
                      {formatDateTime(r.created_at)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className={cn("text-[10px] border-0", severityBadge[r.severity] ?? "")}>
                        {r.severity}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">{r.source}</TableCell>
                    <TableCell className="text-xs font-mono max-w-[180px] truncate" title={r.context}>
                      {r.context}
                    </TableCell>
                    <TableCell className="text-sm max-w-[320px] truncate" title={r.message}>
                      {r.message}
                    </TableCell>
                    <TableCell className="text-xs font-mono text-muted-foreground hidden lg:table-cell max-w-[120px] truncate">
                      {r.request_id ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs text-primary">Details</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
        {rows.length > 0 && (
          <div className="p-4 border-t border-border flex justify-center">
            <Button type="button" variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Loading…
                </>
              ) : (
                "Load more"
              )}
            </Button>
          </div>
        )}
      </Card>

      <Sheet open={!!detailRow} onOpenChange={(open) => !open && setDetailRow(null)}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Log entry</SheetTitle>
            <SheetDescription>{detailRow ? formatDateTime(detailRow.created_at) : ""}</SheetDescription>
          </SheetHeader>
          {detailRow && (
            <div className="mt-6 space-y-4 text-sm">
              <div>
                <p className="text-xs font-medium text-muted-foreground">Severity</p>
                <p className="mt-1">{detailRow.severity}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground">Source</p>
                <p className="mt-1">{detailRow.source}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground">Context</p>
                <p className="mt-1 font-mono break-all">{detailRow.context}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground">Message</p>
                <p className="mt-1 whitespace-pre-wrap break-words">{detailRow.message}</p>
              </div>
              {detailRow.detail && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Detail</p>
                  <p className="mt-1 whitespace-pre-wrap break-words font-mono text-xs">{detailRow.detail}</p>
                </div>
              )}
              {detailRow.request_id && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Request ID</p>
                  <p className="mt-1 font-mono text-xs break-all">{detailRow.request_id}</p>
                </div>
              )}
              {detailRow.user_id && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground">User ID</p>
                  <p className="mt-1 font-mono text-xs break-all">{detailRow.user_id}</p>
                </div>
              )}
              {detailRow.metadata != null && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Metadata (JSON)</p>
                  <pre className="mt-2 p-3 rounded-md bg-muted text-xs overflow-x-auto max-h-[40vh]">
                    {JSON.stringify(detailRow.metadata, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
