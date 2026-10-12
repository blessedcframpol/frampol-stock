"use client"

import { Suspense, useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { Loader2, MessageSquareWarning } from "lucide-react"
import { EmptyState } from "@/components/fs/empty-state"
import { ListToolbar, ListToolbarSearch } from "@/components/fs/list-toolbar"
import { PageBreadcrumbs } from "@/components/page-breadcrumbs"
import { PageHeader } from "@/components/page-nav"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
import { useAuth } from "@/lib/auth-context"
import { useEffectiveRole } from "@/lib/dev-role-preview"
import { canManageProblemReports, ROLE_LABELS } from "@/lib/permissions"
import {
  fetchProblemReports,
  PROBLEM_REPORT_STATUS_LABELS,
  type ProblemReportRow,
  type ProblemReportStatus,
} from "@/lib/problem-reports"
import { formatDateDDMMYYYY } from "@/lib/utils"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"
import { getSupabaseClient } from "@/lib/supabase/client"

const ALL = "all"
const STATUS_QUERY_VALUES = ["open", "in_progress", "resolved", "open_group"]

export function ProblemReportsList({ mode }: { mode: "admin" | "mine" }) {
  // useSearchParams needs a Suspense boundary during prerender.
  return (
    <Suspense fallback={null}>
      <ProblemReportsListInner mode={mode} />
    </Suspense>
  )
}

function ProblemReportsListInner({ mode }: { mode: "admin" | "mine" }) {
  const { user } = useAuth()
  const role = useEffectiveRole()
  const isAdmin = mode === "admin" && canManageProblemReports(role)
  const [rows, setRows] = useState<ProblemReportRow[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const searchParams = useSearchParams()
  // Deep links such as /problems?status=open preselect the status filter.
  const [statusFilter, setStatusFilter] = useState<string>(() => {
    const status = searchParams.get("status")
    return status && STATUS_QUERY_VALUES.includes(status) ? status : ALL
  })
  const [personFilter, setPersonFilter] = useState<string>(ALL)
  const [fromDate, setFromDate] = useState("")
  const [toDate, setToDate] = useState("")
  const [search, setSearch] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const list = await fetchProblemReports({ mineOnly: mode === "mine" })
      setRows(list)
      if (mode === "admin") {
        const ids = [...new Set(list.map((r) => r.created_by))]
        if (ids.length) {
          const { data } = await getSupabaseClient().rpc("profile_display_labels", {
            p_ids: ids,
          })
          const map: Record<string, string> = {}
          for (const row of data ?? []) {
            map[row.id] = row.label
          }
          setNames(map)
        }
      }
    } catch (e) {
      toastFromCaughtError(e, "Could not load reports")
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [mode])

  useEffect(() => {
    void load()
  }, [load])

  const people = useMemo(() => {
    const ids = [...new Set(rows.map((r) => r.created_by))]
    return ids
      .map((id) => ({ id, label: names[id] || id.slice(0, 8) }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [rows, names])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((r) => {
      if (statusFilter === "open_group") {
        if (r.status === "resolved") return false
      } else if (statusFilter !== ALL && r.status !== statusFilter) {
        return false
      }
      if (personFilter !== ALL && r.created_by !== personFilter) return false
      if (fromDate) {
        if (r.created_at.slice(0, 10) < fromDate) return false
      }
      if (toDate) {
        if (r.created_at.slice(0, 10) > toDate) return false
      }
      if (!q) return true
      return (
        r.report_number.toLowerCase().includes(q) ||
        r.what_happened.toLowerCase().includes(q) ||
        (names[r.created_by] || "").toLowerCase().includes(q)
      )
    })
  }, [rows, statusFilter, personFilter, fromDate, toDate, search, names])

  if (mode === "admin" && !isAdmin) {
    return (
      <div className="flex flex-col gap-4">
        <PageBreadcrumbs items={[{ label: "Dashboard", href: "/" }, { label: "Reported problems" }]} />
        <p className="text-sm text-muted-foreground">Admins only.</p>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-4 md:gap-6">
      <PageBreadcrumbs
        items={[
          { label: "Dashboard", href: "/" },
          mode === "admin"
            ? { label: "Reported problems" }
            : { label: "My reported problems" },
        ]}
      />
      <PageHeader
        title={mode === "admin" ? "Reported problems" : "My reported problems"}
        description={
          mode === "admin"
            ? "Open, progress, and resolve reports from the team."
            : "Reports you have sent, and their status."
        }
        actions={
          <Button asChild>
            <Link href="/problems/new" className="gap-2">
              <MessageSquareWarning className="size-4" />
              Report a problem
            </Link>
          </Button>
        }
      />

      <ListToolbar
        search={
          <>
            <ListToolbarSearch
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search number or text…"
              aria-label="Search reports"
            />
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="min-h-11 w-full rounded-lg bg-background sm:min-h-9 sm:w-[11rem]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All statuses</SelectItem>
                <SelectItem value="open_group">Open / in progress</SelectItem>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="in_progress">In progress</SelectItem>
                <SelectItem value="resolved">Resolved</SelectItem>
              </SelectContent>
            </Select>
            {mode === "admin" ? (
              <Select value={personFilter} onValueChange={setPersonFilter}>
                <SelectTrigger className="min-h-11 w-full rounded-lg bg-background sm:min-h-9 sm:w-[12rem]">
                  <SelectValue placeholder="Person" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All people</SelectItem>
                  {people.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="min-h-11 w-full rounded-lg bg-background sm:min-h-9 sm:w-[10rem]"
              aria-label="From date"
            />
            <Input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="min-h-11 w-full rounded-lg bg-background sm:min-h-9 sm:w-[10rem]"
              aria-label="To date"
            />
          </>
        }
        count={`${visible.length} of ${rows.length}`}
      />

      {loading ? (
        <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : visible.length === 0 ? (
        <EmptyState message="No reports match these filters." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Report</TableHead>
                {mode === "admin" ? <TableHead className="hidden sm:table-cell">Person</TableHead> : null}
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Summary</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium tabular-nums">
                    <Link href={`/problems/${r.id}`} className="text-brand hover:underline">
                      {r.report_number}
                    </Link>
                  </TableCell>
                  {mode === "admin" ? (
                    <TableCell className="hidden sm:table-cell text-sm text-muted-foreground">
                      {names[r.created_by] || "—"}
                      {r.reporter_role ? (
                        <span className="block text-xs">
                          {ROLE_LABELS[r.reporter_role]}
                        </span>
                      ) : null}
                    </TableCell>
                  ) : null}
                  <TableCell>
                    <StatusBadge status={r.status} />
                  </TableCell>
                  <TableCell className="hidden max-w-[18rem] truncate text-sm text-muted-foreground md:table-cell">
                    {r.what_happened}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                    {formatDateDDMMYYYY(r.created_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {mode === "mine" && user ? (
        <p className="text-xs text-muted-foreground">Showing reports for your account.</p>
      ) : null}
    </div>
  )
}

function StatusBadge({ status }: { status: ProblemReportStatus }) {
  const tone =
    status === "resolved"
      ? "bg-success/15 text-success"
      : status === "in_progress"
        ? "bg-warning/15 text-warning"
        : "bg-muted text-foreground"
  return (
    <Badge variant="secondary" className={tone}>
      {PROBLEM_REPORT_STATUS_LABELS[status]}
    </Badge>
  )
}
