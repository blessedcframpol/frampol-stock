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

export function ConvertToSaleDialog({
  open,
  serial,
  onOpenChange,
}: {
  open: boolean
  serial: string
  onOpenChange: (open: boolean) => void
}) {
  const { applyMovement } = useInventoryStore()
  const timeZone = useOrgTimezone()
  const [saleDate, setSaleDate] = useState(() => todayBusinessDate())
  const [invoice, setInvoice] = useState("")
  const [saving, setSaving] = useState(false)

  async function submit() {
    setSaving(true)
    try {
      const result = await applyMovement({
        type: "Sale",
        serialNumbers: [serial],
        clientDisplayOverride: "",
        invoiceNumber: invoice.trim() || undefined,
        saleTransactionDateIso: saleDate,
      })
      if (result.success.length === 0) {
        toast.error(result.rejected[0]?.reason ?? result.notFound[0] ?? "Could not convert this POC")
        return
      }
      toast.success(`${serial} converted to a sale`)
      announceAlertsUpdated()
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
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="convert-sale-date">Sale date</Label>
            <Input
              id="convert-sale-date"
              type="date"
              value={saleDate}
              onChange={(event) => setSaleDate(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="convert-invoice">Invoice</Label>
            <Input
              id="convert-invoice"
              value={invoice}
              placeholder="Optional"
              onChange={(event) => setInvoice(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={saving || !saleDate}>
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
}: {
  open: boolean
  itemId: string
  serial: string
  onOpenChange: (open: boolean) => void
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
          <Button type="button" onClick={() => void submit()} disabled={saving}>
            Extend
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
