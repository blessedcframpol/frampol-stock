"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { ClipboardCheck } from "lucide-react"
import { PageHeader } from "@/components/page-nav"
import { EmptyState } from "@/components/fs/empty-state"
import { Button } from "@/components/ui/button"
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
import { clientLabel, daysWaiting, loadKitCases, type KitCaseRow } from "@/lib/kit-cases"
import { useOrgTimezone } from "@/hooks/use-org-timezone"

function formatWhen(value: string | null, timeZone: string): string {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date)
}

export function InspectionsContent() {
  const timeZone = useOrgTimezone()
  const [tab, setTab] = useState<"open" | "closed">("open")
  const [typeFilter, setTypeFilter] = useState("all")
  const [rows, setRows] = useState<KitCaseRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void loadKitCases(tab)
      .then((next) => {
        if (!cancelled) {
          setRows(next)
          setError(null)
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load inspections")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [tab])

  const visible = useMemo(() => {
    if (typeFilter === "all") return rows
    return rows.filter((row) => row.source_label === typeFilter)
  }, [rows, typeFilter])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Inspections"
        description="Kits waiting after a decommission or rental return, oldest first."
        icon={ClipboardCheck}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant={tab === "open" ? "default" : "outline"} onClick={() => { setLoading(true); setTab("open") }}>
          Open
        </Button>
        <Button type="button" variant={tab === "closed" ? "default" : "outline"} onClick={() => { setLoading(true); setTab("closed") }}>
          Closed
        </Button>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-[200px] bg-card">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="Decommissioned">Decommissioned</SelectItem>
            <SelectItem value="Rental return">Rental return</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {!loading && visible.length === 0 ? <EmptyState message={tab === "open" ? "No open cases." : "No closed cases."} /> : null}
      {!loading && visible.length > 0 ? (
        <div className="rounded-md border border-border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kit</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Reason</TableHead>
                {tab === "open" ? <TableHead>Days waiting</TableHead> : null}
                {tab === "closed" ? <TableHead>Outcome</TableHead> : null}
                {tab === "closed" ? <TableHead>Grade</TableHead> : null}
                {tab === "closed" ? <TableHead>Closed</TableHead> : null}
                <TableHead>Stage</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-xs">
                    <Link href={`/inventory/inspections/${row.id}`} className="text-info underline-offset-4 hover:underline">
                      {row.serial_number}
                    </Link>
                  </TableCell>
                  <TableCell>{row.product_name ?? "—"}</TableCell>
                  <TableCell>{row.source_label}</TableCell>
                  <TableCell>{clientLabel(row)}</TableCell>
                  <TableCell>{row.reason_category}</TableCell>
                  {tab === "open" ? <TableCell>{daysWaiting(row.opened_at)}</TableCell> : null}
                  {tab === "closed" ? <TableCell>{row.outcome ?? "—"}</TableCell> : null}
                  {tab === "closed" ? <TableCell>{row.grade ?? "—"}</TableCell> : null}
                  {tab === "closed" ? (
                    <TableCell>
                      {row.closed_by_name ?? "Recorded"}
                      <span className="text-muted-foreground"> · {formatWhen(row.closed_at, timeZone)}</span>
                    </TableCell>
                  ) : null}
                  <TableCell className="capitalize">{row.stage}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </div>
  )
}
