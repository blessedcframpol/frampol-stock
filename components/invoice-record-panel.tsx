"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useAuth } from "@/lib/auth-context"
import { formatRecordedAt } from "@/lib/business-date.mjs"
import {
  invoiceEventLabel,
  invoiceStateLabel,
  realInvoiceNumberProblem,
  type InvoiceEvent,
  type InvoiceState,
} from "@/lib/invoices"
import { canViewFinancials } from "@/lib/permissions"
import { getSupabaseClient } from "@/lib/supabase/client"
import { fetchInvoiceEvents } from "@/lib/supabase/invoices-db"
import { loadProfileLabels } from "@/lib/profile-labels"
import { toast } from "sonner"

export function InvoiceRecordPanel({
  batchId,
  state,
  timeZone,
  onChanged,
}: {
  batchId: string
  state?: InvoiceState
  timeZone: string
  onChanged?: () => void
}) {
  const { role } = useAuth()
  const [events, setEvents] = useState<InvoiceEvent[]>([])
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [number, setNumber] = useState("")
  const [reason, setReason] = useState("")
  const [saving, setSaving] = useState(false)
  const canEdit = canViewFinancials(role) && state?.status === "invoiced"

  useEffect(() => {
    let cancelled = false
    const supabase = getSupabaseClient()
    if (!supabase) return
    void fetchInvoiceEvents(supabase, batchId)
      .then(async (rows) => {
        if (cancelled) return
        setEvents(rows)
        const labels = await loadProfileLabels(
          supabase,
          rows.map((row) => row.actorId),
        )
        if (!cancelled) setNames(labels)
      })
      .catch(() => {
        if (!cancelled) setEvents([])
      })
    return () => {
      cancelled = true
    }
  }, [batchId, state?.status, state?.invoiceNumber, state?.approval])

  async function changeNumber() {
    const problem = realInvoiceNumberProblem(number)
    if (problem) {
      toast.error(problem)
      return
    }
    if (reason.trim().length < 15) {
      toast.error("A reason of at least 15 characters is required to change an invoice number")
      return
    }
    const supabase = getSupabaseClient()
    if (!supabase) return
    setSaving(true)
    try {
      const { error } = await supabase.rpc("set_batch_invoice", {
        p_batch_id: batchId,
        p_choice: "number",
        p_invoice_number: number.trim(),
        p_reason: reason.trim(),
      })
      if (error) throw new Error(error.message)
      setNumber("")
      setReason("")
      toast.success("Invoice number updated")
      onChanged?.()
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not change the invoice")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="text-foreground">{invoiceStateLabel(state)}</p>
      {state?.notInvoicedReason ? (
        <p className="text-muted-foreground">Reason: {state.notInvoicedReason}</p>
      ) : null}
      {state?.rejectionReason ? (
        <p className="text-muted-foreground">Rejected: {state.rejectionReason}</p>
      ) : null}
      {events.length === 0 ? (
        <p className="text-muted-foreground">No invoice changes recorded.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {events.map((event) => (
            <li key={event.id} className="text-muted-foreground">
              <span className="text-foreground">{formatRecordedAt(event.createdAt, event.createdAt, timeZone)}</span>
              {" · "}
              {event.actorId ? names.get(event.actorId) || "User" : "User"}
              {" · "}
              {invoiceEventLabel(event)}
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <div className="flex flex-col gap-2 pt-1">
          <Input
            className="font-mono"
            value={number}
            placeholder="New invoice number"
            onChange={(event) => setNumber(event.target.value)}
          />
          <Textarea
            value={reason}
            placeholder="Reason for the change, at least 15 characters"
            onChange={(event) => setReason(event.target.value)}
          />
          <Button type="button" size="sm" disabled={saving} onClick={() => void changeNumber()}>
            Change invoice number
          </Button>
        </div>
      ) : null}
    </div>
  )
}
