"use client"

import { useState, useMemo, useRef } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ScanBarcode, Camera, Loader2, ChevronsUpDown, Plus } from "lucide-react"
import type { ItemType, TransactionType } from "@/lib/data"
import { useInventoryStore } from "@/lib/inventory-store"
import { toast } from "sonner"
import { cn } from "@/lib/utils"

const ITEM_TYPE_OPTIONS: { value: ItemType; label: string }[] = [
  { value: "Starlink Kit", label: "Starlink Kit" },
  { value: "Laptop", label: "Laptop" },
  { value: "Desktop", label: "Desktop" },
  { value: "Router", label: "Router" },
  { value: "Switch", label: "Switch" },
  { value: "Access Point", label: "Access Point" },
  { value: "UPS", label: "UPS" },
  { value: "Monitor", label: "Monitor" },
]

const MOVEMENT_TYPE_OPTIONS: { value: TransactionType; label: string }[] = [
  { value: "Inbound", label: "Inbound" },
  { value: "Outbound", label: "Outbound" },
  { value: "POC Out", label: "POC Out" },
  { value: "POC Return", label: "POC Return" },
  { value: "Transfer", label: "Transfer" },
  { value: "Dispose", label: "Dispose" },
]

export function QuickScan() {
  const { inventory } = useInventoryStore()
  const [serialInput, setSerialInput] = useState("")
  const [productName, setProductName] = useState("")
  const [movementType, setMovementType] = useState<TransactionType>("Inbound")
  const [open, setOpen] = useState(false)
  const [comboboxSearch, setComboboxSearch] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const serialList = useMemo(() => {
    return serialInput
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  }, [serialInput])

  const uniqueSerials = useMemo(() => [...new Set(serialList)], [serialList])
  const inListDuplicateCount = serialList.length - uniqueSerials.length
  const [lastDuplicateMessage, setLastDuplicateMessage] = useState<string[] | null>(null)

  function handleSerialChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value
    setSerialInput(v.includes("\n") ? v.replace(/\n+/g, ", ").replace(/,+\s*,/g, ", ") : v)
    if (!v.trim()) setLastDuplicateMessage(null)
  }

  function handleSerialPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = e.clipboardData.getData("text")
    if (pasted.includes("\n") || pasted.includes(",")) {
      e.preventDefault()
      const normalized = pasted
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .join(", ")
      setSerialInput((prev) => (prev ? `${prev}, ${normalized}` : normalized))
    }
  }

  const productNames = useMemo(() => {
    const names = new Set<string>()
    inventory.forEach((item) => names.add(item.name))
    return Array.from(names).sort()
  }, [inventory])

  const allOptions = useMemo(() => {
    const fromInventory = productNames
    const types = ITEM_TYPE_OPTIONS.map((o) => o.label)
    const combined = [...fromInventory]
    types.forEach((t) => {
      if (!combined.includes(t)) combined.push(t)
    })
    return combined.sort()
  }, [productNames])

  async function handleRecord() {
    const product = productName.trim()
    if (!product) {
      toast.error("Select or enter a product / item type")
      return
    }
    if (uniqueSerials.length === 0) {
      toast.error("Enter at least one serial number (comma or newline separated)")
      return
    }

    setLastDuplicateMessage(null)
    setIsSubmitting(true)
    try {
      const body =
        uniqueSerials.length === 1
          ? { serialNumber: uniqueSerials[0], scanType: product, movementType }
          : { serialNumbers: uniqueSerials, scanType: product, movementType }
      const res = await fetch("/api/quick-scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        toast.error(data.error ?? "Failed to record scan")
        return
      }

      if (data.duplicate === true) {
        toast.warning(`${data.serialNumber ?? "Serial"} already scanned`)
        return
      }

      const recorded = data.recorded ?? (data.id ? 1 : 0)
      const duplicates: string[] = data.duplicates ?? []
      if (duplicates.length > 0) setLastDuplicateMessage(duplicates)

      if (recorded > 0) {
        toast.success(
          recorded === 1
            ? `Recorded: ${uniqueSerials[0]} (${product})`
            : `Recorded ${recorded} scan${recorded !== 1 ? "s" : ""} (${product})`
        )
        setSerialInput("")
        textareaRef.current?.focus()
      } else if (duplicates.length > 0) {
        toast.info(`All ${duplicates.length} serial(s) were already scanned`)
      }
    } catch {
      toast.error("Failed to record scan")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Card className="h-full min-h-[300px] sm:min-h-[340px] flex flex-col border-dashed border-primary/30 bg-primary/[0.02]">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold text-foreground flex items-center gap-2">
          <ScanBarcode className="w-4 h-4 text-primary" />
          Quick Scan
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 flex-1">
        <div className="flex flex-col gap-2">
          <Label className="text-xs text-muted-foreground">Stock movement type</Label>
          <Select value={movementType} onValueChange={(v) => setMovementType(v as TransactionType)}>
            <SelectTrigger className="w-full h-10 bg-card border-border text-foreground">
              <SelectValue placeholder="Movement type..." />
            </SelectTrigger>
            <SelectContent>
              {MOVEMENT_TYPE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label className="text-xs text-muted-foreground">What&apos;s being scanned in</Label>
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                role="combobox"
                aria-expanded={open}
                className="w-full justify-between h-10 bg-card border-border text-foreground font-normal"
              >
                <span className={cn("truncate", !productName && "text-muted-foreground")}>
                  {productName || "Select or search product..."}
                </span>
                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="min-w-[280px] p-0" align="start">
              <Command shouldFilter={false}>
                <CommandInput
                  placeholder="Search products..."
                  value={comboboxSearch}
                  onValueChange={setComboboxSearch}
                />
                <CommandList>
                  <CommandEmpty>
                    <span className="py-6 text-center text-sm text-muted-foreground block">
                      Type to search or add a new product below.
                    </span>
                  </CommandEmpty>
                  {(() => {
                    const q = comboboxSearch.trim().toLowerCase()
                    const filtered = q
                      ? allOptions.filter((name) => name.toLowerCase().includes(q))
                      : allOptions
                    const canAdd = q && !allOptions.some((o) => o.toLowerCase() === q)
                    return (
                      <>
                        {filtered.length > 0 && (
                          <CommandGroup heading="Products & types">
                            {filtered.map((name) => (
                              <CommandItem
                                key={name}
                                value={name}
                                onSelect={() => {
                                  setProductName(name)
                                  setComboboxSearch("")
                                  setOpen(false)
                                }}
                              >
                                {name}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        )}
                        {canAdd && (
                          <CommandGroup>
                            <CommandItem
                              value={`__add:${comboboxSearch.trim()}`}
                              onSelect={() => {
                                setProductName(comboboxSearch.trim())
                                setComboboxSearch("")
                                setOpen(false)
                              }}
                              className="text-primary gap-2"
                            >
                              <Plus className="h-4 w-4" />
                              Add &quot;{comboboxSearch.trim()}&quot; as new product
                            </CommandItem>
                          </CommandGroup>
                        )}
                      </>
                    )
                  })()}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
        <div className="flex flex-col gap-2">
          <Label className="text-xs text-muted-foreground">
            Serial numbers (comma or newline separated; paste a list to add commas)
          </Label>
          <Textarea
            ref={textareaRef}
            placeholder="SL-001, SL-002, SL-003 or one per line..."
            className="font-mono text-sm min-h-[80px] bg-card border-border resize-y"
            value={serialInput}
            onChange={handleSerialChange}
            onPaste={handleSerialPaste}
            disabled={isSubmitting}
          />
          {serialList.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">
                {uniqueSerials.length} item{uniqueSerials.length !== 1 ? "s" : ""} to scan
              </span>
              {inListDuplicateCount > 0 && (
                <span>
                  ({inListDuplicateCount} duplicate{inListDuplicateCount !== 1 ? "s" : ""} in list, will submit unique only)
                </span>
              )}
            </div>
          )}
          {lastDuplicateMessage && lastDuplicateMessage.length > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400 bg-amber-500/10 rounded-md px-2 py-1.5">
              Already scanned (not added): {lastDuplicateMessage.slice(0, 5).join(", ")}
              {lastDuplicateMessage.length > 5 && ` +${lastDuplicateMessage.length - 5} more`}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            size="icon"
            className="h-10 w-10 shrink-0 bg-primary text-primary-foreground hover:bg-primary/90"
            title="Open camera scanner"
            disabled={isSubmitting}
          >
            <Camera className="w-4 h-4" />
            <span className="sr-only">Open camera scanner</span>
          </Button>
          <Button
            className="flex-1"
            size="sm"
            onClick={handleRecord}
            disabled={isSubmitting || uniqueSerials.length === 0 || !productName.trim()}
          >
          {isSubmitting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            "Record scan"
          )}
        </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Choose a product, then paste or type serial numbers (e.g. 400 Starlink kits). Use commas or new lines; pasted lines are auto-separated.
        </p>
      </CardContent>
    </Card>
  )
}
