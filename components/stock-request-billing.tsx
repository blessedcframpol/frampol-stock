"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useAuth } from "@/lib/auth-context"
import { getSupabaseClient } from "@/lib/supabase/client"
import { formatClientLabel } from "@/lib/client-label"
import {
  fetchAssignedCountsByLineId,
  fetchStockRequestById,
  markRequestInvoiced,
  uploadInvoiceDocumentForRequest,
  type StockRequestWithRelations,
} from "@/lib/supabase/stock-requests-db"
import { canMarkRequestInvoiced, lineRequiresSerialAssignment } from "@/lib/stock-request-rules"
import { formatDateDDMMYYYY } from "@/lib/utils"
import { toast } from "sonner"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"
import {
  isAuthFailure,
  loadErrorFromCaught,
  notifySessionExpired,
  signedOutLoadError,
} from "@/lib/unauthorized"
import { AlertCircle, ExternalLink, Loader2 } from "lucide-react"
import { PageHeader } from "@/components/page-nav"
import { PageBreadcrumbs } from "@/components/page-breadcrumbs"
import { SignedStorageLink } from "@/components/signed-storage-link"
import { canInvoiceStockRequests } from "@/lib/permissions"

export function StockRequestBilling({ requestId }: { requestId: string }) {
  const router = useRouter()
  const { user, role } = useAuth()
  const canInvoice = canInvoiceStockRequests(role)
  const [row, setRow] = useState<StockRequestWithRelations | null>(null)
  const [assigned, setAssigned] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadedForId, setLoadedForId] = useState(requestId)
  if (requestId !== loadedForId) {
    setLoadedForId(requestId)
    setLoading(true)
    setLoadError(null)
    setRow(null)
    setAssigned({})
  }
  const [invoiceNumber, setInvoiceNumber] = useState("")
  const [busy, setBusy] = useState(false)
  const [file, setFile] = useState<File | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const sb = getSupabaseClient()
        const r = await fetchStockRequestById(sb, requestId)
        if (cancelled) return
        if (!r) {
          const sessionErr = await signedOutLoadError(sb)
          if (cancelled) return
          if (sessionErr) {
            setLoadError(sessionErr)
            setRow(null)
            return
          }
        }
        setLoadError(null)
        setRow(r)
        if (r?.stock_request_lines?.length) {
          const asg = await fetchAssignedCountsByLineId(
            sb,
            r.stock_request_lines.map((l) => l.id)
          )
          if (!cancelled) setAssigned(asg)
        } else {
          setAssigned({})
        }
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
  }, [requestId])

  const gate =
    row && row.status === "serviced"
      ? canMarkRequestInvoiced({
          lines: row.stock_request_lines ?? [],
          assignedCountByLineId: assigned,
        })
      : { ok: true as const }

  async function onSubmitInvoice(e: React.FormEvent) {
    e.preventDefault()
    if (!row || row.status !== "serviced") return
    const uid = user?.id
    if (!uid) {
      toast.error("You must be signed in.")
      return
    }
    if (!invoiceNumber.trim()) {
      toast.error("Invoice number is required.")
      return
    }
    const check = canMarkRequestInvoiced({
      lines: row.stock_request_lines ?? [],
      assignedCountByLineId: assigned,
    })
    if (!check.ok) {
      toast.error(check.message ?? "Cannot invoice yet.")
      return
    }

    setBusy(true)
    try {
      const sb = getSupabaseClient()
      let docUrl: string | null = null
      if (file) {
        docUrl = await uploadInvoiceDocumentForRequest(row.id, file)
      }
      await markRequestInvoiced(sb, row.id, {
        invoiceNumber: invoiceNumber.trim(),
        invoiceDocumentUrl: docUrl,
        invoicedBy: uid,
      })
      toast.success("Recorded as invoiced.")
      router.push(`/requests/${row.id}`)
      router.refresh()
    } catch (err) {
      toastFromCaughtError(err, "Could not record invoice")
    } finally {
      setBusy(false)
    }
  }

  if (!canInvoice) {
    return (
      <div className="flex flex-col gap-4">
        <PageBreadcrumbs
          items={[
            { label: "Requests", href: "/requests" },
            { label: requestId, href: `/requests/${requestId}` },
            { label: "Billing" },
          ]}
        />
        <p className="text-sm text-muted-foreground">
          Your account has read-only access to stock requests.
        </p>
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
        <p className="text-sm text-muted-foreground">Request not found.</p>
      </div>
    )
  }

  if (row.status !== "serviced" && row.status !== "invoiced") {
    return (
      <div className="flex flex-col gap-4 max-w-xl">
        <PageBreadcrumbs
          items={[
            { label: "Requests", href: "/requests" },
            { label: row.id, href: `/requests/${row.id}` },
            { label: "Billing" },
          ]}
        />
        <p className="text-sm text-muted-foreground">
          Billing is available once the request is serviced (current: {row.status}).
        </p>
      </div>
    )
  }

  const readOnlyInvoiced = row.status === "invoiced"

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <PageHeader
        title="Billing"
        description={row.client ? formatClientLabel(row.client) : row.client_id}
      />
      <PageBreadcrumbs
        items={[
          { label: "Requests", href: "/requests" },
          { label: row.id, href: `/requests/${row.id}` },
          { label: "Billing" },
        ]}
      />

      {row.status === "serviced" && !gate.ok && (
        <div
          role="alert"
          className="flex gap-3 rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning"
        >
          <AlertCircle className="size-5 shrink-0" />
          <p>{gate.message}</p>
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Request lines &amp; serials</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Assigned</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(row.stock_request_lines ?? []).map((l) => {
                const g = assigned[l.id] ?? 0
                const star = lineRequiresSerialAssignment(l)
                return (
                  <TableRow key={l.id}>
                    <TableCell>
                      {l.product_name}
                      {star ? (
                        <span className="block text-xs text-muted-foreground">Serial-tracked — needs full serials to invoice</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right">{l.quantity_requested}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {g}/{l.quantity_requested}
                    </TableCell>
                  </TableRow>
                )
              })}
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

      {readOnlyInvoiced ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Invoice recorded</CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-2">
            <p>
              <span className="text-muted-foreground">Invoice #:</span> {row.invoice_number ?? "—"}
            </p>
            {row.invoiced_at ? (
              <p>
                <span className="text-muted-foreground">Date:</span> {formatDateDDMMYYYY(row.invoiced_at)}
              </p>
            ) : null}
            {row.invoice_document_url ? (
              <SignedStorageLink
                path={row.invoice_document_url}
                className="text-brand inline-flex items-center gap-1"
              >
                Invoice document
                <ExternalLink className="size-3.5" />
              </SignedStorageLink>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Record invoice</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={(e) => void onSubmitInvoice(e)} className="flex flex-col gap-4 max-w-md">
              <div className="grid gap-2">
                <Label htmlFor="inv-no">Invoice number</Label>
                <Input
                  id="inv-no"
                  value={invoiceNumber}
                  onChange={(e) => setInvoiceNumber(e.target.value)}
                  className="bg-card"
                  required
                  disabled={!gate.ok}
                />
              </div>
              <div className="grid gap-2">
                <Label>Invoice PDF (optional)</Label>
                <Input
                  type="file"
                  accept=".pdf,image/jpeg,image/png,image/webp,application/pdf"
                  className="cursor-pointer text-sm"
                  disabled={!gate.ok || busy}
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    setFile(f ?? null)
                    e.target.value = ""
                  }}
                />
              </div>
              <Button type="submit" disabled={!gate.ok || busy}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                Mark invoiced
              </Button>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
