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
import { fetchAuditLog, formatAuditValue, type AuditLogFilters, type AuditLogRow } from "@/lib/audit-log"

const TABLES = [
  { value: "all", label: "All tables" },
  { value: "transactions", label: "Transactions" },
  { value: "inventory_items", label: "Inventory" },
  { value: "clients", label: "Clients" },
]

const EMPTY_FILTERS: AuditLogFilters = { table: "", row: "", user: "", from: "", to: "" }

function changeText(row: AuditLogRow): string {
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
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void fetchAuditLog(filters)
      .then((next) => {
        if (cancelled) return
        setRows(next)
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
  }, [filters])

  function applyFilters() {
    if (draft.from && draft.to && draft.from > draft.to) {
      setError("From is after to.")
      return
    }
    setError(null)
    setLoading(true)
    setFilters({ ...draft })
  }

  function exportRows() {
    downloadCsv(
      [
        ["When", "Table", "Record", "Action", "Actor", "Source", "Reason", "Changes", "Transaction"],
        ...rows.map((row) => [
          formatRecordedAt(row.at, "", timeZone),
          row.table_name,
          row.row_id,
          row.action,
          row.actor_name || row.actor,
          row.source,
          row.reason ?? "",
          changeText(row),
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
            <SelectTrigger className="w-40 bg-card">
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
          <Label className="text-xs text-muted-foreground">Record</Label>
          <Input
            className="w-48 bg-card"
            value={draft.row}
            onChange={(event) => setDraft((prev) => ({ ...prev, row: event.target.value }))}
            placeholder="Row id"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">User</Label>
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
        <Button type="button" variant="outline" onClick={exportRows} disabled={rows.length === 0}>
          <Download className="mr-1.5 size-3.5" />
          Export
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Read-only. Newest 500 rows. Timezone {timeZone}.</p>
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
                  <TableCell className="whitespace-nowrap text-xs">{formatRecordedAt(row.at, "", timeZone)}</TableCell>
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
    </div>
  )
}
