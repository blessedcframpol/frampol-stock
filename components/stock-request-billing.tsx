"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
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
import { getSupabaseClient } from "@/lib/supabase/client"
import { formatClientLabel } from "@/lib/client-label"
import {
  fetchIssuedCountsByLineId,
  fetchRequestDisplayStatus,
  fetchStockRequestById,
  setRequestInvoice,
  type StockRequestWithRelations,
} from "@/lib/supabase/stock-requests-db"
import { invoiceChoiceProblem, type InvoiceChoice, type NotInvoicedKind } from "@/lib/invoices"
import { displayStatusOrReviewState, type RequestDisplayStatus } from "@/lib/stock-request-statuses"
import { toast } from "sonner"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"
import {
  isAuthFailure,
  loadErrorFromCaught,
  notifySessionExpired,
  signedOutLoadError,
} from "@/lib/unauthorized"
import { ExternalLink, Loader2 } from "lucide-react"
import { PageHeader } from "@/components/page-nav"
import { PageBreadcrumbs } from "@/components/page-breadcrumbs"
import { SignedStorageLink } from "@/components/signed-storage-link"
import { canInvoiceStockRequests } from "@/lib/permissions"

type Loaded = {
  request: StockRequestWithRelations | null
  issuedByLine: Record<string, number>
  displayStatus: RequestDisplayStatus | null
}

const EMPTY: Loaded = { request: null, issuedByLine: {}, displayStatus: null }

async function load(requestId: string): Promise<Loaded> {
  const sb = getSupabaseClient()
  const request = await fetchStockRequestById(sb, requestId)
  if (!request) return EMPTY
  const [issuedByLine, displayStatus] = await Promise.all([
    fetchIssuedCountsByLineId(
      sb,
      request.stock_request_lines.map((l) => l.id)
    ),
    fetchRequestDisplayStatus(sb, requestId).catch(() => null),
  ])
  return { request, issuedByLine, displayStatus }
}

export function StockRequestBilling({ requestId }: { requestId: string }) {
  const router = useRouter()
  const { role } = useAuth()
  const canInvoice = canInvoiceStockRequests(role)
  const [data, setData] = useState<Loaded>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadedForId, setLoadedForId] = useState(requestId)
  if (requestId !== loadedForId) {
    setLoadedForId(requestId)
    setLoading(true)
    setLoadError(null)
    setData(EMPTY)
  }
  const [choice, setChoice] = useState<InvoiceChoice | "">("")
  const [invoiceNumber, setInvoiceNumber] = useState("")
  const [reason, setReason] = useState("")
  const [kind, setKind] = useState<NotInvoicedKind | "">("")
  const [changeReason, setChangeReason] = useState("")
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(
    async (isCancelled: () => boolean = () => false) => {
      try {
        const next = await load(requestId)
        if (isCancelled()) return
        if (!next.request) {
          const sessionErr = await signedOutLoadError(getSupabaseClient())
          if (isCancelled()) return
          if (sessionErr) {
            setLoadError(sessionErr)
            setData(EMPTY)
            return
          }
        }
        setLoadError(null)
        setData(next)
      } catch (e) {
        if (isCancelled()) return
        if (isAuthFailure(e)) notifySessionExpired()
        else toastFromCaughtError(e, "Could not load request")
        setLoadError(loadErrorFromCaught(e, "Could not load this request."))
        setData(EMPTY)
      } finally {
        if (!isCancelled()) setLoading(false)
      }
    },
    [requestId]
  )

  useEffect(() => {
    if (!canInvoice) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refresh is async; setState is after await
    void refresh(() => cancelled)
    return () => {
      cancelled = true
    }
  }, [canInvoice, refresh])

  const { request: row, issuedByLine } = data
  const crumbs = [
    { label: "Requests", href: "/requests" },
    { label: requestId, href: `/requests/${requestId}` },
    { label: "Invoice" },
  ]

  /** Everything after the first entry needs a reason when the number changes. */
  const changing = Boolean(row && row.invoice_status !== "pending" && choice === "number")
  const approvedZero = row?.invoice_status === "not_invoiced" && row.invoice_approval === "approved"

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!row || choice === "") return
    if (choice === "pending") {
      toast.error("Enter an invoice number, or mark the request 00000.")
      return
    }
    const problem = invoiceChoiceProblem(choice, invoiceNumber, reason, kind)
    if (problem) {
      toast.error(problem)
      return
    }
    if (changing && changeReason.trim().length < 15) {
      toast.error("Give a reason of at least 15 characters for changing the invoice.")
      return
    }
    setBusy(true)
    try {
      await setRequestInvoice(getSupabaseClient(), row.id, {
        invoiceChoice: choice,
        invoiceNumber: choice === "number" ? invoiceNumber.trim() : null,
        notInvoicedReason: choice === "not_invoiced" ? reason.trim() : changing ? changeReason.trim() : null,
        notInvoicedKind: choice === "not_invoiced" ? kind || null : null,
      })
      toast.success("Invoice saved.")
      router.push(`/requests/${row.id}`)
      router.refresh()
    } catch (err) {
      toastFromCaughtError(err, "Could not save invoice")
    } finally {
      setBusy(false)
    }
  }

  if (!canInvoice) {
    return (
      <div className="flex flex-col gap-4">
        <PageBreadcrumbs items={crumbs} />
        <p className="text-sm text-muted-foreground">Only admin or accounts can change a request invoice.</p>
      </div>
    )
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
        <PageBreadcrumbs items={crumbs} />
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
      </div>
    )
  }

  if (!row) {
    return (
      <div className="flex flex-col gap-4">
        <PageBreadcrumbs items={crumbs} />
        <p className="text-sm text-muted-foreground">Request not found.</p>
      </div>
    )
  }

  const displayStatus = data.displayStatus ?? displayStatusOrReviewState(null, row.review_state)
  const closedForInvoice = row.review_state === "cancelled" || row.review_state === "rejected"

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <PageHeader
        title="Invoice"
        description={row.client ? formatClientLabel(row.client) : row.client_id}
      />
      <PageBreadcrumbs items={crumbs} />

      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <RequestStatusPill status={displayStatus} />
        <span>{row.type}</span>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Lines</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Requested</TableHead>
                <TableHead className="text-right">Issued</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {row.stock_request_lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>{l.product_name}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.quantity_requested}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {Math.min(l.quantity_requested, issuedByLine[l.id] ?? 0)} of {l.quantity_requested}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {row.quotation_url && (
        <SignedStorageLink
          path={row.quotation_url}
          className="text-sm text-brand inline-flex items-center gap-1 w-fit"
        >
          Quotation
          <ExternalLink className="size-3.5" />
        </SignedStorageLink>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Current invoice</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-1">
          {row.invoice_status === "invoiced" ? (
            <p>Invoice {row.invoice_number}</p>
          ) : row.invoice_status === "pending" ? (
            <p>Invoice pending</p>
          ) : (
            <>
              <p>
                00000 — not invoiced{row.not_invoiced_kind ? ` (${row.not_invoiced_kind})` : ""},{" "}
                {row.invoice_approval === "approved" ? "approved" : "awaiting approval"}
              </p>
              {row.not_invoiced_reason ? (
                <p className="text-muted-foreground">{row.not_invoiced_reason}</p>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      {closedForInvoice ? (
        <p className="text-sm text-muted-foreground">
          The invoice cannot change on a {row.review_state} request.
        </p>
      ) : approvedZero ? (
        <p className="text-sm text-muted-foreground">This 00000 is approved and final.</p>
      ) : (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              {row.invoice_status === "pending" ? "Record invoice" : "Change invoice"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4 max-w-md">
              <InvoiceChoiceFields
                idPrefix="rq-billing"
                choice={choice}
                invoiceNumber={invoiceNumber}
                reason={reason}
                kind={kind}
                onChoice={setChoice}
                onInvoiceNumber={setInvoiceNumber}
                onReason={setReason}
                onKind={setKind}
              />
              {changing ? (
                <div className="grid gap-2">
                  <Label htmlFor="rq-billing-change">Reason for the change (at least 15 characters)</Label>
                  <Textarea
                    id="rq-billing-change"
                    value={changeReason}
                    onChange={(e) => setChangeReason(e.target.value)}
                    className="bg-card"
                  />
                </div>
              ) : null}
              <div className="flex gap-2">
                <Button type="submit" disabled={busy || choice === ""}>
                  {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                  Save invoice
                </Button>
                <Button type="button" variant="ghost" asChild disabled={busy}>
                  <Link href={`/requests/${row.id}`}>Cancel</Link>
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
