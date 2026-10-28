"use client"

import Link from "next/link"
import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { RequestStatusPill } from "@/components/request-status-pill"
import { useAuth } from "@/lib/auth-context"
import { getSupabaseClient } from "@/lib/supabase/client"
import {
  approveNotInvoiced,
  fetchFreshIssueLocks,
  fetchProfileLabels,
  rejectRequest,
  type RejectReasonCode,
  type StockRequestWithRelations,
} from "@/lib/supabase/stock-requests-db"
import { AtlasLinkPendingPill } from "@/components/atlas-link-pending-pill"
import { formatIssueLockAge } from "@/lib/issue-lock"
import { useRequestDisplayStatuses } from "@/hooks/use-request-display-statuses"
import { REJECT_REASON_LABELS, requestItemsSummary } from "@/lib/stock-request-statuses"
import { formatClientLabel } from "@/lib/client-label"
import { ageInDays, formatAgeDays } from "@/lib/format-display"
import { todayBusinessDate } from "@/lib/business-date.mjs"
import { useOrgTimezone } from "@/hooks/use-org-timezone"
import { requestIsAllFortinet } from "@/lib/issue-scan-feedback"
import { toast } from "sonner"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Loader2, Truck } from "lucide-react"

type Props = {
  requests: StockRequestWithRelations[]
  requesterName: (id: string) => string
  onChanged?: () => void
}

export function ToIssueQueue({ requests, requesterName, onChanged }: Props) {
  const { user } = useAuth()
  const timeZone = useOrgTimezone()
  const [freshLocks, setFreshLocks] = useState<
    Map<string, { userId: string; since: string }>
  >(new Map())
  const [lockLabels, setLockLabels] = useState<Map<string, string>>(new Map())
  const today = todayBusinessDate(timeZone)
  const displayStatuses = useRequestDisplayStatuses(requests)

  const toIssueIds = useMemo(
    () =>
      [...requests]
        .filter((r) => {
          const s = displayStatuses[r.id]
          return s === "being_reviewed" || s === "partially_issued"
        })
        .map((r) => r.id),
    [requests, displayStatuses],
  )

  useEffect(() => {
    if (toIssueIds.length === 0) {
      setFreshLocks(new Map())
      return
    }
    let cancelled = false
    const load = () => {
      void fetchFreshIssueLocks(getSupabaseClient(), toIssueIds).then((map) => {
        if (cancelled) return
        const next = new Map<string, { userId: string; since: string }>()
        for (const id of toIssueIds) {
          const row = map.get(id)
          if (row?.activeUserId && row.activeSince) {
            next.set(id, { userId: row.activeUserId, since: row.activeSince })
          }
        }
        setFreshLocks(next)
      })
    }
    load()
    const timer = window.setInterval(load, 30_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [toIssueIds])

  useEffect(() => {
    const ids = [...new Set([...freshLocks.values()].map((v) => v.userId))]
    if (ids.length === 0) {
      setLockLabels(new Map())
      return
    }
    let cancelled = false
    void fetchProfileLabels(getSupabaseClient(), ids).then((map) => {
      if (!cancelled) setLockLabels(map)
    })
    return () => {
      cancelled = true
    }
  }, [freshLocks])

  const toIssue = useMemo(() => {
    return [...requests]
      .filter((r) => {
        const s = displayStatuses[r.id]
        return s === "being_reviewed" || s === "partially_issued"
      })
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
  }, [requests, displayStatuses])

  const awaiting = useMemo(() => {
    return [...requests]
      .filter((r) => displayStatuses[r.id] === "awaiting_approval")
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
  }, [requests, displayStatuses])

  const [busyId, setBusyId] = useState<string | null>(null)
  const [rejectId, setRejectId] = useState<string | null>(null)
  const [rejectCode, setRejectCode] = useState<RejectReasonCode | "">("")
  const [rejectNote, setRejectNote] = useState("")

  if (toIssue.length === 0 && awaiting.length === 0) {
    // Parent on /requests reserves a fixed-height slot (PF1c CLS).
    return null
  }

  async function onApprove(id: string) {
    setBusyId(id)
    try {
      await approveNotInvoiced(getSupabaseClient(), id)
      toast.success("00000 approved.")
      onChanged?.()
    } catch (e) {
      toastFromCaughtError(e, "Could not approve")
    } finally {
      setBusyId(null)
    }
  }

  async function onReject() {
    if (!rejectId || !rejectCode) {
      toast.error("Pick a rejection reason.")
      return
    }
    if (rejectCode === "other" && !rejectNote.trim()) {
      toast.error("Explain the rejection when the reason is Other.")
      return
    }
    setBusyId(rejectId)
    try {
      await rejectRequest(getSupabaseClient(), rejectId, rejectCode, rejectNote.trim() || null)
      toast.success("Request rejected.")
      setRejectId(null)
      setRejectCode("")
      setRejectNote("")
      onChanged?.()
    } catch (e) {
      toastFromCaughtError(e, "Could not reject")
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      {toIssue.length > 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">To issue ({toIssue.length})</CardTitle>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Request</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Requester</TableHead>
                  <TableHead>Items</TableHead>
                  <TableHead>Waiting</TableHead>
                  <TableHead />
                  <TableHead className="w-[120px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {toIssue.map((r) => {
                  const days = ageInDays(r.created_at, today)
                  const fortinet = requestIsAllFortinet(r.stock_request_lines ?? [])
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium whitespace-nowrap tabular-nums">
                        <div className="flex flex-wrap items-center gap-2">
                          <span>{r.request_number}</span>
                          {r.atlas_link_pending ? <AtlasLinkPendingPill /> : null}
                        </div>
                        {(() => {
                          const lock = freshLocks.get(r.id)
                          if (!lock || lock.userId === user?.id) return null
                          const label = lockLabels.get(lock.userId)
                          if (!label) return null
                          return (
                            <p className="mt-0.5 text-xs font-normal text-amber-700 dark:text-amber-400">
                              Being issued by {label} ({formatIssueLockAge(lock.since)})
                            </p>
                          )
                        })()}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">{r.type}</TableCell>
                      <TableCell className="font-medium">
                        {r.client ? formatClientLabel(r.client) : r.client_id}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {requesterName(r.created_by)}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-[14rem]">
                        <span className="line-clamp-2">{requestItemsSummary(r.stock_request_lines ?? [])}</span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {days == null ? "—" : formatAgeDays(days)}
                      </TableCell>
                      <TableCell>
                        {fortinet ? (
                          <span className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium">
                            Fortinet
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Button size="sm" asChild>
                          <Link href={`/requests/${r.id}/fulfill`} className="gap-1">
                            <Truck className="size-3.5" />
                            Issue
                          </Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      {awaiting.length > 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Awaiting approval ({awaiting.length})</CardTitle>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Request</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Requester</TableHead>
                  <TableHead>Items</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-[200px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {awaiting.map((r) => {
                  const own = r.created_by === user?.id
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium whitespace-nowrap tabular-nums">
                        {r.request_number}
                      </TableCell>
                      <TableCell className="font-medium">
                        {r.client ? formatClientLabel(r.client) : r.client_id}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {requesterName(r.created_by)}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-[14rem]">
                        <span className="line-clamp-2">{requestItemsSummary(r.stock_request_lines ?? [])}</span>
                      </TableCell>
                      <TableCell>
                        <RequestStatusPill status="awaiting_approval" />
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-2">
                          {!own ? (
                            <Button
                              size="sm"
                              disabled={busyId === r.id}
                              onClick={() => void onApprove(r.id)}
                            >
                              {busyId === r.id ? <Loader2 className="size-3.5 animate-spin" /> : null}
                              Approve
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">Your request</span>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busyId === r.id}
                            onClick={() => {
                              setRejectId(r.id)
                              setRejectCode("")
                              setRejectNote("")
                            }}
                          >
                            Reject
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      <Dialog open={Boolean(rejectId)} onOpenChange={(open) => !open && setRejectId(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reject this request</DialogTitle>
            <DialogDescription>The requester sees the reason and can edit and resubmit.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-2">
              <Label>Reason</Label>
              <Select value={rejectCode || undefined} onValueChange={(v) => setRejectCode(v as RejectReasonCode)}>
                <SelectTrigger className="bg-card">
                  <SelectValue placeholder="Pick a reason…" />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(REJECT_REASON_LABELS) as RejectReasonCode[]).map((code) => (
                    <SelectItem key={code} value={code}>
                      {REJECT_REASON_LABELS[code]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="queue-reject-note">
                Note{rejectCode === "other" ? " (required)" : " (optional)"}
              </Label>
              <Textarea
                id="queue-reject-note"
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
                className="bg-card"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectId(null)}>
              Back
            </Button>
            <Button variant="destructive" disabled={Boolean(busyId)} onClick={() => void onReject()}>
              Reject request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
