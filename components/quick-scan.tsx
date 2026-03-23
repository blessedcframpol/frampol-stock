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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScanBarcode, Camera, Loader2, ChevronsUpDown, Plus, MapPin, Trash2 } from "lucide-react"
import type { ItemType, TransactionType, ClientSite } from "@/lib/data"
import { useClients, insertClient } from "@/lib/supabase/clients-db"
import { useInventoryStore } from "@/lib/inventory-store"
import { toast } from "sonner"
import { cn } from "@/lib/utils"

const OUTBOUND_LIKE_MOVEMENTS: TransactionType[] = ["Sale", "POC Out", "Transfer", "Dispose", "Rentals"]

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
  { value: "Sale", label: "Sale" },
  { value: "POC Out", label: "POC Out" },
  { value: "POC Return", label: "POC Return" },
  { value: "Rentals", label: "Rentals" },
  { value: "Rental Return", label: "Rental Return" },
  { value: "Transfer", label: "Transfer" },
  { value: "Dispose", label: "Dispose" },
]

type PendingOutboundScan = {
  productName: string
  movementType: TransactionType
  serials: string[]
}

/** When outbound scan has serials not in inventory, show this and let user add them first. */
type MissingSerialsState = {
  missing: string[]
  productName: string
  movementType: TransactionType
  allSerials: string[]
}

export function QuickScan() {
  const { inventory, addItem, applyMovement } = useInventoryStore()
  const { clients, refetch: refetchClients } = useClients()
  const [serialInput, setSerialInput] = useState("")
  const [productName, setProductName] = useState("")
  const [movementType, setMovementType] = useState<TransactionType>("Inbound")
  const [open, setOpen] = useState(false)
  const [comboboxSearch, setComboboxSearch] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Client/site details modal (for Sale, POC Out, Rentals, Transfer, Dispose)
  const [pendingOutbound, setPendingOutbound] = useState<PendingOutboundScan | null>(null)
  const [outboundClientId, setOutboundClientId] = useState<string | "new" | "">("")
  const [outboundClientSearch, setOutboundClientSearch] = useState("")
  const [outboundClientOpen, setOutboundClientOpen] = useState(false)
  const [newClientName, setNewClientName] = useState("")
  const [newClientCompany, setNewClientCompany] = useState("")
  const [newClientEmail, setNewClientEmail] = useState("")
  const [newClientPhone, setNewClientPhone] = useState("")
  const [sites, setSites] = useState<ClientSite[]>([{ address: "" }])
  const [outboundReturnDate, setOutboundReturnDate] = useState("")

  // When some serials are not in inventory for outbound: offer to add them first
  const [missingSerialsState, setMissingSerialsState] = useState<MissingSerialsState | null>(null)
  const [addingToInventory, setAddingToInventory] = useState(false)

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

  const inventorySerialSet = useMemo(() => new Set(inventory.map((i) => i.serialNumber)), [inventory])
  const requiresOutboundDetails = OUTBOUND_LIKE_MOVEMENTS.includes(movementType)

  async function handleRecord() {
    const product = productName.trim()
    if (!product) {
      toast.error("Select or enter what's being scanned in (product / item type)")
      return
    }
    if (!movementType) {
      toast.error("Select a stock movement type")
      return
    }
    if (uniqueSerials.length === 0) {
      toast.error("Enter at least one serial number (comma or newline separated)")
      return
    }

    if (requiresOutboundDetails) {
      const missing = uniqueSerials.filter((s) => !inventorySerialSet.has(s))
      if (missing.length > 0) {
        setMissingSerialsState({
          missing,
          productName: product,
          movementType,
          allSerials: uniqueSerials,
        })
        return
      }
      setPendingOutbound({ productName: product, movementType, serials: uniqueSerials })
      setOutboundClientId("")
      setOutboundClientSearch("")
      setOutboundReturnDate("")
      setNewClientName("")
      setNewClientCompany("")
      setNewClientEmail("")
      setNewClientPhone("")
      setSites([{ address: "" }])
      return
    }

    await submitScan(product, movementType, uniqueSerials, undefined)
  }

  async function submitScan(
    product: string,
    movType: TransactionType,
    serials: string[],
    outboundDetails?: {
      clientId?: string
      clientName?: string
      clientCompany?: string
      clientEmail?: string
      clientPhone?: string
      sites?: ClientSite[]
    }
  ) {
    setLastDuplicateMessage(null)
    setIsSubmitting(true)
    try {
      const body: Record<string, unknown> =
        serials.length === 1
          ? { serialNumber: serials[0], scanType: product, movementType: movType }
          : { serialNumbers: serials, scanType: product, movementType: movType }
      if (outboundDetails) {
        if (outboundDetails.clientId) body.clientId = outboundDetails.clientId
        if (outboundDetails.clientName) body.clientName = outboundDetails.clientName
        if (outboundDetails.clientCompany) body.clientCompany = outboundDetails.clientCompany
        if (outboundDetails.clientEmail) body.clientEmail = outboundDetails.clientEmail
        if (outboundDetails.clientPhone) body.clientPhone = outboundDetails.clientPhone
        if (outboundDetails.sites?.length) body.sites = outboundDetails.sites.filter((s) => s.address.trim())
      }
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
            ? `Recorded: ${serials[0]} (${product})`
            : `Recorded ${recorded} scan${recorded !== 1 ? "s" : ""} (${product})`
        )
        setSerialInput("")
        setPendingOutbound(null)
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

  async function recordQuickScan(
    serials: string[],
    product: string,
    movType: TransactionType,
    outboundDetails?: {
      clientId?: string
      clientName?: string
      clientCompany?: string
      clientEmail?: string
      clientPhone?: string
      sites?: ClientSite[]
    }
  ) {
    const body: Record<string, unknown> =
      serials.length === 1
        ? { serialNumber: serials[0], scanType: product, movementType: movType }
        : { serialNumbers: serials, scanType: product, movementType: movType }
    if (outboundDetails) {
      if (outboundDetails.clientId) body.clientId = outboundDetails.clientId
      if (outboundDetails.clientName) body.clientName = outboundDetails.clientName
      if (outboundDetails.clientCompany) body.clientCompany = outboundDetails.clientCompany
      if (outboundDetails.clientEmail) body.clientEmail = outboundDetails.clientEmail
      if (outboundDetails.clientPhone) body.clientPhone = outboundDetails.clientPhone
      if (outboundDetails.sites?.length) body.sites = outboundDetails.sites.filter((s) => s.address.trim())
    }
    await fetch("/api/quick-scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  async function handleOutboundModalSubmit() {
    if (!pendingOutbound) return
    setIsSubmitting(true)
    const selectedClient = outboundClientId && outboundClientId !== "new" ? clients.find((c) => c.id === outboundClientId) : null
    const outboundDetails: {
      clientId?: string
      clientName?: string
      clientCompany?: string
      clientEmail?: string
      clientPhone?: string
      sites?: ClientSite[]
    } = {}
    if (selectedClient) {
      outboundDetails.clientId = selectedClient.id
      outboundDetails.clientName = selectedClient.name
      outboundDetails.clientCompany = selectedClient.company
      outboundDetails.clientEmail = selectedClient.email
      outboundDetails.clientPhone = selectedClient.phone
    } else {
      const name = newClientName.trim()
      const company = newClientCompany.trim()
      const email = newClientEmail.trim()
      const phone = newClientPhone.trim()
      if (!name || !company || !email || !phone) {
        toast.error("All client details are required: name, company, email, and phone")
        return
      }
      const validSitesForNew = sites
        .filter((s) => s.address.trim())
        .map((s) => ({
          ...(s.name?.trim() ? { name: s.name.trim() } : {}),
          address: s.address.trim(),
        }))
      if (validSitesForNew.length === 0) {
        toast.error("Add at least one site address for the new client")
        setIsSubmitting(false)
        return
      }
      try {
        const newClient = await insertClient({
          name,
          company,
          email,
          phone,
          sites: validSitesForNew,
        })
        outboundDetails.clientId = newClient.id
        outboundDetails.clientName = newClient.name
        outboundDetails.clientCompany = newClient.company
        outboundDetails.clientEmail = newClient.email
        outboundDetails.clientPhone = newClient.phone
        await refetchClients()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to save client")
        setIsSubmitting(false)
        return
      }
    }
    const validSites = sites.filter((s) => s.address.trim())
    if (validSites.length > 0) outboundDetails.sites = validSites.map((s) => ({ name: s.name?.trim(), address: s.address.trim() }))

    try {
      const assignedTo = outboundDetails.clientName ?? outboundDetails.clientCompany ?? (outboundDetails.clientId ? clients.find((c) => c.id === outboundDetails.clientId)?.company : undefined)
      const returnDate = (pendingOutbound.movementType === "POC Out" || pendingOutbound.movementType === "Rentals") && outboundReturnDate.trim() ? outboundReturnDate.trim() : undefined
      const result = applyMovement({
        type: pendingOutbound.movementType,
        serialNumbers: pendingOutbound.serials,
        clientId: outboundDetails.clientId,
        assignedTo,
        returnDate,
      })
      if (result.success.length > 0) {
        toast.success(`Recorded ${result.success.length} item(s) — inventory updated`)
        setSerialInput("")
        setPendingOutbound(null)
        setOutboundReturnDate("")
        recordQuickScan(result.success, pendingOutbound.productName, pendingOutbound.movementType, outboundDetails).catch(() => {})
      }
      if (result.notFound.length > 0) {
        toast.warning(`Serial number(s) not found: ${result.notFound.join(", ")}`)
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  function addSite() {
    setSites((prev) => [...prev, { address: "" }])
  }

  function removeSite(index: number) {
    setSites((prev) => prev.filter((_, i) => i !== index))
  }

  function updateSite(index: number, field: "name" | "address", value: string) {
    setSites((prev) => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)))
  }

  function inferItemType(productName: string): ItemType {
    const match = inventory.find((i) => i.name === productName)
    return (match?.itemType ?? "Starlink Kit") as ItemType
  }

  async function handleAddMissingAndContinue() {
    if (!missingSerialsState) return
    setAddingToInventory(true)
    try {
      const { missing, productName, movementType, allSerials } = missingSerialsState
      const itemType = inferItemType(productName)
      const today = new Date().toISOString().slice(0, 10)
      for (const serial of missing) {
        addItem({
          serialNumber: serial,
          itemType,
          name: productName,
          status: "In Stock",
          dateAdded: today,
          location: "Warehouse A",
        })
      }
      toast.success(`${missing.length} item(s) added to inventory. Continue with client details.`)
      setMissingSerialsState(null)
      setPendingOutbound({ productName, movementType, serials: allSerials })
      setOutboundClientId("")
      setOutboundClientSearch("")
      setOutboundReturnDate("")
      setNewClientName("")
      setNewClientCompany("")
      setNewClientEmail("")
      setNewClientPhone("")
      setSites([{ address: "" }])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add items to inventory")
    } finally {
      setAddingToInventory(false)
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
          <Label className="text-xs text-muted-foreground">
            {requiresOutboundDetails ? "Product / item type" : "What's being scanned in"}
          </Label>
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
            disabled={isSubmitting || uniqueSerials.length === 0 || !productName.trim() || !movementType}
          >
          {isSubmitting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            "Record scan"
          )}
        </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {requiresOutboundDetails
            ? "For Sale, POC Out, Rentals, Transfer and Dispose, serials must exist in inventory. You’ll enter client and site details next."
            : "Choose a product, then paste or type serial numbers (e.g. 400 Starlink kits). Use commas or new lines; pasted lines are auto-separated."}
        </p>
      </CardContent>

      <Dialog open={!!missingSerialsState} onOpenChange={(open) => !open && setMissingSerialsState(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Serials not in inventory</DialogTitle>
          </DialogHeader>
          {missingSerialsState && (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                The following serial number(s) are not in the system. Add them to inventory first, then continue with the scan (client & site details).
              </p>
              <ul className="font-mono text-sm bg-muted/50 rounded-md p-3 max-h-40 overflow-y-auto space-y-1">
                {missingSerialsState.missing.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                They will be added as <strong>{missingSerialsState.productName}</strong>, status In Stock, then you can complete the {missingSerialsState.movementType} scan.
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setMissingSerialsState(null)} disabled={addingToInventory}>
                  Cancel
                </Button>
                <Button onClick={handleAddMissingAndContinue} disabled={addingToInventory}>
                  {addingToInventory ? <Loader2 className="w-4 h-4 animate-spin" /> : "Add to inventory & continue"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!pendingOutbound} onOpenChange={(open) => !open && setPendingOutbound(null)}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Client & site details</DialogTitle>
          </DialogHeader>
          {pendingOutbound && (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                {pendingOutbound.serials.length} item(s) · {pendingOutbound.productName} · {pendingOutbound.movementType}
              </p>

              <div className="flex flex-col gap-2">
                <Label className="text-xs font-medium">Client</Label>
                <Popover open={outboundClientOpen} onOpenChange={setOutboundClientOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      className="w-full justify-between h-10 font-normal"
                    >
                      <span className={cn("truncate", !outboundClientId && "text-muted-foreground")}>
                        {outboundClientId === "new"
                          ? "New client (enter details below)"
                          : outboundClientId
                            ? clients.find((c) => c.id === outboundClientId)?.name + " – " + clients.find((c) => c.id === outboundClientId)?.company
                            : "Select or add client..."}
                      </span>
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="min-w-[300px] p-0" align="start">
                    <Command>
                      <CommandInput
                        placeholder="Search clients..."
                        value={outboundClientSearch}
                        onValueChange={setOutboundClientSearch}
                      />
                      <CommandList>
                        <CommandEmpty>No client found.</CommandEmpty>
                        <CommandGroup>
                          <CommandItem
                            value="__new"
                            onSelect={() => {
                              setOutboundClientId("new")
                              setOutboundClientOpen(false)
                            }}
                          >
                            <Plus className="h-4 w-4 mr-2" />
                            Add new client
                          </CommandItem>
                          {clients
                            .filter(
                              (c) =>
                                !outboundClientSearch.trim() ||
                                [c.name, c.company, c.email].some((x) =>
                                  x.toLowerCase().includes(outboundClientSearch.trim().toLowerCase())
                                )
                            )
                            .map((c) => (
                              <CommandItem
                                key={c.id}
                                value={c.id}
                                onSelect={() => {
                                  setOutboundClientId(c.id)
                                  setOutboundClientOpen(false)
                                }}
                              >
                                {c.name} – {c.company}
                              </CommandItem>
                            ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>

              {(pendingOutbound.movementType === "POC Out" || pendingOutbound.movementType === "Rentals") && (
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-medium">Return date (optional)</Label>
                  <Input
                    type="date"
                    value={outboundReturnDate}
                    onChange={(e) => setOutboundReturnDate(e.target.value)}
                    className="h-9"
                  />
                </div>
              )}

              {outboundClientId === "new" && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 rounded-md border border-border bg-muted/30">
                  <div className="sm:col-span-2">
                    <Label className="text-xs">Name (required)</Label>
                    <Input
                      placeholder="Contact name"
                      value={newClientName}
                      onChange={(e) => setNewClientName(e.target.value)}
                      className="mt-1 h-9"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Company (required)</Label>
                    <Input
                      placeholder="Company"
                      value={newClientCompany}
                      onChange={(e) => setNewClientCompany(e.target.value)}
                      className="mt-1 h-9"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Email (required)</Label>
                    <Input
                      type="email"
                      placeholder="email@example.com"
                      value={newClientEmail}
                      onChange={(e) => setNewClientEmail(e.target.value)}
                      className="mt-1 h-9"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <Label className="text-xs">Phone (required)</Label>
                    <Input
                      placeholder="+250 ..."
                      value={newClientPhone}
                      onChange={(e) => setNewClientPhone(e.target.value)}
                      className="mt-1 h-9"
                    />
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-medium flex items-center gap-1.5">
                    <MapPin className="w-3.5 h-3.5" />
                    Site addresses (optional, add multiple)
                  </Label>
                  <Button type="button" variant="ghost" size="sm" className="h-8 text-xs" onClick={addSite}>
                    <Plus className="w-3.5 h-3.5 mr-1" />
                    Add site
                  </Button>
                </div>
                <div className="space-y-2">
                  {sites.map((site, i) => (
                    <div key={i} className="flex gap-2 items-start">
                      <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <Input
                          placeholder="Site name (e.g. HQ, Branch A)"
                          value={site.name ?? ""}
                          onChange={(e) => updateSite(i, "name", e.target.value)}
                          className="h-9"
                        />
                        <Input
                          placeholder="Full address"
                          value={site.address}
                          onChange={(e) => updateSite(i, "address", e.target.value)}
                          className="h-9 sm:col-span-1"
                        />
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() => removeSite(i)}
                        disabled={sites.length <= 1}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setPendingOutbound(null)}>
                  Cancel
                </Button>
                <Button onClick={handleOutboundModalSubmit} disabled={isSubmitting}>
                  {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : "Record scan"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  )
}
