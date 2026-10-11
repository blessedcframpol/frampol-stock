"use client"

import Link from "next/link"
import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { RequestStatusPill } from "@/components/request-status-pill"
import { EmptyState } from "@/components/fs/empty-state"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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
import { Plus, MessageSquare, Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import { matchesRequestNumber } from "@/lib/request-number"
import { useAuth } from "@/lib/auth-context"
import { ADMIN, canCreateStockRequest } from "@/lib/permissions"
import { getSupabaseClient } from "@/lib/supabase/client"
import {
  fetchProfileLabels,
  type StockRequestWithRelations,
} from "@/lib/supabase/stock-requests-db"
import { useRequestDisplayStatuses } from "@/hooks/use-request-display-statuses"
import {
  DISPLAY_STATUS_LABELS,
  REQUEST_DISPLAY_STATUSES,
  requestInvoiceColumnLabel,
  requestItemsSummary,
  type RequestDisplayStatus,
} from "@/lib/stock-request-statuses"
import { formatDateDDMMYYYY } from "@/lib/utils"
import { formatClientLabel } from "@/lib/client-label"
import { PageHeader } from "@/components/page-nav"
import { ToIssueQueue } from "@/components/to-issue-queue"

type SortKey = "newest" | "oldest" | "status" | "client"

const SORT_LABELS: Record<SortKey, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
  status: "Status",
  client: "Client",
}

const ALL = "all"

function clientLabel(r: StockRequestWithRelations): string {
  return r.client ? formatClientLabel(r.client) : r.client_id
}

export function StockRequestsList({
  requests,
  onRequestsChanged,
}: {
  requests: StockRequestWithRelations[]
  onRequestsChanged?: () => void
}) {
  const { role, user } = useAuth()
  const canCreate = canCreateStockRequest(role)
  const isAdmin = role === ADMIN
  /** Admin and Admin viewer can read other people's profiles, so only they get requester names. */
  const sees = isAdmin || role === "viewer"
  const seesAll = sees || role === "accounts"

  const [statusFilter, setStatusFilter] = useState<string>(ALL)
  const [userFilter, setUserFilter] = useState<string>(ALL)
  const [numberQuery, setNumberQuery] = useState("")
  const [sort, setSort] = useState<SortKey>("newest")
  const [names, setNames] = useState<Map<string, string>>(new Map())

  const displayStatuses = useRequestDisplayStatuses(requests)

  const requesterKey = useMemo(
    () => [...new Set(requests.map((r) => r.created_by))].sort().join(","),
    [requests]
  )

  useEffect(() => {
    if (!sees || !requesterKey) return
    let cancelled = false
    void (async () => {
      try {
        const labels = await fetchProfileLabels(getSupabaseClient(), requesterKey.split(","))
        if (!cancelled) setNames(labels)
      } catch {
        // Labels are cosmetic; ids still group correctly.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sees, requesterKey])

  function requesterName(id: string): string {
    if (id === user?.id) return "You"
    return names.get(id) ?? `User ${id.slice(0, 8)}`
  }

  const requesters = useMemo(() => {
    const ids = [...new Set(requests.map((r) => r.created_by))]
    return ids
      .map((id) => ({ id, label: id === user?.id ? "You" : (names.get(id) ?? `User ${id.slice(0, 8)}`) }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [requests, names, user?.id])

  const visible = useMemo(() => {
    const rows = requests.filter((r) => {
      if (statusFilter !== ALL && displayStatuses[r.id] !== statusFilter) return false
      if (isAdmin && userFilter !== ALL && r.created_by !== userFilter) return false
      if (numberQuery.trim() && !matchesRequestNumber(r.request_number, numberQuery)) return false
      return true
    })
    const statusRank = (r: StockRequestWithRelations) =>
      REQUEST_DISPLAY_STATUSES.indexOf(displayStatuses[r.id] ?? "being_reviewed")
    return [...rows].sort((a, b) => {
      if (sort === "oldest") return a.created_at.localeCompare(b.created_at)
      if (sort === "status") return statusRank(a) - statusRank(b) || b.created_at.localeCompare(a.created_at)
      if (sort === "client") {
        return clientLabel(a).localeCompare(clientLabel(b), undefined, { sensitivity: "base" })
      }
      return b.created_at.localeCompare(a.created_at)
    })
  }, [requests, displayStatuses, statusFilter, userFilter, numberQuery, sort, isAdmin])

  /** Admin: requests still waiting on an invoice number, grouped by requester. */
  const pendingByRequester = useMemo(() => {
    if (!isAdmin) return []
    const groups = new Map<string, StockRequestWithRelations[]>()
    for (const r of requests) {
      if (r.invoice_status !== "pending") continue
      if (r.review_state === "rejected" || r.review_state === "cancelled" || r.review_state === "closed") continue
      const list = groups.get(r.created_by) ?? []
      list.push(r)
      groups.set(r.created_by, list)
    }
    return [...groups.entries()]
      .map(([id, rows]) => ({ id, rows }))
      .sort((a, b) => b.rows.length - a.rows.length)
  }, [requests, isAdmin])

  return (
    <div className="flex flex-col gap-4 md:gap-6 min-w-0">
      <PageHeader
        title="Requests"
        description={
          seesAll
            ? "Every stock request. Issue units, approve 00000, or follow up on invoices."
            : "Your stock requests. Raise one for stock to be issued against."
        }
        actions={
          canCreate ? (
            <Button asChild>
              <Link href="/requests/new" className="gap-2">
                <Plus className="size-4" />
                New request
              </Link>
            </Button>
          ) : undefined
        }
      />

      {isAdmin ? (
        <ToIssueQueue
          requests={requests}
          requesterName={requesterName}
          onChanged={onRequestsChanged}
        />
      ) : null}

      {isAdmin && pendingByRequester.length > 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              Pending invoices ({pendingByRequester.reduce((n, g) => n + g.rows.length, 0)})
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {pendingByRequester.map((g) => (
              <div key={g.id} className="flex flex-col gap-1">
                <p className="text-sm font-medium text-foreground">
                  {requesterName(g.id)}{" "}
                  <span className="font-normal text-muted-foreground">
                    · {g.rows.length} request{g.rows.length !== 1 ? "s" : ""}
                  </span>
                </p>
                <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  {g.rows.map((r) => (
                    <li key={r.id}>
                      <Link href={`/requests/${r.id}`} className="text-brand hover:underline">
                        {r.request_number} · {clientLabel(r)} · {formatDateDDMMYYYY(r.created_at)}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {requests.length === 0 ? (
        <EmptyState
          message="No stock requests yet."
          action={
            canCreate ? (
              <Button asChild variant="outline" size="sm">
                <Link href="/requests/new">Create one</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-[14rem]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={numberQuery}
                onChange={(e) => setNumberQuery(e.target.value)}
                placeholder="Request # (e.g. 42)"
                className="h-9 rounded-lg bg-background pl-8"
                aria-label="Search by request number"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-9 w-full sm:w-[12rem] rounded-lg bg-background" aria-label="Filter by status">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All statuses</SelectItem>
                {REQUEST_DISPLAY_STATUSES.map((s: RequestDisplayStatus) => (
                  <SelectItem key={s} value={s}>
                    {DISPLAY_STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isAdmin ? (
              <Select value={userFilter} onValueChange={setUserFilter}>
                <SelectTrigger className="h-9 w-full sm:w-[12rem] rounded-lg bg-background" aria-label="Filter by requester">
                  <SelectValue placeholder="Requester" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All requesters</SelectItem>
                  {requesters.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
              <SelectTrigger className="h-9 w-full sm:w-[12rem] rounded-lg bg-background" aria-label="Sort">
                <SelectValue placeholder="Sort" />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {SORT_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground tabular-nums">
              {visible.length} of {requests.length}
            </span>
          </div>

          {visible.length === 0 ? (
            <EmptyState message="No requests match these filters." />
          ) : (
            <Card>
              <CardContent className="p-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Request</TableHead>
                      <TableHead>Client</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Items</TableHead>
                      <TableHead>Invoice</TableHead>
                      {sees ? <TableHead>Requester</TableHead> : null}
                      <TableHead>Status</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead className="w-[100px]" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="font-medium whitespace-nowrap tabular-nums">
                          {r.request_number}
                        </TableCell>
                        <TableCell className="font-medium">{clientLabel(r)}</TableCell>
                        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">{r.type}</TableCell>
                        <TableCell className="text-muted-foreground text-sm max-w-[18rem]">
                          <span className="line-clamp-2">{requestItemsSummary(r.stock_request_lines ?? [])}</span>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                          {requestInvoiceColumnLabel(r)}
                        </TableCell>
                        {sees ? (
                          <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                            {requesterName(r.created_by)}
                          </TableCell>
                        ) : null}
                        <TableCell>
                          <RequestStatusPill status={displayStatuses[r.id]} />
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                          {formatDateDDMMYYYY(r.created_at)}
                        </TableCell>
                        <TableCell>
                          <Button variant="ghost" size="sm" asChild>
                            <Link href={`/requests/${r.id}`} className="gap-1">
                              <MessageSquare className="size-3.5" />
                              Open
                            </Link>
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
