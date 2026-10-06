"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { fetchKitHistory, fetchKitHistoryBySerial, type KitHistory } from "@/lib/kit-history"
import { displayInvoiceNumber } from "@/lib/invoices"

export function KitHistoryPanel({
  open,
  onOpenChange,
  itemId,
  serial,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  itemId?: string | null
  serial: string
}) {
  const [history, setHistory] = useState<KitHistory | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const request = itemId ? fetchKitHistory(itemId) : fetchKitHistoryBySerial(serial)
    void request
      .then((next) => {
        if (cancelled) return
        setHistory(next)
        setError(null)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : "Could not load kit history")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, itemId, serial])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="font-mono">{history?.serial || serial}</DialogTitle>
          <DialogDescription>
            {[history?.product, history?.status].filter(Boolean).join(" · ") || "Kit history"}
          </DialogDescription>
        </DialogHeader>
        {loading ? <p className="text-sm text-muted-foreground">Loading history…</p> : null}
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {history && !history.found ? (
          <p className="text-sm text-muted-foreground">This kit is not on the ledger.</p>
        ) : null}
        {history?.found ? (
          <div className="flex flex-col gap-6">
            <p className="text-sm text-foreground">{history.summary}</p>
            {history.links && history.links.length > 0 ? (
              <div className="flex flex-wrap gap-3">
                {history.links.map((link) => (
                  <Link key={link.href} href={link.href} className="text-sm text-brand hover:underline">
                    {link.label}
                  </Link>
                ))}
              </div>
            ) : null}
            <section className="flex flex-col gap-3">
              <h3 className="text-sm font-medium text-foreground">Placements</h3>
              {(history.placements ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">No client placement.</p>
              ) : (
                (history.placements ?? []).map((placement, index) => (
                  <div key={`${placement.start}-${placement.end}-${index}`} className="rounded-md border border-border px-3 py-2">
                    <p className="text-sm text-foreground">
                      {placement.kind}
                      {placement.client ? ` · ${placement.client}` : ""}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {placement.location || "—"}
                      {" · "}
                      {placement.start_label} – {placement.end_label}
                      {placement.duration_label ? ` · ${placement.duration_label}` : ""}
                    </p>
                    {(placement.changes ?? []).map((change, changeIndex) => (
                      <p key={`${change.at}-${changeIndex}`} className="text-xs text-foreground">
                        {change.from} to {change.to} on {change.at_label}
                      </p>
                    ))}
                  </div>
                ))
              )}
            </section>
            <section className="flex flex-col">
              <h3 className="text-sm font-medium text-foreground">Timeline</h3>
              {(history.timeline ?? []).map((entry) => (
                <div
                  key={entry.id}
                  className="flex flex-col gap-2 border-b border-border py-3 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{entry.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {entry.date_label}
                      {entry.who ? ` · ${entry.who}` : ""}
                      {entry.voided ? " · Voided" : ""}
                      {entry.reversed ? " · Reversed" : ""}
                    </p>
                    {entry.detail ? <p className="mt-1 text-sm text-foreground">{entry.detail}</p> : null}
                    {entry.invoice ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Invoice {entry.invoice.status}
                        {entry.invoice.invoice_number
                          ? ` ${displayInvoiceNumber(entry.invoice.invoice_number)}`
                          : ""}
                        {entry.invoice.approval ? ` · ${entry.invoice.approval}` : ""}
                      </p>
                    ) : null}
                  </div>
                  {entry.reversal || entry.restore ? (
                    <div className="shrink-0 rounded-md bg-muted px-3 py-2 text-xs text-foreground sm:max-w-[16rem]">
                      {entry.reversal ? (
                        <p>
                          Reversed by {entry.reversal.who || "—"} on {entry.reversal.when}. {entry.reversal.reason}
                        </p>
                      ) : null}
                      {entry.restore ? (
                        <p>
                          Restored by {entry.restore.who || "—"} on {entry.restore.when}. {entry.restore.reason}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))}
            </section>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
