"use client"

import { useEffect, useMemo, useState } from "react"
import { useSearchParams } from "next/navigation"
import { PageHeader } from "@/components/page-nav"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatRecordedAt } from "@/lib/business-date.mjs"
import { useOrgTimezone } from "@/hooks/use-org-timezone"
import { useAuth } from "@/lib/auth-context"
import { canViewAuditLog } from "@/lib/permissions"
import {
  fetchAuditExceptions,
  formatAuditValue,
  weekRangeInTz,
  type AuditExceptionRow,
} from "@/lib/audit-log"

const CATEGORY_LABELS: Record<string, string> = {
  reversal: "Reversals",
  restore: "Restores",
  void: "Voids",
  approval_00000: "00000 approvals",
  issue_without_request: "Stock issued without a request",
  pool_change: "Pool changes",
  kit_edit: "Kit edits",
  invoice_number_change: "Invoice number changes",
  request_reject_or_close: "Request rejections and closes",
  role_change: "Role changes",
  cancelled_extension: "Cancelled extensions",
  direct_sql: "Direct SQL (source direct)",
}

function changeSummary(row: AuditExceptionRow): string {
  return Object.entries(row.changed ?? {})
    .slice(0, 6)
    .map(([field, pair]) => {
      const [before, after] = pair ?? []
      return `${field}: ${formatAuditValue(before)} → ${formatAuditValue(after)}`
    })
    .join("; ")
}

export function AuditExceptionsReport() {
  const timeZone = useOrgTimezone()
  const { role, loading: userLoading } = useAuth()
  const params = useSearchParams()
  const initial = useMemo(() => {
    const fromParam = params.get("from")
    const toParam = params.get("to")
    if (fromParam && toParam) return { from: fromParam, to: toParam }
    return weekRangeInTz(timeZone)
  }, [params, timeZone])

  const [from, setFrom] = useState(initial.from)
  const [to, setTo] = useState(initial.to)
  const [applied, setApplied] = useState(initial)
  const [rows, setRows] = useState<AuditExceptionRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const allowed = canViewAuditLog(role)

  useEffect(() => {
    if (userLoading || !allowed) return
    let cancelled = false
    setLoading(true)
    void fetchAuditExceptions(applied.from, applied.to)
      .then((next) => {
        if (cancelled) return
        setRows(next)
        setError(null)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : "Could not load exceptions")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [applied, allowed, userLoading])

  if (!userLoading && !allowed) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Audit exceptions" description="Admins and Admin viewers only." />
        <p className="text-sm text-muted-foreground">You do not have access to this report.</p>
      </div>
    )
  }

  const grouped = rows.reduce<Record<string, AuditExceptionRow[]>>((acc, row) => {
    const key = row.category || "other"
    ;(acc[key] ??= []).push(row)
    return acc
  }, {})

  return (
    <div className="flex flex-col gap-4 md:gap-6 min-w-0">
      <PageHeader
        title="Audit exceptions"
        description="Weekly exception categories from the audit trail. Read-only."
      />
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">From</Label>
          <Input type="date" className="bg-card" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">To</Label>
          <Input type="date" className="bg-card" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <Button
          type="button"
          onClick={() => {
            if (from && to && from > to) {
              setError("From is after to.")
              return
            }
            setApplied({ from, to })
          }}
        >
          Show
        </Button>
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {!loading && rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No exceptions in this range.</p>
      ) : null}
      {Object.entries(CATEGORY_LABELS).map(([key, label]) => {
        const list = grouped[key]
        if (!list?.length) return null
        return (
          <section key={key} className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">
              {label}{" "}
              <span className="text-muted-foreground font-normal">({list.length})</span>
            </h2>
            <div className="overflow-x-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Who</TableHead>
                    <TableHead>Table</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="whitespace-nowrap text-xs">
                        {formatRecordedAt(row.at, "", timeZone)}
                      </TableCell>
                      <TableCell className="text-xs">{row.actor_name || row.actor}</TableCell>
                      <TableCell className="text-xs">
                        {row.table_name}
                        <p className="font-mono text-muted-foreground">{row.row_id}</p>
                      </TableCell>
                      <TableCell className="text-xs">{row.source}</TableCell>
                      <TableCell className="max-w-lg text-xs text-muted-foreground">
                        {row.reason ? <p className="mb-1 text-foreground">{row.reason}</p> : null}
                        {changeSummary(row)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        )
      })}
    </div>
  )
}
