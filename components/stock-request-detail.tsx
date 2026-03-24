"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
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
  canCreateStockRequest,
  canFulfillStockRequests,
  canInvoiceStockRequests,
} from "@/lib/permissions"
import { getSupabaseClient } from "@/lib/supabase/client"
import {
  cancelStockRequest,
  fetchAssignedCountsByLineId,
  fetchAvailabilityByProductNames,
  fetchStockRequestById,
  markRequestInProgress,
  submitStockRequest,
  updateDraftRequest,
  uploadQuotationForRequest,
  type StockRequestWithRelations,
} from "@/lib/supabase/stock-requests-db"
import { lineRequiresSerialsBeforeInvoice } from "@/lib/stock-request-rules"
import { formatDateDDMMYYYY } from "@/lib/utils"
import { toast } from "sonner"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"
import {
  ArrowLeft,
  ExternalLink,
  FileUp,
  Loader2,
  Pencil,
  Truck,
  Receipt,
  Ban,
  Send,
  Play,
} from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const statusVariant: Record<string, string> = {
  draft: "bg-muted text-foreground",
  submitted: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  in_progress: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  serviced: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  invoiced: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
  cancelled: "bg-destructive/15 text-destructive",
}

export function StockRequestDetail({ requestId }: { requestId: string }) {
  const router = useRouter()
  const { user, role } = useAuth()
  const [row, setRow] = useState<StockRequestWithRelations | null>(null)
  const [loading, setLoading] = useState(true)
  const [avail, setAvail] = useState<Record<string, number>>({})
  const [assigned, setAssigned] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState(false)
  const [quoteUploading, setQuoteUploading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const sb = getSupabaseClient()
      const r = await fetchStockRequestById(sb, requestId)
      setRow(r)
      if (r?.stock_request_lines?.length) {
        const names = r.stock_request_lines.map((l) => l.product_name)
        const [a, asg] = await Promise.all([
          fetchAvailabilityByProductNames(sb, names),
          fetchAssignedCountsByLineId(
            sb,
            r.stock_request_lines.map((l) => l.id)
          ),
        ])
        setAvail(a)
        setAssigned(asg)
      } else {
        setAvail({})
        setAssigned({})
      }
    } catch (e) {
      toastFromCaughtError(e, "Could not load request")
      setRow(null)
    } finally {
      setLoading(false)
    }
  }, [requestId])

  useEffect(() => {
    void load()
  }, [load])

  const isOwner = Boolean(user?.id && row?.created_by === user.id)
  const canEditDraft = row?.status === "draft" && isOwner && canCreateStockRequest(role)
  const canCancel =
    row &&
    (row.status === "draft" || row.status === "submitted") &&
    isOwner &&
    canCreateStockRequest(role)
  const canSubmitDraft = row?.status === "draft" && isOwner && canCreateStockRequest(role)
  const showFulfill =
    row &&
    (row.status === "submitted" || row.status === "in_progress") &&
    canFulfillStockRequests(role)
  const showBilling =
    row && (row.status === "serviced" || row.status === "invoiced") && canInvoiceStockRequests(role)
  const canStartWork =
    row?.status === "submitted" && canFulfillStockRequests(role)

  async function onSubmitDraft() {
    if (!row) return
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

  async function onCancel() {
    if (!row) return
    setBusy(true)
    try {
      const sb = getSupabaseClient()
      await cancelStockRequest(sb, row.id)
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
    if (!row) return
    setBusy(true)
    try {
      const sb = getSupabaseClient()
      await markRequestInProgress(sb, row.id)
      toast.success("Marked in progress.")
      await load()
      router.refresh()
    } catch (e) {
      toastFromCaughtError(e, "Could not update status")
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
      const url = await uploadQuotationForRequest(sb, row.id, file)
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

  if (!row) {
    return (
      <div className="flex flex-col gap-4">
        <Button variant="ghost" size="sm" asChild className="w-fit gap-1">
          <Link href="/requests">
            <ArrowLeft className="size-4" />
            Requests
          </Link>
        </Button>
        <p className="text-sm text-muted-foreground">Request not found or you don’t have access.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 min-w-0 max-w-4xl">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <Button variant="ghost" size="sm" asChild className="shrink-0 -ml-2 gap-1">
            <Link href="/requests">
              <ArrowLeft className="size-4" />
              Back
            </Link>
          </Button>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight">Request</h1>
              <Badge variant="secondary" className={`text-[10px] border-0 ${statusVariant[row.status] ?? ""}`}>
                {row.status.replace("_", " ")}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              {row.client ? (
                <>
                  {row.client.name} — {row.client.company}
                </>
              ) : (
                row.client_id
              )}{" "}
              · Created {formatDateDDMMYYYY(row.created_at)}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
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
          {canStartWork && (
            <Button variant="secondary" size="sm" className="gap-1" disabled={busy} onClick={() => void onStartWork()}>
              <Play className="size-3.5" />
              Start work
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
              accept=".pdf,image/jpeg,image/png,application/pdf"
              disabled={quoteUploading}
              className="cursor-pointer text-sm max-w-md"
              onChange={(e) => void onQuoteFile(e)}
            />
            {row.quotation_url && (
              <a
                href={row.quotation_url}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-primary inline-flex items-center gap-1 w-fit"
              >
                Current file
                <ExternalLink className="size-3.5" />
              </a>
            )}
          </CardContent>
        </Card>
      )}

      {row.quotation_url && row.status !== "draft" && (
        <a
          href={row.quotation_url}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-primary inline-flex items-center gap-1 w-fit"
        >
          View quotation
          <ExternalLink className="size-3.5" />
        </a>
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
                const needSerial = lineRequiresSerialsBeforeInvoice(l.product_name, l.item_type)
                const a = avail[l.product_name] ?? 0
                const g = assigned[l.id] ?? 0
                return (
                  <TableRow key={l.id}>
                    <TableCell className="font-medium">
                      {l.product_name}
                      {l.item_type ? (
                        <span className="block text-xs text-muted-foreground font-normal">Type: {l.item_type}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right">{l.quantity_requested}</TableCell>
                    <TableCell className="text-right tabular-nums">{a}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {g}/{l.quantity_requested}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {needSerial ? "Starlink: full serial count before invoice" : "Optional before invoice"}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {row.serviced_at ? (
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
