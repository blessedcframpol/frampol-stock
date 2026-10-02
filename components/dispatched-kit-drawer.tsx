"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { BatchLinesDrawer } from "@/components/batch-lines-drawer"
import { ConvertToSaleDialog, ExtendHoldingDialog } from "@/components/holding-actions"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useOrgTimezone } from "@/hooks/use-org-timezone"
import { announceAlertsUpdated, formatReturnAge, holdingDrawerActions } from "@/lib/alerts"
import { formatBusinessDate, formatRecordedAt, todayBusinessDate } from "@/lib/business-date.mjs"
import { LOCATIONS, type InventoryItem } from "@/lib/data"
import { useAuth } from "@/lib/auth-context"
import { cancelHoldingExtension } from "@/lib/holdings"
import { useInventoryStore } from "@/lib/inventory-store"
import { canCancelHoldingExtension } from "@/lib/permissions"
import { loadProfileLabels } from "@/lib/profile-labels"
import { getSupabaseClient } from "@/lib/supabase/client"
import { INVENTORY_ITEM_SELECT, rowToInventoryItem } from "@/lib/supabase/inventory-db"

const MIN_CANCEL_REASON = 15

type HoldingExtensionRow = {
  id: string
  previousDate: string | null
  newDate: string
  reason: string
  extendedBy: string
  createdAt: string
  cancelledAt: string | null
  cancelledBy: string | null
  cancelReason: string | null
  extendedByName: string
  cancelledByName: string
}

export function DispatchedKitDrawer({
  itemId,
  onClose,
  onChanged,
}: {
  itemId: string
  onClose: () => void
  onChanged: () => void
}) {
  const { role } = useAuth()
  const { inventory, applyMovement, refetchLedger } = useInventoryStore()
  const timeZone = useOrgTimezone()
  const today = todayBusinessDate(timeZone)
  const storeItem = inventory.find((row) => row.id === itemId) ?? null
  const [fetched, setFetched] = useState<InventoryItem | null>(null)
  const [missing, setMissing] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [statusOverride, setStatusOverride] = useState<string | null>(null)
  const [returnDateOverride, setReturnDateOverride] = useState<string | null | undefined>(undefined)
  const [convertOpen, setConvertOpen] = useState(false)
  const [extendOpen, setExtendOpen] = useState(false)
  const [returnOpen, setReturnOpen] = useState(false)
  const [returnLocation, setReturnLocation] = useState<string>("Warehouse A")
  const [returning, setReturning] = useState(false)
  const [extensions, setExtensions] = useState<HoldingExtensionRow[]>([])
  const [extensionReload, setExtensionReload] = useState(0)
  const [cancelTarget, setCancelTarget] = useState<HoldingExtensionRow | null>(null)
  const [cancelReason, setCancelReason] = useState("")
  const [cancelling, setCancelling] = useState(false)
  const canCancel = canCancelHoldingExtension(role)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { data, error } = await getSupabaseClient()
        .from("inventory_items")
        .select(INVENTORY_ITEM_SELECT)
        .eq("id", itemId)
        .is("deleted_at", null)
        .maybeSingle()
      if (cancelled) return
      if (error || !data) {
        setFetched(null)
        setMissing(true)
        return
      }
      setFetched(rowToInventoryItem(data))
      setMissing(false)
    })()
    return () => {
      cancelled = true
    }
  }, [itemId])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const supabase = getSupabaseClient()
      const { data, error } = await supabase
        .from("holding_extensions")
        .select(
          "id, previous_date, new_date, reason, extended_by, created_at, cancelled_at, cancelled_by, cancel_reason"
        )
        .eq("item_id", itemId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
      if (cancelled) return
      if (error || !data) {
        setExtensions([])
        return
      }
      const labels = await loadProfileLabels(supabase, [
        ...data.map((row) => row.extended_by),
        ...data.map((row) => row.cancelled_by),
      ])
      if (cancelled) return
      setExtensions(
        data.map((row) => ({
          id: row.id,
          previousDate: row.previous_date,
          newDate: row.new_date,
          reason: row.reason,
          extendedBy: row.extended_by,
          createdAt: row.created_at,
          cancelledAt: row.cancelled_at,
          cancelledBy: row.cancelled_by,
          cancelReason: row.cancel_reason,
          extendedByName: labels.get(row.extended_by) ?? "Unknown",
          cancelledByName: row.cancelled_by ? (labels.get(row.cancelled_by) ?? "Unknown") : "",
        }))
      )
    })()
    return () => {
      cancelled = true
    }
  }, [itemId, extensionReload])

  const item = storeItem ?? fetched
  const status = statusOverride ?? item?.status ?? ""
  const returnDate = returnDateOverride !== undefined ? returnDateOverride : (item?.returnDate ?? null)
  const actions = holdingDrawerActions(status, role)
  const returnType = status === "Rented" ? "Rental Return" : "POC Return"

  async function recordReturn() {
    if (!item) return
    if (!returnLocation) {
      toast.error("Select return location")
      return
    }
    setReturning(true)
    try {
      const keptDate = returnDate
      const result = await applyMovement({
        type: returnType,
        serialNumbers: [item.serialNumber],
        toLocation: returnLocation,
      })
      if (result.success.length === 0) {
        toast.error(result.rejected[0]?.reason ?? result.notFound[0] ?? "Could not record this return")
        return
      }
      setReturnDateOverride(keptDate)
      setStatusOverride("In Stock")
      setNote("Return recorded. This kit is back in stock.")
      setReturnOpen(false)
      announceAlertsUpdated()
      onChanged()
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not record this return")
    } finally {
      setReturning(false)
    }
  }

  async function confirmCancel() {
    if (!cancelTarget) return
    const reason = cancelReason.trim()
    if (reason.length < MIN_CANCEL_REASON) {
      toast.error(`Please enter a reason (at least ${MIN_CANCEL_REASON} characters).`)
      return
    }
    setCancelling(true)
    try {
      await cancelHoldingExtension(cancelTarget.id, reason)
      await refetchLedger()
      setReturnDateOverride(cancelTarget.previousDate)
      setNote(
        cancelTarget.previousDate
          ? `Return date went back to ${formatBusinessDate(cancelTarget.previousDate)}.`
          : "Return date cleared."
      )
      setCancelTarget(null)
      setCancelReason("")
      setExtensionReload((value) => value + 1)
      announceAlertsUpdated()
      onChanged()
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not cancel this extension")
    } finally {
      setCancelling(false)
    }
  }

  const latestActiveId = extensions.find((row) => !row.cancelledAt)?.id ?? null

  const description = !item
    ? missing
      ? "This kit is not on the ledger."
      : "Loading this kit…"
    : [
        item.name,
        returnDate ? `Return ${formatBusinessDate(returnDate)}` : "No return date",
        returnDate ? formatReturnAge(returnDate, today) : null,
      ]
        .filter((part) => part != null && part !== "")
        .join(" · ")

  return (
    <>
      <BatchLinesDrawer
        open
        onOpenChange={(open) => {
          if (!open) onClose()
        }}
        title={item?.serialNumber ?? "Kit"}
        description={description}
        dateLabel="Return date"
        showMeta={false}
        detail={
          item
            ? {
                movement: status || "—",
                client: item.client || "—",
                date: returnDate ? formatBusinessDate(returnDate) : "—",
                extra: [{ label: "Due", value: returnDate ? formatReturnAge(returnDate, today) : "—" }],
              }
            : undefined
        }
        notice={note ? <p className="px-4 pb-2 text-sm text-foreground">{note}</p> : undefined}
        actions={
          actions.length > 0 ? (
            <>
              {actions.includes("convert") ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setConvertOpen(true)}>
                  Convert to sale
                </Button>
              ) : null}
              {actions.includes("return") ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setReturnOpen(true)}>
                  Record return
                </Button>
              ) : null}
              {actions.includes("extend") ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setExtendOpen(true)}>
                  Extend
                </Button>
              ) : null}
            </>
          ) : undefined
        }
        lines={
          item
            ? [{ serialNumber: item.serialNumber, status, assignedTo: item.assignedTo ?? item.client }]
            : []
        }
        extra={
          item ? (
            <section className="px-2 pb-3">
              <h3 className="px-2 pb-2 text-xs text-muted-foreground">Extensions</h3>
              {extensions.length === 0 ? (
                <p className="px-2 text-sm text-muted-foreground">No extensions.</p>
              ) : (
                <ul className="space-y-2">
                  {extensions.map((row) => (
                    <li key={row.id} className="rounded-md border border-border px-3 py-2 text-sm">
                      <p>
                        {formatBusinessDate(row.newDate)}
                        <span className="text-muted-foreground"> · was {formatBusinessDate(row.previousDate)}</span>
                      </p>
                      <p className="mt-1">{row.reason}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {row.extendedByName} · {formatRecordedAt(row.createdAt, "", timeZone)}
                      </p>
                      {row.cancelledAt ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Cancelled · {row.cancelledByName} · {formatRecordedAt(row.cancelledAt, "", timeZone)} ·{" "}
                          {row.cancelReason}
                        </p>
                      ) : canCancel && row.id === latestActiveId ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="mt-2"
                          onClick={() => {
                            setCancelReason("")
                            setCancelTarget(row)
                          }}
                        >
                          Cancel
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null
        }
      />
      {item && (convertOpen || actions.includes("convert")) ? (
        <ConvertToSaleDialog
          open={convertOpen}
          serial={item.serialNumber}
          clientName={item.client ?? ""}
          requireInvoice
          onOpenChange={setConvertOpen}
          onCompleted={() => {
            setReturnDateOverride(returnDate)
            setStatusOverride("Sold")
            setNote("Converted to a sale.")
            onChanged()
          }}
        />
      ) : null}
      {item && (extendOpen || actions.includes("extend")) ? (
        <ExtendHoldingDialog
          open={extendOpen}
          itemId={item.id}
          serial={item.serialNumber}
          onOpenChange={setExtendOpen}
          onCompleted={(nextDate) => {
            setReturnDateOverride(nextDate)
            setNote(`Return date extended to ${formatBusinessDate(nextDate)}.`)
            setExtensionReload((value) => value + 1)
            onChanged()
          }}
        />
      ) : null}
      <Dialog open={returnOpen} onOpenChange={setReturnOpen}>
        <DialogContent className="bg-card text-card-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Record return</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              <span className="font-mono text-foreground">{item?.serialNumber}</span>
              {" · "}
              {returnType}
            </p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="return-location">Return to location</Label>
              <Select value={returnLocation} onValueChange={setReturnLocation}>
                <SelectTrigger id="return-location" className="bg-card text-foreground border-border">
                  <SelectValue placeholder="Select location..." />
                </SelectTrigger>
                <SelectContent>
                  {LOCATIONS.map((location) => (
                    <SelectItem key={location} value={location}>
                      {location}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setReturnOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void recordReturn()} disabled={returning || !returnLocation}>
              Record return
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={cancelTarget != null}
        onOpenChange={(open) => {
          if (!open && !cancelling) {
            setCancelTarget(null)
            setCancelReason("")
          }
        }}
      >
        <DialogContent className="bg-card text-card-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel extension</DialogTitle>
          </DialogHeader>
          <p className="text-sm">
            Return date goes back to {formatBusinessDate(cancelTarget?.previousDate ?? null)}.
          </p>
          <div className="space-y-2">
            <Label htmlFor="cancel-extension-reason">Reason (required, min {MIN_CANCEL_REASON} characters)</Label>
            <Textarea
              id="cancel-extension-reason"
              value={cancelReason}
              onChange={(event) => setCancelReason(event.target.value)}
              className="min-h-[100px] resize-y"
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setCancelTarget(null)
                setCancelReason("")
              }}
              disabled={cancelling}
            >
              Close
            </Button>
            <Button
              type="button"
              onClick={() => void confirmCancel()}
              disabled={cancelling || cancelReason.trim().length < MIN_CANCEL_REASON}
            >
              Cancel extension
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
