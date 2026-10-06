"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { announceAlertsUpdated } from "@/lib/alerts"
import { todayBusinessDate } from "@/lib/business-date.mjs"
import { extendHolding } from "@/lib/holdings"
import { useInventoryStore } from "@/lib/inventory-store"
import { useOrgTimezone } from "@/hooks/use-org-timezone"
import { InvoiceChoiceFields } from "@/components/invoice-choice-fields"
import { invoiceChoiceProblem, type InvoiceChoice } from "@/lib/invoices"
import {
  inclusiveRentalDays,
  latestRentalStart,
  rentalConversionLabel,
  rentalConversionProblem,
} from "@/lib/rental-conversion"

export function ConvertToSaleDialog({
  open,
  serial,
  clientName,
  requireInvoice = false,
  onOpenChange,
  onCompleted,
}: {
  open: boolean
  serial: string
  /** Shown read-only. A POC conversion keeps the client already stored on the kit. */
  clientName?: string
  requireInvoice?: boolean
  onOpenChange: (open: boolean) => void
  onCompleted?: () => void
}) {
  const { applyMovement } = useInventoryStore()
  const timeZone = useOrgTimezone()
  const [saleDate, setSaleDate] = useState(() => todayBusinessDate())
  const [invoiceChoice, setInvoiceChoice] = useState<InvoiceChoice | "">("")
  const [invoiceNumber, setInvoiceNumber] = useState("")
  const [invoiceReason, setInvoiceReason] = useState("")
  const [saving, setSaving] = useState(false)
  const invoiceProblem = requireInvoice ? invoiceChoiceProblem(invoiceChoice, invoiceNumber, invoiceReason) : null

  async function submit() {
    if (invoiceProblem) {
      toast.error(invoiceProblem)
      return
    }
    setSaving(true)
    try {
      const result = await applyMovement({
        type: "Sale",
        serialNumbers: [serial],
        clientDisplayOverride: "",
        invoiceNumber: invoiceNumber.trim() || undefined,
        invoiceChoice: invoiceChoice || undefined,
        invoiceReason: invoiceReason.trim() || undefined,
        saleTransactionDateIso: saleDate,
      })
      if (result.success.length === 0) {
        toast.error(result.rejected[0]?.reason ?? result.notFound[0] ?? "Could not convert this POC")
        return
      }
      toast.success(`${serial} converted to a sale`)
      announceAlertsUpdated()
      onCompleted?.()
      onOpenChange(false)
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not convert this POC")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card text-card-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Convert to sale</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            Records a Sale for <span className="font-mono text-foreground">{serial}</span>. The client stays the same.
            Timezone {timeZone}.
          </p>
          {clientName != null ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="convert-client">Client</Label>
              <Input id="convert-client" value={clientName || "—"} readOnly />
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="convert-sale-date">Sale date</Label>
            <Input
              id="convert-sale-date"
              type="date"
              value={saleDate}
              onChange={(event) => setSaleDate(event.target.value)}
            />
          </div>
          {requireInvoice ? (
            <InvoiceChoiceFields
              idPrefix="convert-invoice"
              choice={invoiceChoice}
              invoiceNumber={invoiceNumber}
              reason={invoiceReason}
              onChoice={setInvoiceChoice}
              onInvoiceNumber={setInvoiceNumber}
              onReason={setInvoiceReason}
            />
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={saving || !saleDate || Boolean(invoiceProblem)}
          >
            Convert to sale
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ConvertRentalToSaleDialog({
  open,
  serial,
  clientName,
  onOpenChange,
  onCompleted,
}: {
  open: boolean
  serial: string
  clientName?: string
  onOpenChange: (open: boolean) => void
  onCompleted?: (sentence: string) => void
}) {
  const { applyMovement, transactions } = useInventoryStore()
  const timeZone = useOrgTimezone()
  const today = todayBusinessDate(timeZone)
  const rentalStart = latestRentalStart(transactions, serial)
  const [rentalEnd, setRentalEnd] = useState(today)
  const [saleDate, setSaleDate] = useState(today)
  const [invoiceChoice, setInvoiceChoice] = useState<InvoiceChoice | "">("")
  const [invoiceNumber, setInvoiceNumber] = useState("")
  const [invoiceReason, setInvoiceReason] = useState("")
  const [saving, setSaving] = useState(false)
  const invoiceProblem = invoiceChoiceProblem(invoiceChoice, invoiceNumber, invoiceReason)
  const days = rentalStart ? inclusiveRentalDays(rentalStart, rentalEnd) : null
  const problem = rentalConversionProblem({
    rentalStart,
    rentalEnd,
    saleDate,
    today,
  })

  async function submit() {
    if (!rentalStart || problem) {
      toast.error(problem ?? "Convert to sale needs the rental start")
      return
    }
    if (invoiceProblem) {
      toast.error(invoiceProblem)
      return
    }
    setSaving(true)
    try {
      const result = await applyMovement({
        type: "Sale",
        serialNumbers: [serial],
        clientDisplayOverride: "",
        invoiceNumber: invoiceNumber.trim() || undefined,
        invoiceChoice: invoiceChoice || undefined,
        invoiceReason: invoiceReason.trim() || undefined,
        saleTransactionDateIso: saleDate,
        rentalStartDate: rentalStart,
        rentalEndDate: rentalEnd,
      })
      if (result.success.length === 0) {
        toast.error(result.rejected[0]?.reason ?? result.notFound[0] ?? "Could not convert this rental")
        return
      }
      const sentence =
        rentalConversionLabel(
          { converted_from: "Rentals", rental_start: rentalStart, rental_end: rentalEnd, rental_days: days },
          saleDate,
        ) ?? "Converted to a sale."
      toast.success(`${serial} converted to a sale`)
      announceAlertsUpdated()
      onCompleted?.(sentence)
      onOpenChange(false)
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not convert this rental")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card text-card-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Convert to sale</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            Records one Sale for <span className="font-mono text-foreground">{serial}</span>. The kit stays with the
            client. Timezone {timeZone}.
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rental-convert-client">Client</Label>
            <Input id="rental-convert-client" value={clientName || "—"} readOnly />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rental-convert-end">Rental end date</Label>
            <Input
              id="rental-convert-end"
              type="date"
              value={rentalEnd}
              min={rentalStart ?? undefined}
              max={today}
              onChange={(event) => {
                const next = event.target.value
                setRentalEnd(next)
                setSaleDate((current) => (next && current < next ? next : current))
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rental-convert-sale-date">Sale date</Label>
            <Input
              id="rental-convert-sale-date"
              type="date"
              value={saleDate}
              min={rentalEnd || undefined}
              onChange={(event) => setSaleDate(event.target.value)}
            />
          </div>
          <p className="text-sm text-foreground">
            Rental days <span className="tabular-nums">{days ?? "—"}</span>
          </p>
          {problem ? <p className="text-sm text-destructive">{problem}</p> : null}
          <InvoiceChoiceFields
            idPrefix="rental-convert-invoice"
            choice={invoiceChoice}
            invoiceNumber={invoiceNumber}
            reason={invoiceReason}
            onChoice={setInvoiceChoice}
            onInvoiceNumber={setInvoiceNumber}
            onReason={setInvoiceReason}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={saving || !rentalStart || Boolean(problem) || Boolean(invoiceProblem)}
          >
            Convert to sale
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ExtendHoldingDialog({
  open,
  itemId,
  serial,
  onOpenChange,
  onCompleted,
}: {
  open: boolean
  itemId: string
  serial: string
  onOpenChange: (open: boolean) => void
  onCompleted?: (returnDate: string) => void
}) {
  const { refetchLedger } = useInventoryStore()
  const [returnDate, setReturnDate] = useState("")
  const [reason, setReason] = useState("")
  const [saving, setSaving] = useState(false)

  async function submit() {
    if (!returnDate || !reason.trim()) {
      toast.error("Choose a date and a short reason")
      return
    }
    setSaving(true)
    try {
      await extendHolding(itemId, returnDate, reason.trim())
      await refetchLedger()
      announceAlertsUpdated()
      toast.success(`Return date for ${serial} extended`)
      onCompleted?.(returnDate)
      onOpenChange(false)
      setReason("")
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not extend the return date")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card text-card-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Extend return date</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            <span className="font-mono text-foreground">{serial}</span>
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="extend-date">New return date</Label>
            <Input
              id="extend-date"
              type="date"
              value={returnDate}
              onChange={(event) => setReturnDate(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="extend-reason">Reason</Label>
            <Textarea
              id="extend-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={saving || !returnDate || !reason.trim()}>
            Extend
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
