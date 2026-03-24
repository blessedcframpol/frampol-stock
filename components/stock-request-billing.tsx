"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
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
import {
  fetchAssignedCountsByLineId,
  fetchStockRequestById,
  markRequestInvoiced,
  uploadInvoiceDocumentForRequest,
  type StockRequestWithRelations,
} from "@/lib/supabase/stock-requests-db"
import { canMarkRequestInvoiced, lineRequiresSerialsBeforeInvoice } from "@/lib/stock-request-rules"
import { formatDateDDMMYYYY } from "@/lib/utils"
import { toast } from "sonner"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"
import { AlertCircle, ArrowLeft, ExternalLink, Loader2 } from "lucide-react"

export function StockRequestBilling({ requestId }: { requestId: string }) {
  const router = useRouter()
  const { user } = useAuth()
  const [row, setRow] = useState<StockRequestWithRelations | null>(null)
  const [assigned, setAssigned] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [invoiceNumber, setInvoiceNumber] = useState("")
  const [busy, setBusy] = useState(false)
  const [file, setFile] = useState<File | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const sb = getSupabaseClient()
      const r = await fetchStockRequestById(sb, requestId)
      setRow(r)
      if (r?.stock_request_lines?.length) {
        const asg = await fetchAssignedCountsByLineId(
          sb,
          r.stock_request_lines.map((l) => l.id)
        )
        setAssigned(asg)
      } else {
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
        docUrl = await uploadInvoiceDocumentForRequest(sb, row.id, file)
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
        <p className="text-sm text-muted-foreground">Request not found.</p>
      </div>
    )
  }

  if (row.status !== "serviced" && row.status !== "invoiced") {
    return (
      <div className="flex flex-col gap-4 max-w-xl">
        <Button variant="ghost" size="sm" asChild className="w-fit gap-1">
          <Link href={`/requests/${row.id}`}>
            <ArrowLeft className="size-4" />
            Request detail
          </Link>
        </Button>
        <p className="text-sm text-muted-foreground">
          Billing is available once the request is serviced (current: {row.status}).
        </p>
      </div>
    )
  }

  const readOnlyInvoiced = row.status === "invoiced"

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" asChild className="shrink-0 -ml-2 gap-1">
          <Link href={`/requests/${row.id}`}>
            <ArrowLeft className="size-4" />
            Back
          </Link>
        </Button>
        <div>
          <h1 className="text-xl font-bold tracking-tight">Billing</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {row.client ? `${row.client.name} — ${row.client.company}` : row.client_id}
          </p>
        </div>
      </div>

      {row.status === "serviced" && !gate.ok && (
        <div
          role="alert"
          className="flex gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100"
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
                const star = lineRequiresSerialsBeforeInvoice(l.product_name, l.item_type)
                return (
                  <TableRow key={l.id}>
                    <TableCell>
                      {l.product_name}
                      {star ? (
                        <span className="block text-xs text-muted-foreground">Starlink — needs full serials to invoice</span>
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
        <a
          href={row.quotation_url}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-primary inline-flex items-center gap-1 w-fit"
        >
          Quotation
          <ExternalLink className="size-3.5" />
        </a>
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
              <a href={row.invoice_document_url} target="_blank" rel="noreferrer" className="text-primary inline-flex items-center gap-1">
                Invoice document
                <ExternalLink className="size-3.5" />
              </a>
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
                  accept=".pdf,image/jpeg,image/png,application/pdf"
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
