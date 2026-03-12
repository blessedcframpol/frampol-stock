"use client"

import { useState, useMemo } from "react"
import type { Transaction } from "@/lib/data"
import type { ItemType } from "@/lib/data"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Undo2, MoreHorizontal, ArrowRightLeft, Loader2, ChevronsUpDown, Plus } from "lucide-react"
import { useInventoryStore } from "@/lib/inventory-store"
import { toast } from "sonner"
import { cn } from "@/lib/utils"

const ITEM_TYPES: ItemType[] = [
  "Starlink Kit",
  "Laptop",
  "Desktop",
  "Router",
  "Switch",
  "Access Point",
  "UPS",
  "Monitor",
]

interface TransactionActionsProps {
  transaction: Transaction
  /** Compact mode: icon-only trigger for dashboard table */
  compact?: boolean
}

export function TransactionActions({ transaction, compact }: TransactionActionsProps) {
  const { undoTransaction, reassignTransaction, inventory } = useInventoryStore()
  const [reassignOpen, setReassignOpen] = useState(false)
  const [productPopoverOpen, setProductPopoverOpen] = useState(false)
  const [reassignName, setReassignName] = useState(transaction.itemName)
  const [reassignType, setReassignType] = useState<ItemType | "">("")
  const [reassignSearch, setReassignSearch] = useState("")
  const [busy, setBusy] = useState(false)

  const productNames = useMemo(() => {
    const names = new Set<string>()
    inventory.forEach((item) => names.add(item.name))
    return Array.from(names).sort()
  }, [inventory])

  const allProductOptions = useMemo(() => {
    const combined = [...productNames]
    ITEM_TYPES.forEach((t) => {
      if (!combined.includes(t)) combined.push(t)
    })
    return combined.sort()
  }, [productNames])

  const filteredProducts = useMemo(() => {
    const q = reassignSearch.trim().toLowerCase()
    if (!q) return allProductOptions
    return allProductOptions.filter((o) => o.toLowerCase().includes(q))
  }, [allProductOptions, reassignSearch])

  const canAddCustomProduct =
    reassignSearch.trim() &&
    !allProductOptions.some((o) => o.toLowerCase() === reassignSearch.trim().toLowerCase())

  async function handleUndo() {
    setBusy(true)
    try {
      const result = await undoTransaction(transaction.id)
      if (result.ok) {
        toast.success("Transaction undone")
      } else {
        toast.error(result.error ?? "Failed to undo")
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
      const result = await reassignTransaction(
        transaction.id,
        name,
        reassignType || undefined
      )
      if (result.ok) {
        toast.success(`Reassigned to ${name}`)
        setReassignOpen(false)
      } else {
        toast.error(result.error ?? "Failed to reassign")
      }
    } finally {
      setBusy(false)
    }
  }

  function openReassign() {
    setReassignName(transaction.itemName)
    setReassignType("")
    setReassignSearch("")
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
            <div className="space-y-2">
              <Label>Product name</Label>
              <Popover open={productPopoverOpen} onOpenChange={setProductPopoverOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    className="w-full justify-between font-normal"
                  >
                    <span className={cn("truncate", !reassignName && "text-muted-foreground")}>
                      {reassignName || "Search or select product..."}
                    </span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="min-w-[280px] p-0" align="start">
                  <Command shouldFilter={false}>
                    <CommandInput
                      placeholder="Search products..."
                      value={reassignSearch}
                      onValueChange={setReassignSearch}
                    />
                    <CommandList>
                      {filteredProducts.map((name) => (
                        <CommandItem
                          key={name}
                          value={name}
                          onSelect={() => {
                            setReassignName(name)
                            setProductPopoverOpen(false)
                          }}
                        >
                          {name}
                        </CommandItem>
                      ))}
                      {canAddCustomProduct && (
                        <CommandItem
                          value={`__add:${reassignSearch.trim()}`}
                          onSelect={() => {
                            setReassignName(reassignSearch.trim())
                            setProductPopoverOpen(false)
                          }}
                          className="text-primary gap-2"
                        >
                          <Plus className="h-4 w-4" />
                          Use &quot;{reassignSearch.trim()}&quot; as product name
                        </CommandItem>
                      )}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
            <div className="space-y-2">
              <Label>Item type (optional)</Label>
              <Select
                value={reassignType}
                onValueChange={(v) => setReassignType(v as ItemType)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Same as before" />
                </SelectTrigger>
                <SelectContent>
                  {ITEM_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
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
