"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { StatusPill } from "@/components/fs/status-pill"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useAuth } from "@/lib/auth-context"
import {
  canFulfillStockRequests,
  canInvoiceStockRequests,
  canCreateStockRequest,
} from "@/lib/permissions"
import { getSupabaseClient } from "@/lib/supabase/client"
import { formatClientLabel } from "@/lib/client-label"
import {
  cancelStockRequest,
  fetchAssignedCountsByLineId,
  fetchAvailabilityByProductIds,
  fetchStockRequestById,
  markRequestInProgress,
  revertStockRequestToDraft,
  submitStockRequest,
  updateDraftRequest,
  uploadQuotationForRequest,
  type StockRequestWithRelations,
} from "@/lib/supabase/stock-requests-db"
import { lineRequiresSerialAssignment } from "@/lib/stock-request-rules"
import {
  allowedTransitions,
  isStockRequestStatus,
  type StockRequestStatus,
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
  ExternalLink,
  FileUp,
  Loader2,
  Pencil,
  Truck,
  Receipt,
  Ban,
  Send,
  Play,
  RotateCcw,
  Undo2,
} from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SignedStorageLink } from "@/components/signed-storage-link"

export function StockRequestDetail({ requestId }: { requestId: string }) {
  const router = useRouter()
  const { user, role } = useAuth()
  const [row, setRow] = useState<StockRequestWithRelations | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [avail, setAvail] = useState<Record<string, number>>({})
  const [assigned, setAssigned] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState(false)
  const [quoteUploading, setQuoteUploading] = useState(false)
  const [loadedForId, setLoadedForId] = useState(requestId)
  if (requestId !== loadedForId) {
    setLoadedForId(requestId)
    setLoading(true)
    setLoadError(null)
    setRow(null)
    setAvail({})
    setAssigned({})
  }

  const fetchRequestBundle = useCallback(async () => {
    const sb = getSupabaseClient()
    const r = await fetchStockRequestById(sb, requestId)
    if (!r?.stock_request_lines?.length) {
      return { r, avail: {} as Record<string, number>, assigned: {} as Record<string, number> }
    }
    const productIds = r.stock_request_lines.map((l) => l.product_id)
    const [a, asg] = await Promise.all([
      fetchAvailabilityByProductIds(sb, productIds),
      fetchAssignedCountsByLineId(
        sb,
        r.stock_request_lines.map((l) => l.id)
      ),
    ])
    return { r, avail: a, assigned: asg }
  }, [requestId])

  const load = useCallback(async () => {
    try {
      const bundle = await fetchRequestBundle()
      if (!bundle.r) {
        const sessionErr = await signedOutLoadError(getSupabaseClient())
        if (sessionErr) {
          setLoadError(sessionErr)
          setRow(null)
          return
        }
      }
      setLoadError(null)
      setRow(bundle.r)
      setAvail(bundle.avail)
      setAssigned(bundle.assigned)
    } catch (e) {
      if (isAuthFailure(e)) notifySessionExpired()
      else toastFromCaughtError(e, "Could not load request")
      setLoadError(loadErrorFromCaught(e, "Could not load this request."))
      setRow(null)
    } finally {
      setLoading(false)
    }
  }, [fetchRequestBundle])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const bundle = await fetchRequestBundle()
        if (cancelled) return
        if (!bundle.r) {
          const sessionErr = await signedOutLoadError(getSupabaseClient())
          if (cancelled) return
          if (sessionErr) {
            setLoadError(sessionErr)
            setRow(null)
            return
          }
        }
        setLoadError(null)
        setRow(bundle.r)
        setAvail(bundle.avail)
        setAssigned(bundle.assigned)
      } catch (e) {
        if (!cancelled) {
          if (isAuthFailure(e)) notifySessionExpired()
          else toastFromCaughtError(e, "Could not load request")
          setLoadError(loadErrorFromCaught(e, "Could not load this request."))
          setRow(null)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [fetchRequestBundle])

  const isOwner = Boolean(user?.id && row?.created_by === user.id)
  const status: StockRequestStatus | null =
    row && isStockRequestStatus(row.status) ? row.status : null
  const transitions = status ? allowedTransitions(status, role, isOwner) : []

  const canEditDraft = row?.status === "draft" && isOwner && canCreateStockRequest(role)
  const canSubmitDraft = transitions.includes("submitted")
  const canReturnDraft = transitions.includes("draft") && status === "submitted"
  const canCancel =
    transitions.includes("cancelled") &&
    (status === "draft" || status === "submitted" || status === "in_progress")
  const canStartWork = transitions.includes("in_progress") && status === "submitted"
  const canReopenWork = transitions.includes("in_progress") && status === "serviced"
  const showFulfill =
    row &&
    (row.status === "submitted" || row.status === "in_progress") &&
    canFulfillStockRequests(role)
  const showBilling =
    row &&
    ((row.status === "serviced" && transitions.includes("invoiced")) ||
      row.status === "invoiced") &&
    canInvoiceStockRequests(role)

  async function onSubmitDraft() {
    if (!row || !canSubmitDraft) return
    setBusy(true)
    try {
      const sb = getSupabaseClient()
      await submitStockRequest(sb, row.id)
      toast.success("Request submitted.")
      await load()
      router.refresh()
    } catch (e) {
      toastFromCaughtError(e, "Could not submit")
    } finally {
      setBusy(false)
    }
  }

  async function onReturnDraft() {
    if (!row || !canReturnDraft) return
    setBusy(true)
    try {
      const sb = getSupabaseClient()
      await revertStockRequestToDraft(sb, row.id)
      toast.success("Returned to draft.")
      await load()
      router.refresh()
    } catch (e) {
      toastFromCaughtError(e, "Could not return to draft")
    } finally {
      setBusy(false)
    }
  }

  async function onCancel() {
    if (!row || !canCancel || !status) return
    if (status !== "draft" && status !== "submitted" && status !== "in_progress") return
    setBusy(true)
    try {
      const sb = getSupabaseClient()
      await cancelStockRequest(sb, row.id, status)
      toast.success("Request cancelled.")
      await load()
      router.refresh()
    } catch (e) {
      toastFromCaughtError(e, "Could not cancel")
    } finally {
      setBusy(false)
    }
  }

  async function onStartWork() {
    if (!row || !canStartWork) return
    setBusy(true)
    try {
      const sb = getSupabaseClient()
      await markRequestInProgress(sb, row.id, "submitted")
      toast.success("Marked in progress.")
      await load()
      router.refresh()
    } catch (e) {
      toastFromCaughtError(e, "Could not update status")
    } finally {
      setBusy(false)
    }
  }

  async function onReopenWork() {
    if (!row || !canReopenWork) return
    setBusy(true)
    try {
      const sb = getSupabaseClient()
      await markRequestInProgress(sb, row.id, "serviced")
      toast.success("Reopened for fulfillment.")
      await load()
      router.refresh()
    } catch (e) {
      toastFromCaughtError(e, "Could not reopen request")
    } finally {
      setBusy(false)
    }
  }

  async function onQuoteFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file || !row || row.status !== "draft") return
    setQuoteUploading(true)
    try {
      const sb = getSupabaseClient()
      const url = await uploadQuotationForRequest(row.id, file)
      await updateDraftRequest(sb, row.id, { quotationUrl: url })
      toast.success("Quotation uploaded.")
      await load()
    } catch (err) {
      toastFromCaughtError(err, "Could not upload quotation")
    } finally {
      setQuoteUploading(false)
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
        <PageBreadcrumbs items={[{ label: "Requests", href: "/requests" }, { label: requestId }]} />
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
      </div>
    )
  }

  if (!row) {
    return (
      <div className="flex flex-col gap-4">
        <PageBreadcrumbs items={[{ label: "Requests", href: "/requests" }, { label: requestId }]} />
        <p className="text-sm text-muted-foreground">Request not found or you don’t have access.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 min-w-0 max-w-4xl">
      <div className="flex flex-col gap-2 min-w-0 items-start">
        <PageBreadcrumbs items={[{ label: "Requests", href: "/requests" }, { label: requestId }]} />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between w-full min-w-0">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className={pageTitleClass}>Request</h1>
              <StatusPill value={row.status} />
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              {row.client ? (
                <>
                  {formatClientLabel(row.client)}
                </>
              ) : (
                row.client_id
              )}{" "}
              · Created {formatDateDDMMYYYY(row.created_at)}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 shrink-0">
          {canEditDraft && (
            <Button variant="outline" size="sm" asChild className="gap-1">
              <Link href={`/requests/${row.id}/edit`}>
                <Pencil className="size-3.5" />
                Edit draft
              </Link>
            </Button>
          )}
          {canSubmitDraft && (
            <Button size="sm" className="gap-1" disabled={busy} onClick={() => void onSubmitDraft()}>
              <Send className="size-3.5" />
              Submit
            </Button>
          )}
          {canReturnDraft && (
            <Button variant="outline" size="sm" className="gap-1" disabled={busy} onClick={() => void onReturnDraft()}>
              <Undo2 className="size-3.5" />
              Return to draft
            </Button>
          )}
          {canStartWork && (
            <Button variant="secondary" size="sm" className="gap-1" disabled={busy} onClick={() => void onStartWork()}>
              <Play className="size-3.5" />
              Start work
            </Button>
          )}
          {canReopenWork && (
            <Button variant="secondary" size="sm" className="gap-1" disabled={busy} onClick={() => void onReopenWork()}>
              <RotateCcw className="size-3.5" />
              Reopen for work
            </Button>
          )}
          {showFulfill && (
            <Button size="sm" asChild className="gap-1">
              <Link href={`/requests/${row.id}/fulfill`}>
                <Truck className="size-3.5" />
                Fulfill
              </Link>
            </Button>
          )}
          {showBilling && (
            <Button variant="outline" size="sm" asChild className="gap-1">
              <Link href={`/requests/${row.id}/billing`}>
                <Receipt className="size-3.5" />
                Billing
              </Link>
            </Button>
          )}
          {canCancel && (
            <Button variant="destructive" size="sm" className="gap-1" disabled={busy} onClick={() => void onCancel()}>
              <Ban className="size-3.5" />
              Cancel
            </Button>
          )}
          </div>
        </div>
      </div>

      {row.status === "draft" && canEditDraft && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Quotation</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Label className="text-xs text-muted-foreground flex items-center gap-2">
              <FileUp className="size-3.5" />
              Upload or replace PDF
            </Label>
            <Input
              type="file"
              accept=".pdf,image/jpeg,image/png,image/webp,application/pdf"
              disabled={quoteUploading}
              className="cursor-pointer text-sm max-w-md"
              onChange={(e) => void onQuoteFile(e)}
            />
            {row.quotation_url && (
              <SignedStorageLink
                path={row.quotation_url}
                className="text-sm text-brand inline-flex items-center gap-1 w-fit"
              >
                Current file
                <ExternalLink className="size-3.5" />
              </SignedStorageLink>
            )}
          </CardContent>
        </Card>
      )}

      {row.quotation_url && row.status !== "draft" && (
        <SignedStorageLink
          path={row.quotation_url}
          className="text-sm text-brand inline-flex items-center gap-1 w-fit"
        >
          View quotation
          <ExternalLink className="size-3.5" />
        </SignedStorageLink>
      )}

      {row.notes ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Notes</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-foreground whitespace-pre-wrap">{row.notes}</CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Lines</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Available</TableHead>
                <TableHead className="text-right">Assigned</TableHead>
                <TableHead>Serial rule</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(row.stock_request_lines ?? []).map((l) => {
                const needSerial = lineRequiresSerialAssignment(l)
                const a = avail[l.product_id] ?? 0
                const g = assigned[l.id] ?? 0
                return (
                  <TableRow key={l.id}>
                    <TableCell className="font-medium">{l.product_name}</TableCell>
                    <TableCell className="text-right">{l.quantity_requested}</TableCell>
                    <TableCell className="text-right tabular-nums">{a}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {g}/{l.quantity_requested}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {needSerial ? "Serial-tracked: full serial count before serviced" : "Optional before serviced"}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {row.serviced_at && (row.status === "serviced" || row.status === "invoiced") ? (
        <p className="text-xs text-muted-foreground">Serviced {formatDateDDMMYYYY(row.serviced_at)}</p>
      ) : null}
      {row.status === "invoiced" && row.invoice_number ? (
        <p className="text-xs text-muted-foreground">
          Invoice {row.invoice_number}
          {row.invoiced_at ? ` · ${formatDateDDMMYYYY(row.invoiced_at)}` : ""}
        </p>
      ) : null}
    </div>
  )
}
