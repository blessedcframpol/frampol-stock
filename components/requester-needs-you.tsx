"use client"

import Link from "next/link"
import { useEffect, useMemo, useState } from "react"
import { AlertCircle, Copy, Loader2, Pencil } from "lucide-react"
import { toast } from "sonner"
import { InvoiceChoiceFields } from "@/components/invoice-choice-fields"
import { RequestStatusPill } from "@/components/request-status-pill"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useAuth } from "@/lib/auth-context"
import { formatClientLabel } from "@/lib/client-label"
import { invoiceChoiceProblem, type InvoiceChoice, type NotInvoicedKind } from "@/lib/invoices"
import { getSupabaseClient } from "@/lib/supabase/client"
import {
  fetchIssuedSerialsForRequest,
  fetchRecentlyIssuedRequestIds,
  setRequestInvoice,
  type IssuedSerialRow,
  type StockRequestWithRelations,
} from "@/lib/supabase/stock-requests-db"
import {
  REJECT_REASON_LABELS,
  requestItemsSummary,
  type RequestDisplayStatus,
} from "@/lib/stock-request-statuses"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"
import { formatDateDDMMYYYY } from "@/lib/utils"

const ISSUED_STATUSES: ReadonlySet<RequestDisplayStatus> = new Set<RequestDisplayStatus>([
  "partially_issued",
  "awaiting_invoice",
  "completed",
])

/** Most recent own requests to look at for issued units (keeps the id list short). */
const ISSUED_CANDIDATES = 40
const ISSUED_SHOWN = 5

type IssuedGroup = { request: StockRequestWithRelations; serials: IssuedSerialRow[] }

function clientOf(r: StockRequestWithRelations): string {
  return r.client ? formatClientLabel(r.client) : r.client_id
}

async function copyLines(values: string[], what: string) {
  try {
    await navigator.clipboard.writeText(values.join("\n"))
    toast.success(`Copied ${values.length} ${what}${values.length === 1 ? "" : "s"}`)
  } catch {
    toast.error("Could not copy to the clipboard")
  }
}

function rejectDetail(r: StockRequestWithRelations): string {
  if (r.reject_reason_code == null) return "No reason was given."
  const label = REJECT_REASON_LABELS[r.reject_reason_code] ?? r.reject_reason_code
  return r.reject_note ? `${label} — ${r.reject_note}` : label
}

function AddInvoiceInline({ request, onSaved }: { request: StockRequestWithRelations; onSaved?: () => void }) {
  const [choice, setChoice] = useState<InvoiceChoice | "">("number")
  const [number, setNumber] = useState("")
  const [reason, setReason] = useState("")
  const [kind, setKind] = useState<NotInvoicedKind | "">("")
  const [busy, setBusy] = useState(false)

  async function save() {
    if (choice === "" || choice === "pending") {
      toast.error("Enter an invoice number, or mark the request 00000.")
      return
    }
    const problem = invoiceChoiceProblem(choice, number, reason, kind)
    if (problem) {
      toast.error(problem)
      return
    }
    setBusy(true)
    try {
      await setRequestInvoice(getSupabaseClient(), request.id, {
        invoiceChoice: choice,
        invoiceNumber: choice === "number" ? number.trim() : null,
        notInvoicedReason: choice === "not_invoiced" ? reason.trim() : null,
        notInvoicedKind: choice === "not_invoiced" ? kind || null : null,
      })
      toast.success("Invoice saved.")
      onSaved?.()
    } catch (e) {
      toastFromCaughtError(e, "Could not save invoice")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <InvoiceChoiceFields
        idPrefix={`needs-${request.id}`}
        choice={choice}
        invoiceNumber={number}
        reason={reason}
        kind={kind}
        onChoice={setChoice}
        onInvoiceNumber={setNumber}
        onReason={setReason}
        onKind={setKind}
      />
      <Button type="button" size="sm" className="min-h-11 w-full sm:min-h-9 sm:w-fit" disabled={busy} onClick={() => void save()}>
        {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
        Save invoice
      </Button>
    </div>
  )
}

/**
 * Requester home: what needs you (rejected, awaiting invoice), then what was recently issued.
 * Rendered above the request list for sales and technicians.
 */
export function RequesterNeedsYou({
  requests,
  displayStatuses,
  onChanged,
}: {
  requests: StockRequestWithRelations[]
  displayStatuses: Record<string, RequestDisplayStatus>
  onChanged?: () => void
}) {
  const { user } = useAuth()

  const mine = useMemo(
    () => requests.filter((r) => r.created_by === user?.id),
    [requests, user?.id]
  )

  const rejected = useMemo(
    () => mine.filter((r) => displayStatuses[r.id] === "rejected"),
    [mine, displayStatuses]
  )
  // Invoice pending on the request itself — not display status "awaiting_invoice".
  // That display status only appears after units are issued; requesters still need to
  // add a number while the request is being reviewed / partially issued.
  const awaitingInvoice = useMemo(
    () =>
      mine.filter((r) => {
        if (r.invoice_status !== "pending") return false
        const state = r.review_state
        if (state === "rejected" || state === "cancelled" || state === "closed") return false
        return true
      }),
    [mine]
  )

  const candidateIds = useMemo(
    () =>
      [...mine]
        .filter((r) => ISSUED_STATUSES.has(displayStatuses[r.id]))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, ISSUED_CANDIDATES)
        .map((r) => r.id),
    [mine, displayStatuses]
  )
  const candidateKey = candidateIds.join(",")

  const [issued, setIssued] = useState<{ key: string; groups: IssuedGroup[] }>({ key: "", groups: [] })

  useEffect(() => {
    if (!candidateKey) return
    let cancelled = false
    void (async () => {
      try {
        const sb = getSupabaseClient()
        const ids = await fetchRecentlyIssuedRequestIds(sb, candidateKey.split(","), ISSUED_SHOWN)
        const byId = new Map(mine.map((r) => [r.id, r]))
        const groups = await Promise.all(
          ids.map(async (id) => {
            const request = byId.get(id)
            if (!request) return null
            const serials = await fetchIssuedSerialsForRequest(sb, id).catch(() => [] as IssuedSerialRow[])
            return serials.length > 0 ? ({ request, serials } satisfies IssuedGroup) : null
          })
        )
        if (!cancelled) {
          setIssued({ key: candidateKey, groups: groups.filter((g): g is IssuedGroup => g !== null) })
        }
      } catch {
        // Recently issued is a convenience; the list below still has everything.
        if (!cancelled) setIssued({ key: candidateKey, groups: [] })
      }
    })()
    return () => {
      cancelled = true
    }
    // `mine` is represented by `candidateKey`; request rows only supply labels.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateKey])

  const issuedGroups = issued.key === candidateKey ? issued.groups : []
  const needsCount = rejected.length + awaitingInvoice.length

  return (
    <>
      {needsCount > 0 ? (
        <Card className="border-warning/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Needs you ({needsCount})</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {rejected.map((r) => (
              <div
                key={r.id}
                className="flex flex-col gap-3 rounded-lg border border-danger/40 bg-danger-soft px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 gap-3 text-danger">
                  <AlertCircle className="mt-0.5 size-5 shrink-0" />
                  <div className="min-w-0">
                    <p className="font-medium">
                      <Link href={`/requests/${r.id}`} className="hover:underline">
                        {r.request_number}
                      </Link>{" "}
                      · {clientOf(r)} was rejected
                    </p>
                    <p>{rejectDetail(r)}</p>
                  </div>
                </div>
                <Button asChild size="sm" className="min-h-11 shrink-0 gap-1 sm:min-h-9">
                  <Link href={`/requests/${r.id}/edit`}>
                    <Pencil className="size-3.5" />
                    Edit and resubmit
                  </Link>
                </Button>
              </div>
            ))}

            {awaitingInvoice.map((r) => (
              <div key={r.id} className="flex flex-col gap-3 rounded-lg border border-border px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/requests/${r.id}`} className="font-medium hover:underline">
                    {r.request_number} · {clientOf(r)}
                  </Link>
                  <RequestStatusPill status={displayStatuses[r.id]} />
                </div>
                <p className="text-muted-foreground">
                  {requestItemsSummary(r.stock_request_lines ?? [])} — add the invoice number when you have it.
                </p>
                <AddInvoiceInline request={r} onSaved={onChanged} />
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {issuedGroups.length > 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Recently issued</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {issuedGroups.map(({ request, serials }) => {
              const serialValues = serials.map((s) => s.serial)
              const descriptionValues = serials.map(
                (s) => `${s.productName} — ${s.serial}${s.cloudKey ? ` — cloud key ${s.cloudKey}` : ""}`
              )
              const latest = serials.reduce<string | null>(
                (acc, s) => (s.issuedAt && (!acc || s.issuedAt > acc) ? s.issuedAt : acc),
                null
              )
              return (
                <div key={request.id} className="flex flex-col gap-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/requests/${request.id}`} className="font-medium hover:underline">
                      {request.request_number} · {clientOf(request)}
                    </Link>
                    {latest ? (
                      <span className="text-xs text-muted-foreground">Issued {formatDateDDMMYYYY(latest)}</span>
                    ) : null}
                  </div>
                  <ul className="flex flex-col gap-0.5 font-mono text-xs text-muted-foreground">
                    {serials.map((s) => (
                      <li key={s.transactionId} className="break-all">
                        {s.productName} · {s.serial}
                      </li>
                    ))}
                  </ul>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11 gap-1 sm:min-h-9"
                      onClick={() => void copyLines(descriptionValues, "description")}
                    >
                      <Copy className="size-3.5" />
                      Copy description
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11 gap-1 sm:min-h-9"
                      onClick={() => void copyLines(serialValues, "serial")}
                    >
                      <Copy className="size-3.5" />
                      Copy serials
                    </Button>
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>
      ) : null}
    </>
  )
}
