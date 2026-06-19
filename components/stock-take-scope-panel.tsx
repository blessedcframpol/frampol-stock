"use client"

import { useMemo } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ProductNamePicker } from "@/components/product-name-picker"
import type { InventoryItem, StockTakeScope, StockTakeScopePreset } from "@/lib/data"
import { filterOnHandInventory } from "@/lib/inventory-visibility"
import {
  DEFAULT_STOCK_TAKE_STATUSES,
  buildStockTakeScopeLabel,
  filterInventoryForStockTake,
} from "@/lib/stock-take"
import { Filter } from "lucide-react"

const VENDOR_LABELS: Record<string, string> = {
  Starlink: "Starlink",
  Fortinet: "Fortinet",
}

const PRESET_OPTIONS: { value: StockTakeScopePreset; label: string }[] = [
  { value: "full", label: "Full warehouse (In Stock)" },
  { value: "vendor", label: "By vendor" },
  { value: "vendor_product", label: "By vendor and product" },
  { value: "selected", label: "Selected serials only" },
]

type Props = {
  inventory: InventoryItem[]
  preset: StockTakeScopePreset
  onPresetChange: (preset: StockTakeScopePreset) => void
  vendor: string
  onVendorChange: (vendor: string) => void
  productName: string
  onProductNameChange: (name: string) => void
  serialAllowList: string[]
}

export function useStockTakeScope(params: {
  inventory: InventoryItem[]
  preset: StockTakeScopePreset
  vendor: string
  productName: string
  serialAllowList: string[]
}): { scope: StockTakeScope; expectedCount: number; scopeLabel: string } {
  const onHand = useMemo(() => filterOnHandInventory(params.inventory), [params.inventory])

  const scope = useMemo((): StockTakeScope => {
    const base: StockTakeScope = {
      preset: params.preset,
      statuses: DEFAULT_STOCK_TAKE_STATUSES,
    }
    switch (params.preset) {
      case "vendor":
        return {
          ...base,
          vendors: params.vendor ? [params.vendor] : undefined,
        }
      case "vendor_product":
        return {
          ...base,
          vendors: params.vendor ? [params.vendor] : undefined,
          productNames: params.productName.trim() ? [params.productName.trim()] : undefined,
        }
      case "selected":
        return {
          ...base,
          serialAllowList: params.serialAllowList.length > 0 ? params.serialAllowList : undefined,
        }
      case "full":
      default:
        return base
    }
  }, [params.preset, params.vendor, params.productName, params.serialAllowList])

  const expectedCount = useMemo(
    () => filterInventoryForStockTake(onHand, scope).length,
    [onHand, scope]
  )

  const scopeLabel = useMemo(() => buildStockTakeScopeLabel(scope), [scope])

  return { scope, expectedCount, scopeLabel }
}

export function StockTakeScopePanel({
  inventory,
  preset,
  onPresetChange,
  vendor,
  onVendorChange,
  productName,
  onProductNameChange,
  serialAllowList,
}: Props) {
  const onHand = useMemo(() => filterOnHandInventory(inventory), [inventory])
  const { expectedCount, scopeLabel } = useStockTakeScope({
    inventory,
    preset,
    vendor,
    productName,
    serialAllowList,
  })

  const vendorOptions = useMemo(() => {
    const fromInv = onHand.map((i) => (i.vendor?.trim() ? i.vendor.trim() : "General"))
    return [...new Set(["General", ...Object.keys(VENDOR_LABELS), ...fromInv])].sort()
  }, [onHand])

  const productOptions = useMemo(() => {
    if (!vendor) return []
    return [
      ...new Set(
        onHand
          .filter((i) => (i.vendor?.trim() ? i.vendor.trim() : "General") === vendor)
          .map((i) => i.name)
      ),
    ].sort()
  }, [onHand, vendor])

  return (
    <Card className="border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold text-foreground flex items-center gap-2">
          <Filter className="w-4 h-4 text-primary" />
          Scope
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">What to count</Label>
          <Select value={preset} onValueChange={(v) => onPresetChange(v as StockTakeScopePreset)}>
            <SelectTrigger className="bg-card text-foreground border-border">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRESET_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {(preset === "vendor" || preset === "vendor_product") && (
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Vendor</Label>
            <Select value={vendor || ""} onValueChange={onVendorChange}>
              <SelectTrigger className="bg-card text-foreground border-border">
                <SelectValue placeholder="Select vendor" />
              </SelectTrigger>
              <SelectContent>
                {vendorOptions.map((v) => (
                  <SelectItem key={v} value={v}>
                    {VENDOR_LABELS[v] ?? v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {preset === "vendor_product" && (
          <ProductNamePicker
            label="Product group"
            value={productName}
            onChange={onProductNameChange}
            options={productOptions}
            disabled={!vendor}
            placeholder={vendor ? "Select a product…" : "Select vendor first…"}
          />
        )}

        {preset === "selected" && (
          <p className="text-xs text-muted-foreground rounded-md border border-border bg-muted/30 px-3 py-2">
            {serialAllowList.length > 0
              ? `${serialAllowList.length} serial${serialAllowList.length !== 1 ? "s" : ""} from inventory selection.`
              : "Open stock take from Inventory with items selected, or add ?serials=… to the URL."}
          </p>
        )}

        <p className="text-sm text-foreground">
          <span className="font-medium">{scopeLabel}</span>
          <span className="text-muted-foreground"> · Expected {expectedCount} item{expectedCount !== 1 ? "s" : ""}</span>
        </p>
      </CardContent>
    </Card>
  )
}
