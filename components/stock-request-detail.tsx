"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import { InvoiceChoiceFields } from "@/components/invoice-choice-fields"
import { RequestStatusPill } from "@/components/request-status-pill"
import { useAuth } from "@/lib/auth-context"
import {
  canCreateStockRequest,
  canFulfillStockRequests,
  canInvoiceStockRequests,
  ADMIN,
} from "@/lib/permissions"
import { getSupabaseClient } from "@/lib/supabase/client"
import { formatClientLabel } from "@/lib/client-label"
import {
  approveNotInvoiced,
  cancelRequest,
  closeOutstanding,
  fetchIssuedCountsByLineId,
  fetchIssuedSerialsForRequest,
  fetchProfileLabels,
  fetchRequestDisplayStatus,
  fetchRequestEvents,
  fetchStockRequestById,
  rejectRequest,
  setRequestInvoice,
  type IssuedSerialRow,
  type RejectReasonCode,
  type StockRequestEvent,
  type StockRequestWithRelations,
} from "@/lib/supabase/stock-requests-db"
import { invoiceChoiceProblem, type InvoiceChoice, type NotInvoicedKind } from "@/lib/invoices"
import { describeRequestEvent } from "@/lib/stock-request-events"
import {
  REJECT_REASON_LABELS,
  displayStatusOrReviewState,
  type RequestDisplayStatus,
} from "@/lib/stock-request-statuses"
import { formatDateDDMMYYYY } from "@/lib/utils"
import { toast } from "sonner"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"
import {
  isAuthFailure,
  loadErrorFromCaught,
  notifySessionExpired,
  signedOutLoadError,
} from "@/lib/unauthorized"
import { pageTitleClass } from "@/components/page-nav"
import { PageBreadcrumbs } from "@/components/page-breadcrumbs"
import {
  AlertCircle,
  Ban,
  Check,
  Copy,
  ExternalLink,
  Loader2,
  Lock,
  Pencil,
  Receipt,
  ThumbsUp,
  Truck,
  XCircle,
} from "lucide-react"
import { SignedStorageLink } from "@/components/signed-storage-link"

type Bundle = {
  request: StockRequestWithRelations | null
  displayStatus: RequestDisplayStatus | null
  issuedByLine: Record<string, number>
  serials: IssuedSerialRow[]
  events: StockRequestEvent[]
  requesterLabel: string | null
}

const EMPTY_BUNDLE: Bundle = {
  request: null,
  displayStatus: null,
  issuedByLine: {},
  serials: [],
  events: [],
  requesterLabel: null,
}

async function fetchBundle(requestId: string): Promise<Bundle> {
  const sb = getSupabaseClient()
  const request = await fetchStockRequestById(sb, requestId)
  if (!request) return EMPTY_BUNDLE
  const lineIds = (request.stock_request_lines ?? []).map((l) => l.id)
  const [displayStatus, issuedByLine, serials, events, labels] = await Promise.all([
    fetchRequestDisplayStatus(sb, requestId).catch(() => null),
    fetchIssuedCountsByLineId(sb, lineIds),
    fetchIssuedSerialsForRequest(sb, requestId).catch(() => [] as IssuedSerialRow[]),
    fetchRequestEvents(sb, requestId).catch(() => [] as StockRequestEvent[]),
    fetchProfileLabels(sb, [request.created_by]),
  ])
  return {
    request,
    displayStatus,
    issuedByLine,
    serials,
    events,
    requesterLabel: labels.get(request.created_by) ?? null,
  }
}

async function copyLines(values: string[], what: string) {
  try {
    await navigator.clipboard.writeText(values.join("\n"))
    toast.success(`Copied ${values.length} ${what}${values.length === 1 ? "" : "s"}`)
  } catch {
    toast.error("Could not copy to the clipboard")
  }
}

function invoiceSummary(row: StockRequestWithRelations): string {
  if (row.invoice_status === "invoiced") return `Invoice ${row.invoice_number ?? "—"}`
  if (row.invoice_status === "pending") return "Invoice pending"
  const kind = row.not_invoiced_kind ? ` (${row.not_invoiced_kind})` : ""
  const approval = row.invoice_approval === "approved" ? "approved" : "awaiting approval"
  return `00000 — not invoiced${kind}, ${approval}`
}

export function StockRequestDetail({ requestId }: { requestId: string }) {
  const router = useRouter()
  const { user, role } = useAuth()
  const [bundle, setBundle] = useState<Bundle>(EMPTY_BUNDLE)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadedForId, setLoadedForId] = useState(requestId)
  if (requestId !== loadedForId) {
    setLoadedForId(requestId)
    setLoading(true)
    setLoadError(null)
    setBundle(EMPTY_BUNDLE)
  }

  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelReason, setCancelReason] = useState("")
  const [closeOpen, setCloseOpen] = useState(false)
  const [closeReason, setCloseReason] = useState("")
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectCode, setRejectCode] = useState<RejectReasonCode | "">("")
  const [rejectNote, setRejectNote] = useState("")

  const [invChoice, setInvChoice] = useState<InvoiceChoice | "">("")
  const [invNumber, setInvNumber] = useState("")
  const [invReason, setInvReason] = useState("")
  const [invKind, setInvKind] = useState<NotInvoicedKind | "">("")

  const applyBundle = useCallback(async (opts?: { isCancelled?: () => boolean }) => {
    const isCancelled = opts?.isCancelled ?? (() => false)
    try {
      const next = await fetchBundle(requestId)
      if (isCancelled()) return
      if (!next.request) {
        const sessionErr = await signedOutLoadError(getSupabaseClient())
        if (isCancelled()) return
        if (sessionErr) {
          setLoadError(sessionErr)
          setBundle(EMPTY_BUNDLE)
          return
        }
      }
      setLoadError(null)
      setBundle(next)
    } catch (e) {
      if (isCancelled()) return
      if (isAuthFailure(e)) notifySessionExpired()
      else toastFromCaughtError(e, "Could not load request")
      setLoadError(loadErrorFromCaught(e, "Could not load this request."))
      setBundle(EMPTY_BUNDLE)
    } finally {
      if (!isCancelled()) setLoading(false)
    }
  }, [requestId])

  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- applyBundle is async; setState is after await
    void applyBundle({ isCancelled: () => cancelled })
    return () => {
      cancelled = true
    }
  }, [applyBundle])

  const { request: row, issuedByLine, serials, events } = bundle
  const lines = useMemo(() => row?.stock_request_lines ?? [], [row])

  const totals = useMemo(() => {
    let requested = 0
    let issued = 0
    for (const l of lines) {
      requested += l.quantity_requested
      issued += Math.min(l.quantity_requested, issuedByLine[l.id] ?? 0)
    }
    return { requested, issued, outstanding: Math.max(0, requested - issued) }
  }, [lines, issuedByLine])

  const displayStatus: RequestDisplayStatus | null = row
    ? (bundle.displayStatus ?? displayStatusOrReviewState(null, row.review_state))
    : null

  const isOwner = Boolean(user?.id && row?.created_by === user.id)
  const isAdmin = role === ADMIN
  const state = row?.review_state ?? null
  const live = state === "submitted" || state === "awaiting_approval"

  const canResubmit = state === "rejected" && isOwner && canCreateStockRequest(role)
  const canCancel =
    Boolean(row) &&
    state !== "cancelled" &&
    state !== "closed" &&
    ((isOwner && role !== "viewer" && totals.issued === 0 && (live || state === "rejected")) ||
      (isAdmin && displayStatus !== "completed"))
  const allFortinet = lines.length > 0 && lines.every((l) => (l.vendor ?? "").trim().toLowerCase() === "fortinet")
  const canIssue =
    state === "submitted" &&
    totals.outstanding > 0 &&
    canFulfillStockRequests(role) &&
    (isAdmin || allFortinet)
  const awaitingApproval =
    row?.invoice_status === "not_invoiced" && row.invoice_approval === "awaiting" && live
  const canApprove =
    isAdmin &&
    awaitingApproval &&
    row?.created_by !== user?.id &&
    row?.invoice_entered_by !== user?.id
  const selfApprovalBlocked =
    isAdmin && awaitingApproval && (row?.created_by === user?.id || row?.invoice_entered_by === user?.id)
  const canReject = isAdmin && live && totals.issued === 0
  const canClose = isAdmin && state === "submitted" && totals.issued > 0 && totals.outstanding > 0
  const canAddInvoice =
    row?.invoice_status === "pending" &&
    state !== "cancelled" &&
    state !== "rejected" &&
    role !== "viewer" &&
    (isOwner || canInvoiceStockRequests(role))
  const canBilling =
    canInvoiceStockRequests(role) && Boolean(row) && state !== "cancelled" && state !== "rejected"

  async function run(action: () => Promise<void>, success: string, failure: string): Promise<boolean> {
    setBusy(true)
    try {
      await action()
      toast.success(success)
      await applyBundle()
      router.refresh()
      return true
    } catch (e) {
      toastFromCaughtError(e, failure)
      return false
    } finally {
      setBusy(false)
    }
  }

  async function onCancel() {
    if (!row) return
    const ok = await run(
      () => cancelRequest(getSupabaseClient(), row.id, cancelReason.trim() || null),
      "Request cancelled.",
      "Could not cancel"
    )
    if (ok) {
      setCancelOpen(false)
      setCancelReason("")
    }
  }

  async function onClose() {
    if (!row) return
    if (closeReason.trim().length < 15) {
      toast.error("Give a reason of at least 15 characters.")
      return
    }
    const ok = await run(
      () => closeOutstanding(getSupabaseClient(), row.id, closeReason.trim()),
      "Outstanding units closed.",
      "Could not close outstanding units"
    )
    if (ok) {
      setCloseOpen(false)
      setCloseReason("")
    }
  }

  async function onReject() {
    if (!row || !rejectCode) {
      toast.error("Pick a rejection reason.")
      return
    }
    if (rejectCode === "other" && !rejectNote.trim()) {
      toast.error("Explain the rejection when the reason is Other.")
      return
    }
    const ok = await run(
      () => rejectRequest(getSupabaseClient(), row.id, rejectCode, rejectNote.trim() || null),
      "Request rejected.",
      "Could not reject"
    )
    if (ok) {
      setRejectOpen(false)
      setRejectCode("")
      setRejectNote("")
    }
  }

  async function onApprove() {
    if (!row) return
    await run(() => approveNotInvoiced(getSupabaseClient(), row.id), "00000 approved.", "Could not approve")
  }

  async function onAddInvoice() {
    if (!row) return
    if (invChoice === "" || invChoice === "pending") {
      toast.error("Enter an invoice number, or mark the request 00000.")
      return
    }
    const problem = invoiceChoiceProblem(invChoice, invNumber, invReason, invKind)
    if (problem) {
      toast.error(problem)
      return
    }
    const ok = await run(
      () =>
        setRequestInvoice(getSupabaseClient(), row.id, {
          invoiceChoice: invChoice,
          invoiceNumber: invChoice === "number" ? invNumber.trim() : null,
          notInvoicedReason: invChoice === "not_invoiced" ? invReason.trim() : null,
          notInvoicedKind: invChoice === "not_invoiced" ? invKind || null : null,
        }),
      "Invoice saved.",
      "Could not save invoice"
    )
    if (ok) {
      setInvChoice("")
      setInvNumber("")
      setInvReason("")
      setInvKind("")
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground gap-2">
        <Loader2 className="size-5 animate-spin" />
        Loading…
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="flex flex-col gap-4">
        <PageBreadcrumbs items={[{ label: "Requests", href: "/requests" }, { label: requestId.slice(0, 8) }]} />
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
      </div>
    )
  }

  if (!row) {
    return (
      <div className="flex flex-col gap-4">
        <PageBreadcrumbs items={[{ label: "Requests", href: "/requests" }, { label: requestId.slice(0, 8) }]} />
        <p className="text-sm text-muted-foreground">Request not found or you don’t have access.</p>
      </div>
    )
  }

  const serialValues = serials.map((s) => s.serial)
  /** One line per unit: product, serial, and the cloud key when the kit has one. */
  const descriptionValues = serials.map(
    (s) => `${s.productName} — ${s.serial}${s.cloudKey ? ` — cloud key ${s.cloudKey}` : ""}`
  )
  const rejectDetail =
    row.reject_reason_code != null
      ? `${REJECT_REASON_LABELS[row.reject_reason_code] ?? row.reject_reason_code}${
          row.reject_note ? ` — ${row.reject_note}` : ""
        }`
      : null

  return (
    <div className="flex flex-col gap-6 min-w-0 max-w-4xl w-full pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <div className="flex flex-col gap-2 min-w-0 items-start">
        <PageBreadcrumbs
          items={[{ label: "Requests", href: "/requests" }, { label: row.request_number }]}
        />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between w-full min-w-0">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className={pageTitleClass}>
                {row.request_number} · {row.type} request
              </h1>
              <RequestStatusPill status={displayStatus} />
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              {row.client ? formatClientLabel(row.client) : row.client_id} · Created{" "}
              {formatDateDDMMYYYY(row.created_at)}
              {bundle.requesterLabel ? ` by ${bundle.requesterLabel}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 shrink-0">
            {canResubmit && (
              <Button size="sm" asChild className="gap-1">
                <Link href={`/requests/${row.id}/edit`}>
                  <Pencil className="size-3.5" />
                  Edit and resubmit
                </Link>
              </Button>
            )}
            {canIssue && (
              <Button size="sm" asChild className="gap-1">
                <Link href={`/requests/${row.id}/fulfill`}>
                  <Truck className="size-3.5" />
                  Issue units
                </Link>
              </Button>
            )}
            {canApprove && (
              <Button size="sm" variant="secondary" className="gap-1" disabled={busy} onClick={() => void onApprove()}>
                <ThumbsUp className="size-3.5" />
                Approve 00000
              </Button>
            )}
            {canReject && (
              <Button size="sm" variant="outline" className="gap-1" disabled={busy} onClick={() => setRejectOpen(true)}>
                <XCircle className="size-3.5" />
                Reject
              </Button>
            )}
            {canClose && (
              <Button size="sm" variant="outline" className="gap-1" disabled={busy} onClick={() => setCloseOpen(true)}>
                <Lock className="size-3.5" />
                Close outstanding
              </Button>
            )}
            {canBilling && (
              <Button variant="outline" size="sm" asChild className="gap-1">
                <Link href={`/requests/${row.id}/billing`}>
                  <Receipt className="size-3.5" />
                  Invoice
                </Link>
              </Button>
            )}
            {canCancel && (
              <Button variant="destructive" size="sm" className="gap-1" disabled={busy} onClick={() => setCancelOpen(true)}>
                <Ban className="size-3.5" />
                Cancel
              </Button>
            )}
          </div>
        </div>
      </div>

      {state === "rejected" && rejectDetail ? (
        <div
          role="alert"
          className="flex gap-3 rounded-lg border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger"
        >
          <AlertCircle className="size-5 shrink-0" />
          <div className="flex flex-col gap-0.5">
            <p>
              <span className="font-medium">Rejected:</span> {rejectDetail}
            </p>
            {canResubmit ? <p>Fix what was asked for, then edit and resubmit.</p> : null}
          </div>
        </div>
      ) : null}

      {selfApprovalBlocked ? (
        <p className="text-sm text-muted-foreground">
          This 00000 is waiting for another admin: you cannot approve a 00000 you requested or entered.
        </p>
      ) : null}

      <Card>
        <CardContent className="grid gap-3 pt-6 text-sm sm:grid-cols-2">
          <div>
            <p className="text-xs text-muted-foreground">Type</p>
            <p>{row.type}</p>
          </div>
          {row.return_date ? (
            <div>
              <p className="text-xs text-muted-foreground">Return date</p>
              <p>{formatDateDDMMYYYY(row.return_date)}</p>
            </div>
          ) : null}
          <div>
            <p className="text-xs text-muted-foreground">Invoice</p>
            <p>{invoiceSummary(row)}</p>
            {row.not_invoiced_reason ? (
              <p className="text-xs text-muted-foreground mt-0.5">{row.not_invoiced_reason}</p>
            ) : null}
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Atlas task</p>
            {row.atlas_task_url ? (
              <a
                href={row.atlas_task_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand inline-flex items-center gap-1"
              >
                Open in Atlas
                <ExternalLink className="size-3.5" />
              </a>
            ) : (
              <p className="text-muted-foreground">—</p>
            )}
          </div>
          {row.quotation_url ? (
            <div>
              <p className="text-xs text-muted-foreground">Quotation</p>
              <SignedStorageLink
                path={row.quotation_url}
                className="text-brand inline-flex items-center gap-1 w-fit"
              >
                View quotation
                <ExternalLink className="size-3.5" />
              </SignedStorageLink>
            </div>
          ) : null}
          {row.cancel_reason && state === "cancelled" ? (
            <div className="sm:col-span-2">
              <p className="text-xs text-muted-foreground">Cancelled because</p>
              <p>{row.cancel_reason}</p>
            </div>
          ) : null}
          {row.closed_reason && state === "closed" ? (
            <div className="sm:col-span-2">
              <p className="text-xs text-muted-foreground">Outstanding closed because</p>
              <p>{row.closed_reason}</p>
            </div>
          ) : null}
          {row.notes ? (
            <div className="sm:col-span-2">
              <p className="text-xs text-muted-foreground">Notes</p>
              <p className="whitespace-pre-wrap">{row.notes}</p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center justify-between gap-2">
            <span>Lines</span>
            <span className="text-xs font-normal text-muted-foreground tabular-nums">
              Issued {totals.issued} of {totals.requested}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Requested</TableHead>
                <TableHead className="text-right">Issued</TableHead>
                {isAdmin ? <TableHead>Needs</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((l) => {
                const got = Math.min(l.quantity_requested, issuedByLine[l.id] ?? 0)
                const needs = [l.requires_serial ? "serial" : null, l.requires_cloud_key ? "cloud key" : null]
                  .filter(Boolean)
                  .join(" + ")
                return (
                  <TableRow key={l.id}>
                    <TableCell className="font-medium">{l.product_name}</TableCell>
                    <TableCell className="text-right tabular-nums">{l.quantity_requested}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {got} of {l.quantity_requested}
                    </TableCell>
                    {isAdmin ? (
                      <TableCell className="text-xs text-muted-foreground">{needs || "—"}</TableCell>
                    ) : null}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {serials.length > 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
              <span>Issued serials</span>
              <span className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="min-h-11 w-full gap-1 sm:w-auto"
                  onClick={() => void copyLines(descriptionValues, "description")}
                >
                  <Copy className="size-3.5" />
                  Copy descriptions
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="min-h-11 w-full gap-1 sm:w-auto"
                  onClick={() => void copyLines(serialValues, "serial")}
                >
                  <Copy className="size-3.5" />
                  Copy serials only
                </Button>
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Serial</TableHead>
                  <TableHead>Cloud key</TableHead>
                  <TableHead>Issued</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {serials.map((s) => (
                  <TableRow key={s.transactionId}>
                    <TableCell>{s.productName}</TableCell>
                    <TableCell className="font-mono text-xs">{s.serial}</TableCell>
                    <TableCell className="font-mono text-xs">{s.cloudKey ?? "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {s.issuedAt ? formatDateDDMMYYYY(s.issuedAt) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      {canAddInvoice ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Add invoice</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 max-w-md w-full min-w-0">
            <p className="text-sm text-muted-foreground">
              The invoice is still pending. Enter the number as soon as it exists, or mark the request 00000.
            </p>
            <InvoiceChoiceFields
              idPrefix="rq-detail-invoice"
              choice={invChoice}
              invoiceNumber={invNumber}
              reason={invReason}
              kind={invKind}
              onChoice={setInvChoice}
              onInvoiceNumber={setInvNumber}
              onReason={setInvReason}
              onKind={setInvKind}
            />
            <Button
              className="min-h-11 w-full gap-1 sm:w-fit"
              disabled={busy}
              onClick={() => void onAddInvoice()}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
              Add invoice number
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No activity recorded.</p>
          ) : (
            <ol className="flex flex-col gap-3 border-l border-border pl-4">
              {events.map((event) => {
                const view = describeRequestEvent(event)
                return (
                  <li key={event.id} className="relative text-sm">
                    <span
                      className="absolute -left-[1.3rem] top-1.5 size-2 rounded-full bg-brand"
                      aria-hidden
                    />
                    <p className="font-medium text-foreground">{view.title}</p>
                    {view.detail ? <p className="text-muted-foreground">{view.detail}</p> : null}
                    <p className="text-xs text-muted-foreground">
                      {formatDateDDMMYYYY(event.created_at)}
                      {event.created_at ? ` ${new Date(event.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
                      {event.actor_id === user?.id ? " · You" : event.actorLabel ? ` · ${event.actorLabel}` : ""}
                    </p>
                  </li>
                )
              })}
            </ol>
          )}
        </CardContent>
      </Card>

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel this request?</DialogTitle>
            <DialogDescription>
              {isOwner ? "The request stops here." : "The requester is notified."} A reason is optional.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="cancel-reason">Reason</Label>
            <Textarea
              id="cancel-reason"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              className="bg-card"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setCancelOpen(false)}>
              Keep request
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void onCancel()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Cancel request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={closeOpen} onOpenChange={setCloseOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Close outstanding units</DialogTitle>
            <DialogDescription>
              {totals.outstanding} unit{totals.outstanding === 1 ? "" : "s"} will never be issued. Units already
              issued stay issued.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="close-reason">Reason (at least 15 characters)</Label>
            <Textarea
              id="close-reason"
              value={closeReason}
              onChange={(e) => setCloseReason(e.target.value)}
              className="bg-card"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setCloseOpen(false)}>
              Back
            </Button>
            <Button disabled={busy} onClick={() => void onClose()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Close outstanding
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
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
              <Label htmlFor="reject-note">
                Note{rejectCode === "other" ? " (required)" : " (optional)"}
              </Label>
              <Textarea
                id="reject-note"
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
                className="bg-card"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setRejectOpen(false)}>
              Back
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void onReject()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Reject request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
