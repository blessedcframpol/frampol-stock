"use client"

import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ProductNamePicker } from "@/components/product-name-picker"
import type { InventoryItem } from "@/lib/data"
import { useInventoryStore } from "@/lib/inventory-store"
import { filterOnHandInventory } from "@/lib/inventory-visibility"
import { toast } from "sonner"

const VENDOR_LABELS: Record<string, string> = {
  Starlink: "Starlink",
  Fortinet: "Fortinet",
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: InventoryItem[]
  onMoved?: () => void
}

function initialVendor(item: InventoryItem | undefined): string {
  return item?.vendor?.trim() ? item.vendor.trim() : "General"
}

function MoveItemsForm({
  items,
  onOpenChange,
  onMoved,
}: {
  items: InventoryItem[]
  onOpenChange: (open: boolean) => void
  onMoved?: () => void
}) {
  const { inventory, reassignInventoryItems } = useInventoryStore()
  const onHandInventory = useMemo(() => filterOnHandInventory(inventory), [inventory])
  const first = items[0]

  const [targetGroupName, setTargetGroupName] = useState(first?.name ?? "")
  const [vendorPick, setVendorPick] = useState(() => initialVendor(first))
  const [newVendorName, setNewVendorName] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [vendorEditable, setVendorEditable] = useState(false)
  const [reason, setReason] = useState("")

  const vendorsFromInventory = useMemo(
    () => [...new Set(onHandInventory.map((i) => (i.vendor?.trim() ? i.vendor : "General")))].sort() as string[],
    [onHandInventory]
  )

  const vendorOptions = useMemo(() => {
    const set = new Set(["General", ...Object.keys(VENDOR_LABELS), ...vendorsFromInventory])
    if (vendorPick && vendorPick !== "__new__") set.add(vendorPick)
    return [...set].sort()
  }, [vendorsFromInventory, vendorPick])

  const effectiveVendor = vendorPick === "__new__" ? newVendorName.trim() : vendorPick

  const productOptions = useMemo(() => {
    if (!effectiveVendor) return []
    return [
      ...new Set(
        onHandInventory
          .filter((i) => (i.vendor?.trim() ? i.vendor.trim() : "General") === effectiveVendor)
          .map((i) => i.name)
      ),
    ].sort()
  }, [onHandInventory, effectiveVendor])

  const sourceVendorUniform = useMemo(() => {
    if (items.length === 0) return null
    const first = items[0].vendor?.trim() ? items[0].vendor.trim() : "General"
    return items.every((i) => (i.vendor?.trim() ? i.vendor.trim() : "General") === first) ? first : null
  }, [items])

  function handleVendorChange(next: string) {
    setVendorPick(next)
    if (next === "__new__") {
      setNewVendorName("")
      setTargetGroupName("")
      return
    }
    setNewVendorName("")
    const namesForVendor = [
      ...new Set(
        onHandInventory
          .filter((i) => (i.vendor?.trim() ? i.vendor.trim() : "General") === next)
          .map((i) => i.name)
      ),
    ]
    if (targetGroupName && !namesForVendor.includes(targetGroupName)) {
      setTargetGroupName("")
    }
  }

  async function handleApply() {
    const targetName = targetGroupName.trim()
    if (!targetName) {
      toast.error("Please select or enter a destination product group")
      return
    }
    if (!effectiveVendor) {
      toast.error("Please select or enter a destination vendor")
      return
    }
    if (!reason.trim()) {
      toast.error("A reason is required")
      return
    }
    setSubmitting(true)
    try {
      const result = await reassignInventoryItems({
        itemIds: items.map((i) => i.id),
        targetGroupName: targetName,
        targetVendor: effectiveVendor,
        reason,
      })
      if (!result.ok) {
        toast.error(result.error ?? "Failed to move item(s)")
        return
      }
      toast.success(`Moved ${result.updated} item(s)`)
      onOpenChange(false)
      onMoved?.()
    } finally {
      setSubmitting(false)
    }
  }

  const count = items.length

  return (
    <div className="flex flex-col gap-3 py-2">
          <div className="text-xs text-muted-foreground">
            {count === 1
              ? `Reassign ${items[0]?.serialNumber ?? "this serial"} to a product group and vendor.`
              : `Reassign ${count} selected serial(s) to a product group and vendor.`}
          </div>
          <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
            <Label className="text-sm font-medium text-foreground">Destination</Label>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Vendor</Label>
              {sourceVendorUniform && !vendorEditable && vendorPick !== "__new__" ? (
                <>
                  <div className="flex h-10 items-center rounded-md border border-border bg-muted/40 px-3 text-sm text-foreground">
                    {VENDOR_LABELS[vendorPick] ?? vendorPick}
                    <span className="ml-2 text-xs text-muted-foreground">(same vendor)</span>
                  </div>
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto p-0 text-xs text-muted-foreground justify-start"
                    onClick={() => setVendorEditable(true)}
                  >
                    Change vendor
                  </Button>
                </>
              ) : (
                <>
                  <Select value={vendorPick || ""} onValueChange={handleVendorChange} disabled={submitting}>
                    <SelectTrigger className="bg-card text-foreground border-border">
                      <SelectValue placeholder="Select vendor" />
                    </SelectTrigger>
                    <SelectContent>
                      {vendorOptions.map((cat) => (
                        <SelectItem key={cat} value={cat}>
                          {VENDOR_LABELS[cat] ?? cat}
                        </SelectItem>
                      ))}
                      <SelectItem value="__new__">Add new vendor…</SelectItem>
                    </SelectContent>
                  </Select>
                  {vendorPick === "__new__" && (
                    <Input
                      placeholder="Enter new vendor name"
                      className="bg-card text-foreground border-border"
                      value={newVendorName}
                      onChange={(e) => setNewVendorName(e.target.value)}
                      disabled={submitting}
                    />
                  )}
                </>
              )}
            </div>
            <ProductNamePicker
              label="Product group"
              value={targetGroupName}
              onChange={setTargetGroupName}
              options={productOptions}
              disabled={submitting || (vendorPick === "__new__" && !newVendorName.trim())}
              placeholder={
                vendorPick === "__new__" && !newVendorName.trim()
                  ? "Enter vendor first…"
                  : "Select a product group…"
              }
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-sm font-medium text-foreground">Reason</Label>
            <Input
              className="bg-card text-foreground border-border"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why these kits are moving"
              disabled={submitting}
              required
            />
          </div>
          <div className="flex justify-end">
            <Button onClick={() => void handleApply()} disabled={submitting}>
              Apply move
            </Button>
          </div>
    </div>
  )
}

export function MoveItemsDialog({ open, onOpenChange, items, onMoved }: Props) {
  const count = items.length
  const itemKey = items.map((i) => i.id).join("|")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card text-card-foreground max-w-[calc(100vw-2rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-foreground">
            {count === 1 ? "Move item (Admin)" : "Move items (Admin)"}
          </DialogTitle>
        </DialogHeader>
        {open && items.length > 0 ? (
          <MoveItemsForm key={itemKey} items={items} onOpenChange={onOpenChange} onMoved={onMoved} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
