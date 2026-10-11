"use client"

import { useEffect, useState } from "react"
import { Download } from "lucide-react"
import { Button } from "@/components/ui/button"
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { downloadCsv } from "@/lib/download-csv"
import { formatRecordedAt } from "@/lib/business-date.mjs"
import { useOrgTimezone } from "@/hooks/use-org-timezone"
import {
  fetchAuditLog,
  fetchAuthSignIns,
  formatAuditValue,
  weekRangeInTz,
  type AuditLogFilters,
  type AuditLogRow,
  type AuthSignInRow,
} from "@/lib/audit-log"

const TABLES = [
  { value: "all", label: "All tables" },
  { value: "auth", label: "Sign-ins" },
  { value: "transactions", label: "Transactions" },
  { value: "inventory_items", label: "Inventory" },
  { value: "clients", label: "Clients" },
  { value: "stock_requests", label: "Requests" },
  { value: "stock_request_lines", label: "Request lines" },
  { value: "profiles", label: "Profiles" },
  { value: "batch_invoices", label: "Batch invoices" },
  { value: "batch_reversals", label: "Reversals" },
  { value: "batch_restores", label: "Restores" },
  { value: "stock_pool_changes", label: "Pool changes" },
  { value: "holding_extensions", label: "Holding extensions" },
  { value: "kit_cases", label: "Kit cases" },
  { value: "product_lines", label: "Products" },
  { value: "app_settings", label: "Settings" },
]

const ACTIONS = [
  { value: "all", label: "All actions" },
  { value: "sign_in", label: "Sign-in" },
  { value: "insert", label: "Insert" },
  { value: "update", label: "Update" },
  { value: "delete", label: "Delete" },
]

const EMPTY_FILTERS: AuditLogFilters = {
  table: "",
  row: "",
  user: "",
  action: "",
  from: "",
  to: "",
}

function changeText(row: AuditLogRow): string {
  if (row.action === "sign_in") {
    const ip = typeof row.changed?.ip === "string" ? row.changed.ip : null
    const ua = typeof row.changed?.user_agent === "string" ? row.changed.user_agent : null
    return [ip ? `IP ${ip}` : null, ua ? `UA ${ua}` : null].filter(Boolean).join(" · ") || "Sign-in"
  }
  return Object.entries(row.changed ?? {})
    .map(([field, pair]) => {
      const [before, after] = pair ?? []
      return `${field}: ${formatAuditValue(before)} → ${formatAuditValue(after)}`
    })
    .join("; ")
}

export function AuditLogPanel() {
  const timeZone = useOrgTimezone()
  const [draft, setDraft] = useState<AuditLogFilters>(EMPTY_FILTERS)
  const [filters, setFilters] = useState<AuditLogFilters>(EMPTY_FILTERS)
  const [rows, setRows] = useState<AuditLogRow[]>([])
  const [signIns, setSignIns] = useState<AuthSignInRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showSignIns, setShowSignIns] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void Promise.all([
      fetchAuditLog(filters),
      showSignIns
        ? fetchAuthSignIns({ user: filters.user, from: filters.from, to: filters.to })
        : Promise.resolve([] as AuthSignInRow[]),
    ])
      .then(([next, nextSignIns]) => {
        if (cancelled) return
        setRows(next)
        setSignIns(nextSignIns)
        setError(null)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : "Could not load the audit log")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [filters, showSignIns])

  function applyFilters() {
    if (draft.from && draft.to && draft.from > draft.to) {
      setError("From is after to.")
      return
    }
    setError(null)
    setLoading(true)
    setFilters({ ...draft })
  }

  function personThisWeek() {
    if (!draft.user.trim()) {
      setError("Enter a person (name, email, or id) for the per-person week view.")
      return
    }
    const range = weekRangeInTz(timeZone)
    const next = { ...draft, from: range.from, to: range.to, table: "", action: "", row: "" }
    setDraft(next)
    setError(null)
    setLoading(true)
    setFilters(next)
  }

  function exportRows() {
    downloadCsv(
      [
        ["When", "Table", "Record", "Action", "Actor", "Source", "Reason", "Changes", "Seq", "Transaction"],
        ...rows.map((row) => [
          formatRecordedAt(row.at, "", timeZone),
          row.table_name,
          row.row_id,
          row.action,
          row.actor_name || row.actor,
          row.source,
          row.reason ?? "",
          changeText(row),
          row.seq != null ? String(row.seq) : "",
          String(row.transaction_id),
        ]),
      ],
      "audit-log.csv",
    )
  }

  return (
    <div className="flex flex-col gap-4 py-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Table</Label>
          <Select
            value={draft.table || "all"}
            onValueChange={(value) => setDraft((prev) => ({ ...prev, table: value === "all" ? "" : value }))}
          >
            <SelectTrigger className="w-44 bg-card">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TABLES.map((table) => (
                <SelectItem key={table.value} value={table.value}>
                  {table.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Action</Label>
          <Select
            value={draft.action || "all"}
            onValueChange={(value) =>
              setDraft((prev) => ({ ...prev, action: value === "all" ? "" : value }))
            }
          >
            <SelectTrigger className="w-36 bg-card">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACTIONS.map((action) => (
                <SelectItem key={action.value} value={action.value}>
                  {action.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Record</Label>
          <Input
            className="w-48 bg-card"
            value={draft.row}
            onChange={(event) => setDraft((prev) => ({ ...prev, row: event.target.value }))}
            placeholder="Row id"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Person</Label>
          <Input
            className="w-48 bg-card"
            value={draft.user}
            onChange={(event) => setDraft((prev) => ({ ...prev, user: event.target.value }))}
            placeholder="Name, email, or id"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">From</Label>
          <Input
            type="date"
            className="bg-card"
            value={draft.from}
            onChange={(event) => setDraft((prev) => ({ ...prev, from: event.target.value }))}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">To</Label>
          <Input
            type="date"
            className="bg-card"
            value={draft.to}
            onChange={(event) => setDraft((prev) => ({ ...prev, to: event.target.value }))}
          />
        </div>
        <Button type="button" onClick={applyFilters}>
          Show
        </Button>
        <Button type="button" variant="outline" onClick={personThisWeek}>
          Person this week
        </Button>
        <Button type="button" variant="outline" onClick={exportRows} disabled={rows.length === 0}>
          <Download className="mr-1.5 size-3.5" />
          Export
        </Button>
        <Button
          type="button"
          variant={showSignIns ? "default" : "outline"}
          onClick={() => setShowSignIns((v) => !v)}
        >
          Sign-ins
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Read-only for admins and Admin viewers. Newest 500 rows. Timezone {timeZone}.
      </p>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {loading ? <p className="text-sm text-muted-foreground">Loading the audit log…</p> : null}
      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Table</TableHead>
              <TableHead>Record</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Change</TableHead>
              <TableHead>Actor</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && !loading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground">
                  No audit rows in this filter.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap text-xs">
                    {formatRecordedAt(row.at, "", timeZone)}
                  </TableCell>
                  <TableCell>{row.table_name}</TableCell>
                  <TableCell className="font-mono text-xs">{row.row_id}</TableCell>
                  <TableCell>
                    {row.action}
                    <p className="text-xs text-muted-foreground">{row.source}</p>
                  </TableCell>
                  <TableCell className="max-w-md text-xs">
                    {row.reason ? <p className="mb-1 text-foreground">{row.reason}</p> : null}
                    <p className="text-muted-foreground">{changeText(row)}</p>
                  </TableCell>
                  <TableCell className="text-xs">{row.actor_name || row.actor}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {showSignIns ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Sign-ins (Supabase Auth)</h3>
          <p className="text-xs text-muted-foreground">
            Microsoft OAuth completions recorded by record_sign_in (one row per sign-in, not token refresh).
            Also filter the main log by action Sign-in or table Sign-ins / person this week.
          </p>
          <div className="overflow-x-auto rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Person</TableHead>
                  <TableHead>IP</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {signIns.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-muted-foreground">
                      No sign-in rows in this filter.
                    </TableCell>
                  </TableRow>
                ) : (
                  signIns.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="whitespace-nowrap text-xs">
                        {formatRecordedAt(row.at, "", timeZone)}
                      </TableCell>
                      <TableCell>{row.action}</TableCell>
                      <TableCell className="text-xs">
                        {row.actor_name || row.actor_email || row.actor_id}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{row.ip_address}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : null}
    </div>
  )
}
