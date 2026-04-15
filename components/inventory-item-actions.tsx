"use client"

import { useEffect, useMemo, useState, type ReactNode } from "react"
import type { InventoryItem } from "@/lib/data"
import { LOCATIONS } from "@/lib/data"
import { useInventoryStore, INVENTORY_TRASH_RETENTION_DAYS } from "@/lib/inventory-store"
import { useAuth } from "@/lib/auth-context"
import { canEditInventory } from "@/lib/permissions"
import { formatDateDDMMYYYY } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { toast } from "sonner"

const HISTORY_LIMIT = 20

function dateToInputValue(iso?: string): string {
  if (!iso?.trim()) return ""
  const s = iso.trim()
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : ""
}

function formatTxnDate(dateStr: string): string {
  const d = dateStr.trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) return formatDateDDMMYYYY(d.slice(0, 10))
  try {
    return formatDateDDMMYYYY(new Date(d).toISOString().slice(0, 10))
  } catch {
    return d
  }
}

type Props = {
  item: InventoryItem
  menuTrigger: ReactNode
  onRecordMovement?: (item: InventoryItem) => void
}

export function InventoryItemActionsMenu({ item, menuTrigger, onRecordMovement }: Props) {
  const { transactions, updateItem, softDeleteItem } = useInventoryStore()
  const { role } = useAuth()
  const isAdmin = canEditInventory(role)

  const [viewOpen, setViewOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const [editName, setEditName] = useState("")
  const [editVendor, setEditVendor] = useState("")
  const [editLocation, setEditLocation] = useState("")
  const [editNotes, setEditNotes] = useState("")
  const [editPurchase, setEditPurchase] = useState("")
  const [editWarranty, setEditWarranty] = useState("")

  const recentTxns = useMemo(() => {
    return transactions
      .filter((t) => t.serialNumber === item.serialNumber)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, HISTORY_LIMIT)
  }, [transactions, item.serialNumber])

  useEffect(() => {
    if (!editOpen) return
    setEditName(item.name)
    setEditVendor(item.vendor != null && String(item.vendor).trim() ? String(item.vendor) : "")
    setEditLocation(item.location)
    setEditNotes(item.notes ?? "")
    setEditPurchase(dateToInputValue(item.purchaseDate))
    setEditWarranty(dateToInputValue(item.warrantyEndDate))
  }, [editOpen, item])

  async function handleSaveEdit() {
    const nameTrim = editName.trim()
    if (!nameTrim) {
      toast.error("Product name is required")
      return
    }
    try {
      await updateItem(item.id, {
        name: nameTrim,
        vendor: editVendor.trim() || "General",
        location: editLocation,
        notes: editNotes.trim() || undefined,
        purchaseDate: editPurchase.trim() || undefined,
        warrantyEndDate: editWarranty.trim() || undefined,
      })
      toast.success("Item updated")
      setEditOpen(false)
    } catch {
      toast.error("Could not update item")
    }
  }

  async function handleConfirmDelete() {
    setDeleting(true)
    try {
      const res = await softDeleteItem(item.id)
      if (!res.ok) {
        toast.error(res.error ?? "Could not move item to trash")
        return
      }
      toast.success("Item moved to Trash (30 days before permanent removal)")
      setDeleteOpen(false)
    } finally {
      setDeleting(false)
    }
  }

  function detailRow(label: string, value: string | undefined) {
    if (value === undefined || value === "") return null
    return (
      <div className="grid grid-cols-[minmax(0,120px)_1fr] gap-x-3 gap-y-1 text-sm border-b border-border py-2 last:border-0">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-foreground break-words">{value}</span>
      </div>
    )
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{menuTrigger}</DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setViewOpen(true)}>View Details</DropdownMenuItem>
          {onRecordMovement && (
            <DropdownMenuItem onSelect={() => onRecordMovement(item)}>Record movement…</DropdownMenuItem>
          )}
          {isAdmin && (
            <>
              <DropdownMenuItem onSelect={() => setEditOpen(true)}>Edit</DropdownMenuItem>
              <DropdownMenuItem className="text-destructive" onSelect={() => setDeleteOpen(true)}>
                Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={viewOpen} onOpenChange={setViewOpen}>
        <DialogContent className="bg-card text-card-foreground max-w-[calc(100vw-2rem)] sm:max-w-lg max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-foreground">Item details</DialogTitle>
          </DialogHeader>
          <div className="overflow-y-auto flex-1 min-h-0 space-y-1 pr-1">
            {detailRow("Serial", item.serialNumber)}
            {detailRow("Product name", item.name)}
            {detailRow("Vendor", item.vendor != null ? String(item.vendor) : undefined)}
            {detailRow("Status", item.status)}
            {detailRow("Location", item.location)}
            {detailRow("Client", item.client)}
            {detailRow("Assigned to", item.assignedTo)}
            {detailRow("Date added", formatDateDDMMYYYY(item.dateAdded))}
            {item.purchaseDate && detailRow("Purchase", formatDateDDMMYYYY(item.purchaseDate))}
            {item.warrantyEndDate && detailRow("Warranty end", formatDateDDMMYYYY(item.warrantyEndDate))}
            {item.pocOutDate && detailRow("POC out", formatDateDDMMYYYY(item.pocOutDate))}
            {item.returnDate && detailRow("Return due", formatDateDDMMYYYY(item.returnDate))}
            {detailRow("Notes", item.notes)}
            {item.cloudKey && detailRow("Cloud key", item.cloudKey)}
          </div>
          <div className="pt-2 border-t border-border">
            <p className="text-xs font-medium text-muted-foreground mb-2">Recent activity (latest {HISTORY_LIMIT})</p>
            {recentTxns.length === 0 ? (
              <p className="text-sm text-muted-foreground">No transactions logged for this serial.</p>
            ) : (
              <div className="rounded-md border border-border overflow-hidden max-h-48 overflow-y-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="text-xs h-8">Date</TableHead>
                      <TableHead className="text-xs h-8">Type</TableHead>
                      <TableHead className="text-xs h-8">Client</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recentTxns.map((t) => (
                      <TableRow key={t.id}>
                        <TableCell className="text-xs py-1.5 whitespace-nowrap">{formatTxnDate(t.date)}</TableCell>
                        <TableCell className="text-xs py-1.5">{t.type}</TableCell>
                        <TableCell className="text-xs py-1.5 max-w-[140px] truncate" title={t.client}>
                          {t.client}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="bg-card text-card-foreground max-w-[calc(100vw-2rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-foreground">Edit item</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="flex flex-col gap-1.5">
              <Label className="text-foreground">Serial</Label>
              <Input className="bg-muted/50 font-mono text-sm" value={item.serialNumber} readOnly disabled />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-foreground">Product name</Label>
              <Input className="bg-card" value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-foreground">Vendor</Label>
              <Input className="bg-card" value={editVendor} onChange={(e) => setEditVendor(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-foreground">Location</Label>
              <Select value={editLocation} onValueChange={setEditLocation}>
                <SelectTrigger className="bg-card">
                  <SelectValue placeholder="Location…" />
                </SelectTrigger>
                <SelectContent>
                  {LOCATIONS.map((loc) => (
                    <SelectItem key={loc} value={loc}>
                      {loc}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-foreground">Notes</Label>
              <Input className="bg-card" value={editNotes} onChange={(e) => setEditNotes(e.target.value)} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label className="text-foreground">Purchase date</Label>
                <Input type="date" className="bg-card" value={editPurchase} onChange={(e) => setEditPurchase(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="text-foreground">Warranty end</Label>
                <Input type="date" className="bg-card" value={editWarranty} onChange={(e) => setEditWarranty(e.target.value)} />
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={handleSaveEdit}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent className="bg-card text-card-foreground border-border">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-foreground">Move to Trash?</AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              <span className="font-mono text-foreground">{item.serialNumber}</span> will go to Trash for{" "}
              {INVENTORY_TRASH_RETENTION_DAYS} days, then it can be permanently removed. Transaction history for this serial
              may still appear in reports.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="bg-card" disabled={deleting}>
              Cancel
            </AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={deleting}
              onClick={() => void handleConfirmDelete()}
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
