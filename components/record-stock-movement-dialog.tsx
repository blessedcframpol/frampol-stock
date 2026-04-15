"use client"

import { useMemo, useRef, useEffect } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { StockMovementContent, type StockMovementEmbedMode } from "@/components/stock-movement-content"
import type { InventoryItem } from "@/lib/data"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: InventoryItem[]
  initialMovementType?: string
}

export function RecordStockMovementDialog({ open, onOpenChange, items, initialMovementType }: Props) {
  const onOpenChangeRef = useRef(onOpenChange)
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange
  }, [onOpenChange])

  const serialKey = useMemo(
    () =>
      items
        .map((i) => i.serialNumber)
        .sort()
        .join("|"),
    [items]
  )
  const productName = items[0]?.name ?? ""

  const embedMode = useMemo((): StockMovementEmbedMode | undefined => {
    if (!open || items.length === 0 || !productName) return undefined
    const first = items[0]!
    return {
      fixedSerials: items.map((i) => i.serialNumber),
      fixedProductName: productName,
      initialMovementType,
      expectedVendor: (first.vendor ?? "").trim() || "General",
      onClose: () => onOpenChangeRef.current(false),
    }
  }, [open, items, productName, initialMovementType, serialKey])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card text-card-foreground max-w-[calc(100vw-1rem)] sm:max-w-4xl max-h-[min(90vh,900px)] flex flex-col gap-0 p-0 overflow-hidden border-border">
        <DialogHeader className="px-4 sm:px-6 pt-4 sm:pt-6 pb-2 shrink-0 border-b border-border">
          <DialogTitle className="text-foreground text-left">Record movement</DialogTitle>
          <p className="text-sm text-muted-foreground text-left font-normal">
            {items.length} item{items.length !== 1 ? "s" : ""} · {productName}
          </p>
        </DialogHeader>
        <div className="overflow-y-auto flex-1 min-h-0 px-4 sm:px-6 pb-4 sm:pb-6 pt-4">
          {embedMode ? (
            <StockMovementContent key={`${serialKey}\0${productName}`} embedMode={embedMode} />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
