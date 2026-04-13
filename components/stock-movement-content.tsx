"use client"

import { useState, useMemo, useRef, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { LOCATIONS, INTERNAL_LOCATIONS } from "@/lib/data"
import type { DeviceTypeName, TransactionType, ClientSite } from "@/lib/data"
import { useClients, insertClient } from "@/lib/supabase/clients-db"
import { useInventoryStore } from "@/lib/inventory-store"
import {
  ScanBarcode,
  FileText,
  Package,
  ChevronsUpDown,
  Plus,
  MapPin,
  Loader2,
  Upload,
  X,
  Trash2,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"
import { getSupabaseClient } from "@/lib/supabase/client"
import type { InboundCreateDefaults } from "@/lib/supabase/movement-utils"
import { isFortigateProductName, splitDelimitedValues, cloudKeysMapForSerials } from "@/lib/fortigate"
import { useAuth } from "@/lib/auth-context"
import { canManageUsers } from "@/lib/permissions"
import {
  OUTBOUND_LIKE_MOVEMENTS,
  NEW_CLIENT_SELECT,
  DEVICE_TYPE_OPTIONS,
  TRANSACTION_TYPE_CHOICES,
} from "@/lib/stock-movement-form-logic"

const transactionTypes = TRANSACTION_TYPE_CHOICES

type PendingOutbound = { productName: string; movementType: string; serials: string[] }
type MissingSerialsState = { missing: string[]; productName: string; movementType: string; allSerials: string[] }

export type StockMovementEmbedMode = {
  fixedSerials: string[]
  fixedProductName: string
  /** When set, must be a non-Inbound type for inventory embed. */
  initialMovementType?: string
  /** From inventory row(s): guard existing serials against wrong vendor (embed). */
  expectedVendor?: string
  /** From inventory row(s): guard existing serials against wrong device type (embed). */
  expectedDeviceType?: string
  onClose?: () => void
}

export function StockMovementContent({ embedMode }: { embedMode?: StockMovementEmbedMode }) {
  const isEmbed = Boolean(embedMode)
  const { inventory, applyMovement, addItem, deviceTypes, refetchLedger } = useInventoryStore()
  const { clients, refetch: refetchClients } = useClients()
  const { role } = useAuth()
  const isAdmin = canManageUsers(role)
  const [selectedType, setSelectedType] = useState<string>("Inbound")
  const [serialNumbers, setSerialNumbers] = useState("")
  const [productName, setProductName] = useState("")
  const [productOpen, setProductOpen] = useState(false)
  const [comboboxSearch, setComboboxSearch] = useState("")
  const [clientId, setClientId] = useState<string>("")
  const [invoiceNumber, setInvoiceNumber] = useState("")
  const [notes, setNotes] = useState("")
  const [fromLocation, setFromLocation] = useState<string>("")
  const [toLocation, setToLocation] = useState<string>("")
  const [rentalReturnDate, setRentalReturnDate] = useState("")
  const [pocEndDate, setPocEndDate] = useState("")
  const [disposalReason, setDisposalReason] = useState("")
  const [authorisedBy, setAuthorisedBy] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [lastDuplicateMessage, setLastDuplicateMessage] = useState<string[] | null>(null)
  const [missingSerialsState, setMissingSerialsState] = useState<MissingSerialsState | null>(null)
  const [pendingOutbound, setPendingOutbound] = useState<PendingOutbound | null>(null)
  const [outboundClientId, setOutboundClientId] = useState<string | "new" | "">("")
  const [outboundClientSearch, setOutboundClientSearch] = useState("")
  const [outboundClientOpen, setOutboundClientOpen] = useState(false)
  const [newClientName, setNewClientName] = useState("")
  const [newClientCompany, setNewClientCompany] = useState("")
  const [newClientEmail, setNewClientEmail] = useState("")
  const [newClientPhone, setNewClientPhone] = useState("")
  const [sites, setSites] = useState<ClientSite[]>([{ address: "" }])
  const [addingToInventory, setAddingToInventory] = useState(false)
  const [deliveryNoteFile, setDeliveryNoteFile] = useState<File | null>(null)
  const [inboundReceiveLocation, setInboundReceiveLocation] = useState<string>("Warehouse A")
  const [inboundVendor, setInboundVendor] = useState<string>("General")
  const outboundCloudKeysRef = useRef<Record<string, string> | undefined>(undefined)
  const [cloudKeysInput, setCloudKeysInput] = useState("")
  const [mainNewClientName, setMainNewClientName] = useState("")
  const [mainNewClientCompany, setMainNewClientCompany] = useState("")
  const [mainNewClientEmail, setMainNewClientEmail] = useState("")
  const [mainNewClientPhone, setMainNewClientPhone] = useState("")
  const [mainClientSites, setMainClientSites] = useState<ClientSite[]>([{ address: "" }])
  /** TEMPORARY (admin): optional sale ledger date until stock-requests workflow */
  const [adminSaleDate, setAdminSaleDate] = useState("")

  useEffect(() => {
    if (!embedMode) return
    setSerialNumbers(embedMode.fixedSerials.join(", "))
    setProductName(embedMode.fixedProductName)
    const allowed = TRANSACTION_TYPE_CHOICES.filter((t) => t.value !== "Inbound").map((t) => t.value)
    const init = embedMode.initialMovementType
    setSelectedType(init && allowed.includes(init) ? init : "Transfer")
  }, [embedMode])

  const serialsList = useMemo(
    () =>
      serialNumbers
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    [serialNumbers]
  )
  const uniqueSerials = useMemo(() => [...new Set(serialsList)], [serialsList])
  const inListDuplicateCount = serialsList.length - uniqueSerials.length
  const scannedCount = uniqueSerials.length
  const clientDisplay =
    !clientId || clientId === NEW_CLIENT_SELECT
      ? clientId === NEW_CLIENT_SELECT
        ? "New client (unsaved)"
        : "Not selected"
      : clients.find((c) => c.id === clientId)?.company ?? clientId

  const productNames = useMemo(() => {
    const names = new Set<string>()
    inventory.forEach((item) => names.add(item.name))
    return Array.from(names).sort()
  }, [inventory])
  const allOptions = useMemo(() => {
    const types = DEVICE_TYPE_OPTIONS.map((o) => o.label)
    const combined = [...productNames]
    types.forEach((t) => {
      if (!combined.includes(t)) combined.push(t)
    })
    return combined.sort()
  }, [productNames])
  const inventorySerialSet = useMemo(() => new Set(inventory.map((i) => i.serialNumber)), [inventory])
  const requiresOutboundDetails = OUTBOUND_LIKE_MOVEMENTS.includes(selectedType as TransactionType)

  const inboundVendorOptions = useMemo(() => {
    const fromInv = inventory
      .map((i) => (i.vendor?.trim() ? i.vendor.trim() : null))
      .filter((c): c is string => Boolean(c))
    return [...new Set(["General", ...fromInv])].sort()
  }, [inventory])

  function handleSerialChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value
    setSerialNumbers(v.includes("\n") ? v.replace(/\n+/g, ", ").replace(/,+\s*,/g, ", ") : v)
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
      setSerialNumbers((prev) => (prev ? `${prev}, ${normalized}` : normalized))
    }
  }

  function inferDeviceType(name: string): DeviceTypeName {
    const matchInv = inventory.find((i) => i.name === name)
    if (matchInv?.deviceType) return matchInv.deviceType as DeviceTypeName
    const opt = DEVICE_TYPE_OPTIONS.find((o) => o.label === name)
    if (opt) return opt.value
    return "Starlink Kit"
  }

  async function handleAddMissingAndContinue() {
    if (!missingSerialsState) return
    setAddingToInventory(true)
    try {
      const { missing, productName: pn, movementType, allSerials } = missingSerialsState
      const deviceType = inferDeviceType(pn)
      const today = new Date().toISOString().slice(0, 10)
      for (const serial of missing) {
        addItem({
          serialNumber: serial,
          deviceType,
          name: pn,
          status: "In Stock",
          dateAdded: today,
          location: "Warehouse A",
        })
      }
      toast.success(`${missing.length} item(s) added to inventory. Continue with client details.`)
      setMissingSerialsState(null)
      setPendingOutbound({ productName: pn, movementType, serials: allSerials })
      setOutboundClientId("")
      setOutboundClientSearch("")
      setNewClientName("")
      setNewClientCompany("")
      setNewClientEmail("")
      setNewClientPhone("")
      setSites([{ address: "" }])
    } catch (e) {
      toastFromCaughtError(e, "Failed to add items to inventory")
    } finally {
      setAddingToInventory(false)
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

  function addMainClientSite() {
    setMainClientSites((prev) => [...prev, { address: "" }])
  }
  function removeMainClientSite(index: number) {
    setMainClientSites((prev) => prev.filter((_, i) => i !== index))
  }
  function updateMainClientSite(index: number, field: "name" | "address", value: string) {
    setMainClientSites((prev) => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)))
  }

  function doSubmit(
    outboundDetails?: {
      clientId?: string
      clientName?: string
      clientCompany?: string
      clientEmail?: string
      clientPhone?: string
      sites?: ClientSite[]
    },
    deliveryNoteUrl?: string
  ) {
    setLastDuplicateMessage(null)
    setIsSubmitting(true)
    const cloudKeysBySerial = outboundCloudKeysRef.current
    outboundCloudKeysRef.current = undefined
    const list = pendingOutbound ? pendingOutbound.serials : uniqueSerials
    const effectiveClientId = (outboundDetails?.clientId ?? clientId) || undefined
    const clientRow = effectiveClientId ? clients.find((c) => c.id === effectiveClientId) : undefined
    const clientDisplayOverride =
      clientRow
        ? `${clientRow.name} - ${clientRow.company}`
        : effectiveClientId && outboundDetails?.clientName && outboundDetails?.clientCompany
          ? `${outboundDetails.clientName} - ${outboundDetails.clientCompany}`
          : undefined
    const pn = productName.trim()
    let inboundDefaults: InboundCreateDefaults | undefined
    if (selectedType === "Inbound") {
      const it = inferDeviceType(pn)
      inboundDefaults = {
        name: pn,
        deviceType: it,
        vendor: inboundVendor.trim() || "General",
        location: inboundReceiveLocation.trim() || "Warehouse A",
        deviceTypeId:
          deviceTypes.find((pt) => pt.name.toLowerCase() === it.toLowerCase())?.id ??
          deviceTypes.find((pt) => pt.name === "General")?.id,
      }
    } else {
      inboundDefaults = undefined
    }
    const result = applyMovement({
      type: selectedType as "Inbound" | "Sale" | "POC Out" | "POC Return" | "Rental Return" | "Rentals" | "Transfer" | "Dispose",
      serialNumbers: list,
      clientId: effectiveClientId,
      clientDisplayOverride,
      fromLocation: selectedType === "Transfer" ? fromLocation : undefined,
      toLocation: (selectedType === "Transfer" || selectedType === "POC Return" || selectedType === "Rental Return") ? toLocation || undefined : undefined,
      assignedTo: (outboundDetails?.clientName ?? outboundDetails?.clientCompany) ?? (clientId ? clients.find((c) => c.id === clientId)?.company : undefined),
      invoiceNumber: invoiceNumber.trim() || undefined,
      notes: notes.trim() || undefined,
      returnDate:
        selectedType === "Rentals" && rentalReturnDate.trim()
          ? rentalReturnDate.trim()
          : selectedType === "POC Out" && pocEndDate.trim()
            ? pocEndDate.trim()
            : undefined,
      disposalReason: selectedType === "Dispose" ? disposalReason.trim() || undefined : undefined,
      authorisedBy: selectedType === "Dispose" ? authorisedBy.trim() || undefined : undefined,
      deliveryNoteUrl: selectedType === "Inbound" ? deliveryNoteUrl : undefined,
      inboundCreateDefaults: inboundDefaults,
      cloudKeysBySerial,
      saleTransactionDateIso:
        selectedType === "Sale" && isAdmin && adminSaleDate.trim() ? adminSaleDate.trim() : undefined,
      ...(pn ? { expectedProductName: pn } : {}),
      ...(selectedType === "Inbound"
        ? {
            expectedVendor:
              isEmbed && embedMode?.expectedVendor !== undefined
                ? embedMode.expectedVendor
                : inboundVendor.trim() || "General",
          }
        : {}),
      ...(isEmbed && embedMode?.expectedDeviceType !== undefined
        ? { expectedDeviceType: embedMode.expectedDeviceType }
        : {}),
    })
    if (result.success.length > 0) {
      toast.success(`Recorded ${result.success.length} item(s)`)
      void refetchLedger()
      embedMode?.onClose?.()
      if (isEmbed) {
        setPendingOutbound(null)
        setIsSubmitting(false)
        return
      }
      setSerialNumbers("")
      setProductName("")
      setInvoiceNumber("")
      setNotes("")
      if (selectedType === "Dispose") {
        setDisposalReason("")
        setAuthorisedBy("")
      }
      if (selectedType === "Inbound") setDeliveryNoteFile(null)
      if (OUTBOUND_LIKE_MOVEMENTS.includes(selectedType as TransactionType)) {
        setCloudKeysInput("")
      }
      if (selectedType === "Sale") setAdminSaleDate("")
      setPendingOutbound(null)
    }
    if (result.notFound.length > 0) {
      toast.warning(`Serial number(s) not found: ${result.notFound.join(", ")}`)
      setLastDuplicateMessage(result.notFound)
    }
    setIsSubmitting(false)
  }

  async function handleOutboundModalSubmit() {
    if (!pendingOutbound) return
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
        toastFromCaughtError(e, "Failed to save client")
        return
      }
    }
    const validSites = sites.filter((s) => s.address.trim())
    if (validSites.length > 0) outboundDetails.sites = validSites.map((s) => ({ name: s.name?.trim(), address: s.address.trim() }))
    doSubmit(outboundDetails)
  }

  async function uploadDeliveryNote(file: File): Promise<string> {
    const supabase = getSupabaseClient()
    const ext = file.name.split(".").pop() || "pdf"
    const path = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${ext}`
    const { error } = await supabase.storage.from("uploads").upload(path, file, {
      contentType: file.type || "application/pdf",
      upsert: false,
    })
    if (error) throw error
    const { data } = supabase.storage.from("uploads").getPublicUrl(path)
    return data.publicUrl
  }

  async function handleSubmit() {
    if (!productName.trim()) {
      toast.error("Select or enter product (name or device type)")
      return
    }
    if (uniqueSerials.length === 0) {
      toast.error("Scan or enter at least one serial number")
      return
    }
    if (selectedType === "Transfer" && (!fromLocation || !toLocation)) {
      toast.error("Select From and To location for transfer")
      return
    }
    if (selectedType === "Transfer" && fromLocation === toLocation) {
      toast.error("From and To locations must be different")
      return
    }
    if ((selectedType === "POC Return" || selectedType === "Rental Return") && !toLocation) {
      toast.error("Select return location")
      return
    }
    if ((selectedType === "Sale" || selectedType === "Rentals") && !invoiceNumber.trim()) {
      toast.error("Invoice number is required for Sale and Rentals")
      return
    }
    if (selectedType === "Dispose") {
      if (!disposalReason.trim()) {
        toast.error("Disposal reason is required")
        return
      }
      if (!authorisedBy.trim()) {
        toast.error("Authorised by is required for disposal")
        return
      }
    }

    let resolvedClientId = clientId

    if (requiresOutboundDetails) {
      if (clientId === NEW_CLIENT_SELECT) {
        const name = mainNewClientName.trim()
        const company = mainNewClientCompany.trim()
        const email = mainNewClientEmail.trim()
        const phone = mainNewClientPhone.trim()
        if (!name || !company || !email || !phone) {
          toast.error("New client: name, company, email, and phone are all required")
          return
        }
        const validSitesForNew = mainClientSites
          .filter((s) => s.address.trim())
          .map((s) => ({
            ...(s.name?.trim() ? { name: s.name.trim() } : {}),
            address: s.address.trim(),
          }))
        if (validSitesForNew.length === 0) {
          toast.error("Add at least one site address for the new client")
          return
        }
        setIsSubmitting(true)
        try {
          const nc = await insertClient({
            name,
            company,
            email,
            phone,
            sites: validSitesForNew,
          })
          await refetchClients()
          resolvedClientId = nc.id
          setClientId(nc.id)
        } catch (e) {
          toastFromCaughtError(e, "Failed to save client")
          return
        } finally {
          setIsSubmitting(false)
        }
      } else if (
        (selectedType === "Sale" || selectedType === "POC Out" || selectedType === "Rentals") &&
        !clientId
      ) {
        toast.error("Select a client or choose Add new client")
        return
      }

      if (isFortigateProductName(productName.trim())) {
        const keys = splitDelimitedValues(cloudKeysInput)
        const map = cloudKeysMapForSerials(uniqueSerials, keys)
        if (!map) {
          toast.error(
            `Cloud keys (FortiGate): enter exactly ${uniqueSerials.length} non-empty key(s) in the same order as the serials (comma or newline separated).`
          )
          return
        }
        outboundCloudKeysRef.current = map
      } else {
        outboundCloudKeysRef.current = undefined
      }
    } else {
      outboundCloudKeysRef.current = undefined
    }

    if (!requiresOutboundDetails) {
      if (selectedType === "Inbound" && deliveryNoteFile) {
        setIsSubmitting(true)
        try {
          const url = await uploadDeliveryNote(deliveryNoteFile)
          doSubmit(undefined, url)
        } catch (e) {
          toastFromCaughtError(
            e,
            "Failed to upload delivery note. Ensure Supabase is configured and the uploads bucket exists."
          )
          setIsSubmitting(false)
        }
      } else {
        doSubmit()
      }
      return
    }
    const missing = uniqueSerials.filter((s) => !inventorySerialSet.has(s))
    if (missing.length > 0) {
      if (isEmbed) {
        toast.error(`Serial(s) not in inventory: ${missing.join(", ")}`)
        return
      }
      setMissingSerialsState({
        missing,
        productName: productName.trim(),
        movementType: selectedType,
        allSerials: uniqueSerials,
      })
      return
    }
    setPendingOutbound({
      productName: productName.trim(),
      movementType: selectedType,
      serials: uniqueSerials,
    })
    setOutboundClientId(resolvedClientId || "")
    setOutboundClientSearch("")
    setNewClientName("")
    setNewClientCompany("")
    setNewClientEmail("")
    setNewClientPhone("")
    setSites([{ address: "" }])
  }

  const typesForUi = isEmbed ? transactionTypes.filter((t) => t.value !== "Inbound") : transactionTypes

  return (
    <div className="flex flex-col gap-4 md:gap-6 min-w-0">
      {/* Header */}
      {!isEmbed && (
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-foreground tracking-tight text-balance">Inventory Movement</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Record inbound and outbound (sale, POC, rental, transfer) stock transactions.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-6">
        {/* Left: Form */}
        <div className="lg:col-span-2 flex flex-col gap-4 md:gap-5">
          {/* Transaction Type — same height as Transaction Summary */}
          <Card className="min-h-[260px] lg:min-h-[280px] flex flex-col">
            <CardHeader className="pb-2">
              <CardTitle className="text-base font-semibold text-foreground">Transaction Type</CardTitle>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col min-h-0">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 sm:gap-2 flex-1 content-start">
                {typesForUi.map((type) => {
                  const Icon = type.icon
                  const isActive = selectedType === type.value
                  return (
                    <button
                      key={type.value}
                      onClick={() => setSelectedType(type.value)}
                      className={cn(
                        "flex flex-col items-center gap-1 p-2 sm:p-2.5 rounded-lg border-2 transition-all text-center",
                        isActive
                          ? "border-primary bg-primary/5"
                          : "border-border hover:border-primary/30 bg-card"
                      )}
                    >
                      <div className={cn("flex items-center justify-center w-7 sm:w-8 h-7 sm:h-8 rounded-md", type.bg)}>
                        <Icon className={cn("w-3.5 sm:w-4 h-3.5 sm:h-4", type.color)} />
                      </div>
                      <span
                        className={cn(
                          "text-[11px] sm:text-xs font-medium",
                          isActive ? "text-foreground font-semibold" : "text-foreground"
                        )}
                      >
                        {type.label}
                      </span>
                      <span className="text-[9px] text-muted-foreground leading-tight hidden sm:block">{type.desc}</span>
                    </button>
                  )
                })}
              </div>
            </CardContent>
          </Card>

          {/* Scan Input */}
          <Card className="border-dashed border-primary/30 bg-primary/[0.02]">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold text-foreground flex items-center gap-2">
                <ScanBarcode className="w-4 h-4 text-primary" />
                {isEmbed ? "Selected items" : "Scan Items"}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {isEmbed ? (
                <>
                  <div>
                    <Label className="text-xs text-muted-foreground">Product</Label>
                    <p className="text-sm font-medium text-foreground mt-1">{productName}</p>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Serial numbers ({uniqueSerials.length})</Label>
                    <p className="text-xs font-mono text-foreground mt-1 break-words">{uniqueSerials.join(", ")}</p>
                  </div>
                </>
              ) : (
                <>
              <div className="flex flex-col gap-2">
                <Label className="text-xs text-muted-foreground">Product (name or device type)</Label>
                <Popover open={productOpen} onOpenChange={setProductOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={productOpen}
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
                          const filtered = q ? allOptions.filter((name) => name.toLowerCase().includes(q)) : allOptions
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
                                        setProductOpen(false)
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
                                      setProductOpen(false)
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
                  placeholder="SL-001, SL-002, SL-003 or one per line..."
                  value={serialNumbers}
                  onChange={handleSerialChange}
                  onPaste={handleSerialPaste}
                  disabled={isSubmitting}
                  className="font-mono text-xs min-h-[100px] sm:min-h-[120px] bg-card text-foreground border-border"
                />
                {serialsList.length > 0 && (
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
                    Not found (not recorded): {lastDuplicateMessage.slice(0, 5).join(", ")}
                    {lastDuplicateMessage.length > 5 && ` +${lastDuplicateMessage.length - 5} more`}
                  </p>
                )}
              </div>
              {scannedCount > 0 && (
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="text-xs bg-primary/10 text-primary border-0">
                    {scannedCount} item{scannedCount !== 1 ? "s" : ""} scanned
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => { setSerialNumbers(""); setLastDuplicateMessage(null) }}
                  >
                    Clear all
                  </Button>
                </div>
              )}
                </>
              )}
            </CardContent>
          </Card>

          {/* Additional Details */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold text-foreground flex items-center gap-2">
                <FileText className="w-4 h-4 text-muted-foreground" />
                Transaction Details
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {selectedType === "Inbound" && (
                <div className="flex flex-col gap-2">
                  <Label className="text-foreground flex items-center gap-2">
                    <Upload className="w-4 h-4 text-muted-foreground" />
                    Delivery note (optional)
                  </Label>
                  {!deliveryNoteFile ? (
                    <div className="flex items-center gap-2">
                      <Input
                        type="file"
                        accept=".pdf,image/jpeg,image/png,image/webp,application/pdf"
                        className="cursor-pointer text-sm file:mr-2 file:rounded-md file:border-0 file:bg-primary/10 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-primary"
                        onChange={(e) => {
                          const f = e.target.files?.[0]
                          if (f) setDeliveryNoteFile(f)
                          e.target.value = ""
                        }}
                      />
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
                      <span className="truncate text-foreground">{deliveryNoteFile.name}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 shrink-0 text-muted-foreground hover:text-foreground"
                        onClick={() => setDeliveryNoteFile(null)}
                        aria-label="Remove delivery note"
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">PDF or image (JPEG, PNG, WebP). Attached to this inbound delivery.</p>
                </div>
              )}
              {selectedType === "Inbound" && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="flex flex-col gap-2">
                    <Label className="text-foreground">Receive location</Label>
                    <Select value={inboundReceiveLocation} onValueChange={setInboundReceiveLocation}>
                      <SelectTrigger className="bg-card text-foreground border-border">
                        <SelectValue placeholder="Location" />
                      </SelectTrigger>
                      <SelectContent>
                        {INTERNAL_LOCATIONS.map((loc) => (
                          <SelectItem key={loc} value={loc}>
                            {loc}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label className="text-foreground">Vendor</Label>
                    <Select value={inboundVendor} onValueChange={setInboundVendor}>
                      <SelectTrigger className="bg-card text-foreground border-border">
                        <SelectValue placeholder="Vendor" />
                      </SelectTrigger>
                      <SelectContent>
                        {inboundVendorOptions.map((cat) => (
                          <SelectItem key={cat} value={cat}>
                            {cat}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
              {(selectedType === "Sale" || selectedType === "POC Out" || selectedType === "Rentals" || selectedType === "Transfer" || selectedType === "Dispose") && (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-2">
                    <Label className="text-foreground">Client / Customer (assigned to)</Label>
                    <Select
                      value={clientId === NEW_CLIENT_SELECT ? NEW_CLIENT_SELECT : clientId || undefined}
                      onValueChange={(v) => {
                        setClientId(v)
                        if (v !== NEW_CLIENT_SELECT) {
                          setMainNewClientName("")
                          setMainNewClientCompany("")
                          setMainNewClientEmail("")
                          setMainNewClientPhone("")
                          setMainClientSites([{ address: "" }])
                        }
                      }}
                    >
                      <SelectTrigger className="bg-card text-foreground border-border">
                        <SelectValue placeholder="Select existing client or add new…" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NEW_CLIENT_SELECT} className="text-primary">
                          <span className="flex items-center gap-2">
                            <Plus className="h-3.5 w-3.5" />
                            Add new client…
                          </span>
                        </SelectItem>
                        {clients.map((client) => (
                          <SelectItem key={client.id} value={client.id}>
                            {client.name} – {client.company}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {clients.length === 0
                        ? "No clients in the directory yet — use Add new client or add one from the Clients page."
                        : "Pick a client here or add a new one before submitting. You can confirm sites in the next step."}
                    </p>
                  </div>
                  {clientId === NEW_CLIENT_SELECT && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 rounded-lg border border-border bg-muted/30">
                      <div className="sm:col-span-2">
                        <Label className="text-xs">Contact name (required)</Label>
                        <Input
                          className="mt-1 bg-card"
                          value={mainNewClientName}
                          onChange={(e) => setMainNewClientName(e.target.value)}
                          placeholder="Name"
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Company (required)</Label>
                        <Input
                          className="mt-1 bg-card"
                          value={mainNewClientCompany}
                          onChange={(e) => setMainNewClientCompany(e.target.value)}
                          placeholder="Company"
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Email (required)</Label>
                        <Input
                          type="email"
                          className="mt-1 bg-card"
                          value={mainNewClientEmail}
                          onChange={(e) => setMainNewClientEmail(e.target.value)}
                          placeholder="email@example.com"
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <Label className="text-xs">Phone (required)</Label>
                        <Input
                          className="mt-1 bg-card"
                          value={mainNewClientPhone}
                          onChange={(e) => setMainNewClientPhone(e.target.value)}
                          placeholder="+…"
                        />
                      </div>
                      <div className="sm:col-span-2 flex flex-col gap-2">
                        <div className="flex items-center justify-between">
                          <Label className="text-xs flex items-center gap-1">
                            <MapPin className="h-3.5 w-3.5" />
                            Sites (at least one address required)
                          </Label>
                          <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={addMainClientSite}>
                            <Plus className="h-3 w-3 mr-1" />
                            Add site
                          </Button>
                        </div>
                        <div className="space-y-2">
                          {mainClientSites.map((site, i) => (
                            <div key={i} className="flex gap-2 items-start">
                              <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
                                <Input
                                  placeholder="Site name (optional)"
                                  value={site.name ?? ""}
                                  onChange={(e) => updateMainClientSite(i, "name", e.target.value)}
                                  className="h-9 bg-card"
                                />
                                <Input
                                  placeholder="Full address (required)"
                                  value={site.address}
                                  onChange={(e) => updateMainClientSite(i, "address", e.target.value)}
                                  className="h-9 bg-card"
                                />
                              </div>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-9 w-9 shrink-0"
                                onClick={() => removeMainClientSite(i)}
                                disabled={mainClientSites.length <= 1}
                                aria-label="Remove site"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                  {OUTBOUND_LIKE_MOVEMENTS.includes(selectedType as TransactionType) &&
                    isFortigateProductName(productName.trim()) && (
                      <div className="flex flex-col gap-2">
                        <Label className="text-foreground">Cloud keys (required for FortiGate)</Label>
                        <Textarea
                          value={cloudKeysInput}
                          onChange={(e) => setCloudKeysInput(e.target.value)}
                          placeholder="One key per serial, same order as in Scan Items (comma or newline separated)…"
                          className="min-h-[80px] font-mono text-sm bg-card text-foreground border-border"
                        />
                        <p className="text-xs text-muted-foreground">
                          {uniqueSerials.length} unique serial(s) — provide exactly {uniqueSerials.length} non-empty cloud key(s).
                        </p>
                      </div>
                    )}
                </div>
              )}
              {selectedType === "POC Out" && (
                <div className="flex flex-col gap-2">
                  <Label className="text-foreground">Expected return / POC end date (optional)</Label>
                  <Input
                    type="date"
                    className="bg-card text-foreground border-border"
                    value={pocEndDate}
                    onChange={(e) => setPocEndDate(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">When the POC is expected to end. Used for return alerts.</p>
                </div>
              )}
              {selectedType === "Rentals" && (
                <div className="flex flex-col gap-2">
                  <Label className="text-foreground">Return date (optional)</Label>
                  <Input
                    type="date"
                    className="bg-card text-foreground border-border"
                    value={rentalReturnDate}
                    onChange={(e) => setRentalReturnDate(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">When the kit is due back. If empty, defaults to 30 days from today.</p>
                </div>
              )}
              {selectedType === "Sale" && isAdmin && (
                <div className="flex flex-col gap-2">
                  <Label className="text-foreground">Sale date (optional)</Label>
                  <Input
                    type="date"
                    className="bg-card text-foreground border-border max-w-xs"
                    value={adminSaleDate}
                    onChange={(e) => setAdminSaleDate(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Leave empty to use today. Set when recording a past sale (temporary admin tool until stock requests handle this).
                  </p>
                </div>
              )}
              {selectedType === "Transfer" && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="flex flex-col gap-2">
                    <Label className="text-foreground">From Location</Label>
                    <Select value={fromLocation} onValueChange={setFromLocation}>
                      <SelectTrigger className="bg-card text-foreground border-border">
                        <SelectValue placeholder="Select..." />
                      </SelectTrigger>
                      <SelectContent>
                        {LOCATIONS.map((loc) => (
                          <SelectItem key={loc} value={loc}>{loc}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label className="text-foreground">To Location</Label>
                    <Select value={toLocation} onValueChange={setToLocation}>
                      <SelectTrigger className="bg-card text-foreground border-border">
                        <SelectValue placeholder="Select..." />
                      </SelectTrigger>
                      <SelectContent>
                        {LOCATIONS.map((loc) => (
                          <SelectItem key={loc} value={loc}>{loc}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
              {(selectedType === "POC Return" || selectedType === "Rental Return") && (
                <div className="flex flex-col gap-2">
                  <Label className="text-foreground">Return To Location</Label>
                  <Select value={toLocation} onValueChange={setToLocation}>
                    <SelectTrigger className="bg-card text-foreground border-border">
                      <SelectValue placeholder="Select location..." />
                    </SelectTrigger>
                    <SelectContent>
                      {LOCATIONS.map((loc) => (
                        <SelectItem key={loc} value={loc}>{loc}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {selectedType === "Dispose" && (
                <>
                  <div className="flex flex-col gap-2">
                    <Label className="text-foreground">Reason for disposal (required)</Label>
                    <Select value={disposalReason} onValueChange={setDisposalReason}>
                      <SelectTrigger className="bg-card text-foreground border-border">
                        <SelectValue placeholder="Select reason..." />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Beyond repair">Beyond repair</SelectItem>
                        <SelectItem value="Lost">Lost</SelectItem>
                        <SelectItem value="End of life">End of life</SelectItem>
                        <SelectItem value="Other">Other</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label className="text-foreground">Authorised by (required)</Label>
                    <Input
                      placeholder="Name or ID of person who authorised"
                      className="bg-card text-foreground border-border"
                      value={authorisedBy}
                      onChange={(e) => setAuthorisedBy(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">Disposal cannot be undone. Authorisation is required.</p>
                  </div>
                </>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex flex-col gap-2">
                  <Label className="text-foreground">Invoice Number</Label>
                  <Input
                    placeholder="e.g., INV-2024-0892"
                    className="font-mono text-sm bg-card text-foreground border-border"
                    value={invoiceNumber}
                    onChange={(e) => setInvoiceNumber(e.target.value)}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <Label className="text-foreground">Notes / Description</Label>
                <Textarea
                  placeholder="Add any additional notes..."
                  className="min-h-[80px] bg-card text-foreground border-border"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
              <Button
                className="w-full sm:w-auto sm:self-end bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={handleSubmit}
                disabled={isSubmitting || scannedCount === 0 || !productName.trim()}
              >
                {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <Package className="w-4 h-4 mr-1.5" />}
                {isSubmitting ? "Submitting..." : "Submit Transaction"}
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Right: Summary — same height as Transaction Type panel on lg */}
        <div className="flex flex-col gap-4 md:gap-5">
          <Card className="min-h-[260px] lg:min-h-[280px] flex flex-col">
            <CardHeader className="pb-2">
              <CardTitle className="text-base font-semibold text-foreground">Transaction Summary</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 flex-1">
              <div className="flex items-center justify-between py-2 border-b border-border">
                <span className="text-sm text-muted-foreground">Product</span>
                <span className="text-sm text-foreground truncate max-w-[140px]" title={productName}>{productName || "—"}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-border">
                <span className="text-sm text-muted-foreground">Type</span>
                <Badge
                  variant="secondary"
                  className={cn(
                    "text-xs border-0",
                    selectedType === "Inbound" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
                    selectedType === "Sale" && "bg-red-500/10 text-red-500 dark:text-red-400",
                    selectedType === "Rentals" && "bg-blue-500/10 text-blue-500 dark:text-blue-400",
                    selectedType === "POC Out" && "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
                    selectedType === "POC Return" && "bg-amber-500/10 text-amber-600 dark:text-amber-400",
                    selectedType === "Transfer" && "bg-violet-500/10 text-violet-600 dark:text-violet-400",
                    selectedType === "Dispose" && "bg-slate-500/10 text-slate-600 dark:text-slate-400",
                  )}
                >
                  {selectedType}
                </Badge>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-border">
                <span className="text-sm text-muted-foreground">Items Scanned</span>
                <span className="text-sm font-semibold text-foreground">{scannedCount}</span>
              </div>
              {(selectedType === "Sale" || selectedType === "POC Out" || selectedType === "Rentals") && (
                <div className="flex items-center justify-between py-2 border-b border-border">
                  <span className="text-sm text-muted-foreground">Client</span>
                  <span className="text-sm text-foreground">{clientDisplay}</span>
                </div>
              )}
              {selectedType === "Transfer" && (
                <>
                  <div className="flex items-center justify-between py-2 border-b border-border">
                    <span className="text-sm text-muted-foreground">From</span>
                    <span className="text-sm text-foreground">{fromLocation || "—"}</span>
                  </div>
                  <div className="flex items-center justify-between py-2 border-b border-border">
                    <span className="text-sm text-muted-foreground">To</span>
                    <span className="text-sm text-foreground">{toLocation || "—"}</span>
                  </div>
                </>
              )}
              {selectedType === "Inbound" && (
                <div className="flex items-center justify-between py-2 border-b border-border">
                  <span className="text-sm text-muted-foreground">Delivery note</span>
                  <span className="text-sm text-foreground truncate max-w-[140px]" title={deliveryNoteFile?.name}>{deliveryNoteFile ? deliveryNoteFile.name : "—"}</span>
                </div>
              )}
              <div className="flex items-center justify-between py-2 border-b border-border">
                <span className="text-sm text-muted-foreground">Invoice</span>
                <span className="text-sm text-foreground">{invoiceNumber || "—"}</span>
              </div>
              <div className="flex items-center justify-between py-2">
                <span className="text-sm text-muted-foreground">Notes</span>
                <span className="text-sm text-foreground truncate max-w-[140px]" title={notes}>{notes || "—"}</span>
              </div>
            </CardContent>
          </Card>

          {/* Scanned Items Preview */}
          {scannedCount > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold text-foreground">Scanned Items</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {uniqueSerials.map((serial, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary"
                  >
                    <div className="w-6 h-6 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                      <span className="text-[10px] font-bold text-primary">{i + 1}</span>
                    </div>
                    <span className="font-mono text-xs text-foreground truncate">{serial}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Missing serials dialog (outbound: add to inventory first) */}
      <Dialog open={!!missingSerialsState} onOpenChange={(open) => !open && setMissingSerialsState(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Serials not in inventory</DialogTitle>
          </DialogHeader>
          {missingSerialsState && (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                The following serial number(s) are not in the system. Add them to inventory first, then continue with client & site details.
              </p>
              <ul className="font-mono text-sm bg-muted/50 rounded-md p-3 max-h-40 overflow-y-auto space-y-1">
                {missingSerialsState.missing.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                They will be added as <strong>{missingSerialsState.productName}</strong>, status In Stock, then you can complete the {missingSerialsState.movementType} transaction.
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

      {/* Client & site details modal (outbound types) */}
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
                    <Button variant="outline" role="combobox" className="w-full justify-between h-10 font-normal">
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
                                [c.name, c.company, c.email].some(
                                  (x) => typeof x === "string" && x.toLowerCase().includes(outboundClientSearch.trim().toLowerCase())
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
              {outboundClientId === "new" && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 rounded-md border border-border bg-muted/30">
                  <div className="sm:col-span-2">
                    <Label className="text-xs">Name (required)</Label>
                    <Input placeholder="Contact name" value={newClientName} onChange={(e) => setNewClientName(e.target.value)} className="mt-1 h-9" />
                  </div>
                  <div>
                    <Label className="text-xs">Company (required)</Label>
                    <Input placeholder="Company" value={newClientCompany} onChange={(e) => setNewClientCompany(e.target.value)} className="mt-1 h-9" />
                  </div>
                  <div>
                    <Label className="text-xs">Email (required)</Label>
                    <Input type="email" placeholder="email@example.com" value={newClientEmail} onChange={(e) => setNewClientEmail(e.target.value)} className="mt-1 h-9" />
                  </div>
                  <div className="sm:col-span-2">
                    <Label className="text-xs">Phone (required)</Label>
                    <Input placeholder="+250 ..." value={newClientPhone} onChange={(e) => setNewClientPhone(e.target.value)} className="mt-1 h-9" />
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
                  {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : "Submit Transaction"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
