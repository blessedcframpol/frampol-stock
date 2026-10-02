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
import { useOrgTimezone } from "@/hooks/use-org-timezone"
import { announceAlertsUpdated, formatReturnAge, holdingDrawerActions } from "@/lib/alerts"
import { formatBusinessDate, todayBusinessDate } from "@/lib/business-date.mjs"
import { LOCATIONS, type InventoryItem } from "@/lib/data"
import { useAuth } from "@/lib/auth-context"
import { useInventoryStore } from "@/lib/inventory-store"
import { getSupabaseClient } from "@/lib/supabase/client"
import { INVENTORY_ITEM_SELECT, rowToInventoryItem } from "@/lib/supabase/inventory-db"

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
  const { inventory, applyMovement } = useInventoryStore()
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
    </>
  )
}
