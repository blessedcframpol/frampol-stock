"use client"

import { useState, useMemo } from "react"
import type { Transaction } from "@/lib/data"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ProductNamePicker } from "@/components/product-name-picker"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Undo2, MoreHorizontal, ArrowRightLeft, Loader2 } from "lucide-react"
import { useInventoryStore } from "@/lib/inventory-store"
import { toast } from "sonner"
interface TransactionActionsProps {
  transaction: Transaction
  /** Compact mode: icon-only trigger for dashboard table */
  compact?: boolean
}

export function TransactionActions({ transaction, compact }: TransactionActionsProps) {
  const { undoTransaction, reassignTransaction, inventory } = useInventoryStore()
  const [reassignOpen, setReassignOpen] = useState(false)
  const [reassignName, setReassignName] = useState(transaction.itemName)
  const [busy, setBusy] = useState(false)

  const productNames = useMemo(() => {
    const names = new Set<string>()
    inventory.forEach((item) => names.add(item.name))
    return Array.from(names).sort()
  }, [inventory])

  async function handleUndo() {
    setBusy(true)
    try {
      const result = await undoTransaction(transaction.id)
      if (result.ok) {
        toast.success("Transaction undone")
      } else {
        toast.error("Failed to undo", {
          description: result.error || undefined,
          duration: 14_000,
        })
      }
    } finally {
      setBusy(false)
    }
  }

  async function handleReassignSubmit() {
    const name = reassignName.trim()
    if (!name) {
      toast.error("Select or enter a product name")
      return
    }
    setBusy(true)
    try {
      const result = await reassignTransaction(transaction.id, name)
      if (result.ok) {
        toast.success(`Reassigned to ${name}`)
        setReassignOpen(false)
      } else {
        toast.error("Failed to reassign", {
          description: result.error || undefined,
          duration: 14_000,
        })
      }
    } finally {
      setBusy(false)
    }
  }

  function openReassign() {
    setReassignName(transaction.itemName)
    setReassignOpen(true)
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <MoreHorizontal className="h-4 w-4" />
            )}
            <span className="sr-only">Actions</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {transaction.type !== "Dispose" && (
            <DropdownMenuItem onClick={handleUndo} disabled={busy}>
              <Undo2 className="mr-2 h-4 w-4" />
              Undo
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={openReassign} disabled={busy}>
            <ArrowRightLeft className="mr-2 h-4 w-4" />
            Reassign to another product
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={reassignOpen} onOpenChange={setReassignOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reassign to product</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Change this transaction and the linked inventory item to a different product. Serial:{" "}
            <span className="font-mono">{transaction.serialNumber}</span>
          </p>
          <div className="space-y-4 py-2">
            <ProductNamePicker
              label="Product name"
              value={reassignName}
              onChange={setReassignName}
              options={productNames}
              disabled={busy}
              placeholder="Select a product…"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReassignOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleReassignSubmit} disabled={busy || !reassignName.trim()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Reassign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
