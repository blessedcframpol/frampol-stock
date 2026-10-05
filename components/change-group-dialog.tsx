"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
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
import type { InventoryItem, StockPool } from "@/lib/data"
import { changeStockPools } from "@/lib/stock-pools"

type ChangeGroupKit = Pick<InventoryItem, "id" | "serialNumber" | "stockPool" | "vendor" | "status">

export function ChangeGroupDialog({
  open,
  onOpenChange,
  kits,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  kits: ChangeGroupKit[]
  onSaved?: () => void | Promise<void>
}) {
  const [wasOpen, setWasOpen] = useState(open)
  const [pool, setPool] = useState<"" | StockPool>("")
  const [reason, setReason] = useState("")
  const [saving, setSaving] = useState(false)

  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setPool("")
      setReason("")
    }
  }

  const rentalAllowed = kits.length > 0 && kits.every((kit) => kit.vendor === "Starlink")
  const one = kits.length === 1 ? kits[0] : null

  async function save() {
    if (pool !== "sale" && pool !== "rental" && pool !== "demo") {
      toast.error("Choose a group")
      return
    }
    if (pool === "rental" && !rentalAllowed) {
      toast.error("The rental group is only for Starlink kits")
      return
    }
    if (reason.trim().length < 15) {
      toast.error("Reason must be at least 15 characters")
      return
    }
    setSaving(true)
    try {
      await changeStockPools(
        kits.map((kit) => kit.id),
        pool,
        reason.trim(),
      )
      toast.success(kits.length === 1 ? "Group updated" : `Group updated for ${kits.length} kits`)
      onOpenChange(false)
      await onSaved?.()
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not change group")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card text-card-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-foreground">Change group</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            {one
              ? `${one.serialNumber} is currently ${one.stockPool === "rental" ? "rental" : one.stockPool === "demo" ? "demo" : "sale"}.`
              : `${kits.length} kits. One reason applies to every kit.`}{" "}
            Only an In Stock or Rented kit can change group.
          </p>
          <div className="flex flex-col gap-1.5">
            <Label className="text-foreground">New group</Label>
            <Select value={pool || undefined} onValueChange={(value) => setPool(value as StockPool)}>
              <SelectTrigger className="bg-card text-foreground border-border">
                <SelectValue placeholder="Choose a group" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sale">Sale</SelectItem>
                <SelectItem value="rental" disabled={!rentalAllowed}>
                  Rental
                </SelectItem>
                <SelectItem value="demo">Demo</SelectItem>
              </SelectContent>
            </Select>
            {rentalAllowed ? null : (
              <p className="text-xs text-muted-foreground">The rental group is only for Starlink kits.</p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-foreground">Reason</Label>
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="At least 15 characters"
              className="bg-card"
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void save()}
            disabled={saving || kits.length === 0 || !pool || (pool === "rental" && !rentalAllowed) || reason.trim().length < 15}
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
