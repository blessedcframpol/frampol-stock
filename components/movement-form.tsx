"use client"

import { useEffect, useMemo, useRef, useState } from "react"
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { StatusPill } from "@/components/fs/status-pill"
import { ReturnPoolChoice } from "@/components/return-pool-choice"
import { IntakeReasonFields } from "@/components/intake-reason-fields"
import { InvoiceChoiceFields } from "@/components/invoice-choice-fields"
import type { InvoiceChoice } from "@/lib/invoices"
import { INTERNAL_LOCATIONS } from "@/lib/data"
import { formatClientLabel } from "@/lib/client-label"
import type { ClientSite, JsonValue, TransactionType } from "@/lib/data"
import { useClients, insertClient } from "@/lib/supabase/clients-db"
import { useInventoryStore } from "@/lib/inventory-store"
import {
  ScanBarcode,
  FileText,
  Package,
  Plus,
  MapPin,
  Loader2,
  Upload,
  X,
  Trash2,
  ChevronsUpDown,
  ChevronDown,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"
import { uploadDocument, type UploadDocumentKind } from "@/lib/upload-documents"
import { parseSaleDateOverride, type InboundCreateDefaults } from "@/lib/supabase/movement-utils"
import { DEFAULT_ORG_TIMEZONE, todayBusinessDate } from "@/lib/business-date.mjs"
import { fetchAppSettings } from "@/lib/settings"
import { isFortigateProductName, splitDelimitedValues, cloudKeysMapForSerials } from "@/lib/fortigate"
import { useAuth } from "@/lib/auth-context"
import { prefillMovementType } from "@/lib/alerts"
import { canRecordStockMovement } from "@/lib/permissions"
import {
  NEW_CLIENT_SELECT,
  OUTBOUND_LIKE_MOVEMENTS,
  TRANSACTION_TYPE_CHOICES,
  MOVEMENT_GROUP_LABELS,
  MOVEMENT_GROUP_ORDER,
  choicesForGroup,
  groupForType,
  isSelectableMovementType,
  requiresClient,
  requiresInvoice,
  requiresReturnDate,
  requiresReturnPool,
  requiresIntakeReason,
  requiresWarehouseLocation,
  buildSerialFeedback,
  transferOriginFromSerials,
  submitBlockMessage,
  type MovementSource,
  type MovementTypeGroup,
  type MovementFormFields,
} from "@/lib/stock-movement-form-logic"
import {
  filterClientsForPicker,
  clientCommandItemValue,
  closestClientsForCreate,
} from "@/lib/search"
import { useSearchUsers } from "@/lib/supabase/search-users"

function normalizeInventoryVendor(value: string | undefined | null): string {
  const t = (value ?? "").trim()
  return t || "General"
}

function productVendorKey(name: string, vendor: string): string {
  return `${name.trim()}\u0000${normalizeInventoryVendor(vendor)}`
}

function productVendorLabel(name: string, vendor: string): string {
  return `${name.trim()} · ${normalizeInventoryVendor(vendor)}`
}

export type StockMovementEmbedMode = {
  fixedSerials: string[]
  fixedProductName: string
  /** When set, must be a non-Inbound type for inventory embed. */
  initialMovementType?: string
  /** From inventory row(s): guard existing serials against wrong vendor (embed). */
  expectedVendor?: string
  onClose?: () => void
}

function initialEmbedMovementType(embedMode: StockMovementEmbedMode | undefined): string {
  if (!embedMode) return "Inbound"
  const allowed = new Set(
    TRANSACTION_TYPE_CHOICES.filter((t) => t.value !== "Inbound").map((t) => t.value as string)
  )
  const init = embedMode.initialMovementType
  return init && allowed.has(init) ? init : "Transfer"
}

export type MovementFormProps = {
  layout: "full" | "compact"
  source: MovementSource
  embedMode?: StockMovementEmbedMode
  prefillType?: string
  prefillSerials?: string
}

export function MovementForm({
  layout,
  source,
  embedMode,
  prefillType,
  prefillSerials,
}: MovementFormProps) {
  const isEmbed = Boolean(embedMode)
  const isCompact = layout === "compact"
  const { inventory, applyMovement, refetchLedger } = useInventoryStore()
  const { clients, refetch: refetchClients } = useClients()
  const { role, loading: authLoading } = useAuth()
  const canMove = canRecordStockMovement(role)
  const activeAdmins = useSearchUsers({ activeAdminsOnly: true })

  const [selectedType, setSelectedType] = useState(() => {
    if (embedMode) return initialEmbedMovementType(embedMode)
    return prefillMovementType(prefillType) ?? "Inbound"
  })
  const [typeGroup, setTypeGroup] = useState<MovementTypeGroup>(() => {
    const t = embedMode
      ? initialEmbedMovementType(embedMode)
      : prefillMovementType(prefillType) ?? "Inbound"
    return groupForType(t) ?? "in"
  })
  const [serialNumbers, setSerialNumbers] = useState(() => {
    if (embedMode) return embedMode.fixedSerials.join(", ")
    return prefillSerials ?? ""
  })
  const [productName, setProductName] = useState(() => embedMode?.fixedProductName ?? "")
  const [vendor, setVendor] = useState(() =>
    embedMode?.expectedVendor !== undefined
      ? normalizeInventoryVendor(embedMode.expectedVendor)
      : "General"
  )
  const [clientId, setClientId] = useState("")
  const [invoiceNumber, setInvoiceNumber] = useState("")
  const [invoiceChoice, setInvoiceChoice] = useState<InvoiceChoice | "">("")
  const [invoiceReason, setInvoiceReason] = useState("")
  const [notes, setNotes] = useState("")
  const [toLocation, setToLocation] = useState("Warehouse A")
  const [returnPool, setReturnPool] = useState<"" | "sale" | "demo">("")
  const [returnDate, setReturnDate] = useState("")
  const [disposalReason, setDisposalReason] = useState("")
  const [authorisedBy, setAuthorisedBy] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [deliveryNoteFile, setDeliveryNoteFile] = useState<File | null>(null)
  const [decommissionDocFile, setDecommissionDocFile] = useState<File | null>(null)
  const [cloudKeysInput, setCloudKeysInput] = useState("")
  const [intakeCategory, setIntakeCategory] = useState("")
  const [intakeReason, setIntakeReason] = useState("")
  const [businessDate, setBusinessDate] = useState(() => todayBusinessDate(DEFAULT_ORG_TIMEZONE))
  const [todayYmd, setTodayYmd] = useState(() => todayBusinessDate(DEFAULT_ORG_TIMEZONE))
  const [moreOpen, setMoreOpen] = useState(false)

  const [clientOpen, setClientOpen] = useState(false)
  const [clientSearch, setClientSearch] = useState("")
  const [createStep, setCreateStep] = useState<"idle" | "confirm" | "form">("idle")
  const [newClientName, setNewClientName] = useState("")
  const [newClientCompany, setNewClientCompany] = useState("")
  const [newClientEmail, setNewClientEmail] = useState("")
  const [newClientPhone, setNewClientPhone] = useState("")
  const [clientSites, setClientSites] = useState<ClientSite[]>([{ address: "" }])

  const [productOpen, setProductOpen] = useState(false)
  const [productSearch, setProductSearch] = useState("")
  const [addingProduct, setAddingProduct] = useState(false)
  const [newProductName, setNewProductName] = useState("")
  const [newProductVendor, setNewProductVendor] = useState("General")

  const cloudKeysRef = useRef<Record<string, string> | undefined>(undefined)
  const serialInputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let cancelled = false
    void fetchAppSettings()
      .then((settings) => {
        if (cancelled) return
        const today = todayBusinessDate(settings.timezone.trim() || DEFAULT_ORG_TIMEZONE)
        setTodayYmd(today)
        setBusinessDate((current) =>
          current === todayBusinessDate(DEFAULT_ORG_TIMEZONE) ? today : current
        )
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const productOptions = useMemo(() => {
    const map = new Map<string, { name: string; vendor: string; label: string }>()
    for (const item of inventory) {
      const name = item.name.trim()
      if (!name) continue
      const v = normalizeInventoryVendor(item.vendor)
      const key = productVendorKey(name, v)
      if (!map.has(key)) map.set(key, { name, vendor: v, label: productVendorLabel(name, v) })
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }))
  }, [inventory])

  const filteredProducts = useMemo(() => {
    const q = productSearch.trim().toLowerCase()
    if (!q) return productOptions
    return productOptions.filter((p) => p.label.toLowerCase().includes(q))
  }, [productOptions, productSearch])

  const sortedClients = useMemo(() => {
    const collator = new Intl.Collator(undefined, { sensitivity: "base" })
    return [...clients].sort((a, b) =>
      collator.compare(`${a.name} ${a.company}`.trim(), `${b.name} ${b.company}`.trim())
    )
  }, [clients])

  const clientDirectory = useMemo(
    () => clients.map((c) => ({ id: c.id, name: c.name, company: c.company })),
    [clients]
  )

  const closestForCreate = useMemo(
    () => closestClientsForCreate(sortedClients, clientSearch || newClientName || newClientCompany, 5),
    [sortedClients, clientSearch, newClientName, newClientCompany]
  )

  const typesForGroup = useMemo(() => {
    let list = choicesForGroup(typeGroup)
    if (isEmbed) list = list.filter((t) => t.value !== "Inbound")
    return list
  }, [typeGroup, isEmbed])

  const serialFeedback = useMemo(() => {
    if (!isSelectableMovementType(selectedType)) {
      return buildSerialFeedback("Inbound", serialNumbers, inventory)
    }
    const origin =
      selectedType === "Transfer"
        ? transferOriginFromSerials(
            serialNumbers
              .split(/[\n,;]+/)
              .map((s) => s.trim())
              .filter(Boolean),
            inventory
          ).location ?? undefined
        : undefined
    return buildSerialFeedback(selectedType as TransactionType, serialNumbers, inventory, {
      expectedProductName: productName.trim() || undefined,
      expectedVendor: normalizeInventoryVendor(vendor),
      fromLocation: origin,
    })
  }, [selectedType, serialNumbers, inventory, productName, vendor])

  const transferOrigin = useMemo(() => {
    if (selectedType !== "Transfer") return { location: null as string | null, mixed: false }
    return transferOriginFromSerials(serialFeedback.validSerials, inventory)
  }, [selectedType, serialFeedback.validSerials, inventory])

  const hasUnknownSerial = useMemo(() => {
    const known = new Set(inventory.map((i) => i.serialNumber))
    return serialFeedback.validSerials.some((s) => !known.has(s))
  }, [inventory, serialFeedback.validSerials])

  const formFields: MovementFormFields = {
    type: selectedType,
    productName,
    vendor,
    serialText: serialNumbers,
    clientId,
    invoiceChoice,
    invoiceNumber,
    invoiceReason,
    returnDate,
    returnPool,
    intakeCategory,
    intakeReason,
    toLocation,
    disposalReason,
    authorisedBy,
    businessDate,
    notes,
  }

  const newClientFormReady =
    clientId === NEW_CLIENT_SELECT &&
    createStep === "form" &&
    Boolean(
      newClientName.trim() &&
        newClientCompany.trim() &&
        newClientEmail.trim() &&
        newClientPhone.trim() &&
        clientSites.some((s) => s.address.trim())
    )

  const rawBlock = submitBlockMessage(formFields, serialFeedback, {
    todayYmd,
    originLocation: transferOrigin.location,
    hasUnknownSerial,
  })
  const blockMessage =
    rawBlock === "Select a client" && newClientFormReady
      ? null
      : rawBlock === "Select a client" && clientId === NEW_CLIENT_SELECT && createStep === "confirm"
        ? "Confirm closest matches or create new"
        : rawBlock

  const clientDisplay =
    !clientId || clientId === NEW_CLIENT_SELECT
      ? clientId === NEW_CLIENT_SELECT
        ? "New client (unsaved)"
        : "Not selected"
      : formatClientLabel(clients.find((c) => c.id === clientId) ?? { name: clientId }) || clientId

  const showClient = requiresClient(selectedType)
  const showInvoice = requiresInvoice(selectedType)
  const showReturnDate = requiresReturnDate(selectedType)
  const showReturnPool = requiresReturnPool(selectedType)
  const showIntake = requiresIntakeReason(selectedType)
  const showWarehouse = requiresWarehouseLocation(selectedType)
  const showDeliveryNote = selectedType === "Sale" || selectedType === "Inbound"
  const showDecommissionDoc = selectedType === "Decommissioned"
  const showCloudKeys =
    OUTBOUND_LIKE_MOVEMENTS.includes(selectedType as TransactionType) &&
    isFortigateProductName(productName.trim())

  function selectType(value: string) {
    if (!isSelectableMovementType(value)) return
    if (isEmbed && value === "Inbound") return
    setSelectedType(value)
    const g = groupForType(value)
    if (g) setTypeGroup(g)
  }

  function selectGroup(group: MovementTypeGroup) {
    setTypeGroup(group)
    const choices = choicesForGroup(group).filter((c) => !(isEmbed && c.value === "Inbound"))
    if (choices.length === 0) return
    if (!choices.some((c) => c.value === selectedType)) {
      setSelectedType(choices[0]!.value)
    }
  }

  function handleSerialChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value
    setSerialNumbers(v.includes("\n") ? v.replace(/\n+/g, ", ").replace(/,+\s*,/g, ", ") : v)
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

  function resetAfterSuccess() {
    setClientId("")
    setClientSearch("")
    setCreateStep("idle")
    setNewClientName("")
    setNewClientCompany("")
    setNewClientEmail("")
    setNewClientPhone("")
    setClientSites([{ address: "" }])
    setInvoiceNumber("")
    setInvoiceChoice("")
    setInvoiceReason("")
    setNotes("")
    setDisposalReason("")
    setAuthorisedBy("")
    setDeliveryNoteFile(null)
    setDecommissionDocFile(null)
    setIntakeCategory("")
    setIntakeReason("")
    setReturnPool("")
    setReturnDate("")
    setCloudKeysInput("")
    setBusinessDate(todayYmd)
    if (!isEmbed) {
      setSerialNumbers("")
      serialInputRef.current?.focus()
    }
  }

  async function ensureClientId(): Promise<string | undefined> {
    if (!showClient) return clientId || undefined
    if (clientId && clientId !== NEW_CLIENT_SELECT) return clientId
    if (clientId !== NEW_CLIENT_SELECT) return undefined

    const name = newClientName.trim()
    const company = newClientCompany.trim()
    const email = newClientEmail.trim()
    const phone = newClientPhone.trim()
    if (!name || !company || !email || !phone) {
      toast.error("New client: name, company, email, and phone are all required")
      return undefined
    }
    const validSites = clientSites
      .filter((s) => s.address.trim())
      .map((s) => ({
        ...(s.name?.trim() ? { name: s.name.trim() } : {}),
        address: s.address.trim(),
      }))
    if (validSites.length === 0) {
      toast.error("Add at least one site address for the new client")
      return undefined
    }
    const nc = await insertClient({ name, company, email, phone, sites: validSites })
    await refetchClients()
    setClientId(nc.id)
    setCreateStep("idle")
    return nc.id
  }

  async function uploadMovementDocument(
    file: File,
    kind: Extract<UploadDocumentKind, "delivery-note" | "decommission-document">
  ): Promise<string> {
    return uploadDocument(kind, "transactions", file)
  }

  async function handleRecord() {
    if (blockMessage) {
      toast.error(blockMessage)
      return
    }
    if (transferOrigin.mixed) {
      toast.error("Transfer serials must share the same current location")
      return
    }

    setIsSubmitting(true)
    try {
      let resolvedClientId: string | undefined
      try {
        resolvedClientId = await ensureClientId()
      } catch (e) {
        toastFromCaughtError(e, "Failed to save client")
        return
      }
      if (showClient && !resolvedClientId) {
        if (!(selectedType === "Decommissioned" && !hasUnknownSerial)) {
          toast.error("Select a client")
          return
        }
      }

      if (showCloudKeys) {
        const keys = splitDelimitedValues(cloudKeysInput)
        const map = cloudKeysMapForSerials(serialFeedback.validSerials, keys)
        if (!map) {
          toast.error(
            `Cloud keys (FortiGate): enter exactly ${serialFeedback.validSerials.length} non-empty key(s) in the same order as the serials.`
          )
          return
        }
        cloudKeysRef.current = map
      } else {
        cloudKeysRef.current = undefined
      }

      let deliveryNoteUrl: string | undefined
      let decommissionDocumentUrl: string | undefined
      if (showDeliveryNote && deliveryNoteFile) {
        try {
          deliveryNoteUrl = await uploadMovementDocument(deliveryNoteFile, "delivery-note")
        } catch (e) {
          toastFromCaughtError(e, "Failed to upload delivery note")
          return
        }
      }
      if (showDecommissionDoc && decommissionDocFile) {
        try {
          decommissionDocumentUrl = await uploadMovementDocument(
            decommissionDocFile,
            "decommission-document"
          )
        } catch (e) {
          toastFromCaughtError(e, "Failed to upload attachment")
          return
        }
      }

      const pn = productName.trim()
      const v = normalizeInventoryVendor(vendor)
      const clientRow = resolvedClientId ? clients.find((c) => c.id === resolvedClientId) : undefined
      const clientDisplayOverride = clientRow
        ? `${clientRow.name} - ${clientRow.company}`
        : undefined

      let inboundDefaults: InboundCreateDefaults | undefined
      if (selectedType === "Inbound") {
        inboundDefaults = {
          name: pn,
          vendor: v,
          location: toLocation.trim() || "Warehouse A",
        }
      } else if (selectedType === "Decommissioned") {
        inboundDefaults = {
          name: pn,
          vendor: v,
          location: toLocation.trim() || "Warehouse A",
        }
      }

      let movementMetadata: JsonValue = { source }
      if (selectedType === "Decommissioned" || selectedType === "Rental Return") {
        movementMetadata = {
          ...movementMetadata,
          reason_category: intakeCategory,
          reason_text: intakeReason.trim(),
          ...(selectedType === "Decommissioned" && decommissionDocumentUrl
            ? { documentUrl: decommissionDocumentUrl }
            : {}),
        }
      }

      const dateCheck = parseSaleDateOverride(businessDate.trim())
      if (!dateCheck.ok) {
        toast.error("Invalid business date", { description: dateCheck.error })
        return
      }

      const result = await applyMovement({
        type: selectedType as TransactionType,
        serialNumbers: serialFeedback.validSerials,
        clientId: resolvedClientId,
        clientDisplayOverride,
        fromLocation:
          selectedType === "Transfer" ? transferOrigin.location ?? undefined : undefined,
        toLocation:
          selectedType === "Transfer" || showWarehouse ? toLocation || undefined : undefined,
        assignedTo: clientRow?.company ?? clientRow?.name,
        invoiceNumber: invoiceNumber.trim() || undefined,
        invoiceChoice: showInvoice ? invoiceChoice || undefined : undefined,
        invoiceReason: invoiceReason.trim() || undefined,
        notes: notes.trim() || undefined,
        returnPool:
          showReturnPool && (returnPool === "sale" || returnPool === "demo") ? returnPool : undefined,
        returnDate: showReturnDate && returnDate.trim() ? returnDate.trim() : undefined,
        disposalReason: selectedType === "Dispose" ? disposalReason.trim() || undefined : undefined,
        authorisedBy: selectedType === "Dispose" ? authorisedBy.trim() || undefined : undefined,
        deliveryNoteUrl: showDeliveryNote ? deliveryNoteUrl : undefined,
        inboundCreateDefaults: inboundDefaults,
        cloudKeysBySerial: cloudKeysRef.current,
        saleTransactionDateIso: businessDate.trim() || undefined,
        movementMetadata,
        clientDirectory,
        expectedProductName: pn,
        expectedVendor: v,
      })

      cloudKeysRef.current = undefined

      if (result.success.length > 0) {
        toast.success(
          result.success.length === 1
            ? `Recorded: ${result.success[0]} (${pn})`
            : `Recorded ${result.success.length} item(s) (${pn})`
        )
        embedMode?.onClose?.()
        resetAfterSuccess()
        void refetchLedger()
      }
      if (result.notFound.length > 0) {
        toast.warning(`Serial number(s) not found: ${result.notFound.slice(0, 5).join(", ")}`)
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  const recordLabel = blockMessage
    ? blockMessage
    : isSubmitting
      ? "Recording…"
      : `Record${serialFeedback.validSerials.length ? ` (${serialFeedback.validSerials.length})` : ""}`

  if (authLoading) {
    return <p className="text-sm text-muted-foreground">Checking access…</p>
  }

  if (!canMove) {
    return (
      <p className="text-sm text-muted-foreground">
        You do not have permission to record stock movements. Only admins and technicians can use this
        page.
      </p>
    )
  }

  const typeSelector = (
    <div className="flex flex-col gap-3">
      <ToggleGroup
        type="single"
        value={typeGroup}
        onValueChange={(v) => {
          if (v === "out" || v === "in" || v === "move") selectGroup(v)
        }}
        variant="outline"
        className="w-full justify-stretch"
      >
        {MOVEMENT_GROUP_ORDER.map((g) => (
          <ToggleGroupItem key={g} value={g} className="flex-1 px-3">
            {MOVEMENT_GROUP_LABELS[g]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {/* Future: remediation issue/return types may land in Out / In once productised. */}
      <div className={cn("grid gap-1.5", isCompact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3")}>
        {typesForGroup.map((type) => {
          const Icon = type.icon
          const isActive = selectedType === type.value
          return (
            <button
              key={type.value}
              type="button"
              onClick={() => selectType(type.value)}
              className={cn(
                "flex flex-col items-center gap-1 p-2 rounded-lg border-2 transition-all text-center",
                isActive ? "border-brand bg-brand/5" : "border-border hover:border-brand/40 bg-card"
              )}
            >
              <div className={cn("flex items-center justify-center w-7 h-7 rounded-md", type.bg)}>
                <Icon className={cn("w-3.5 h-3.5", type.color)} />
              </div>
              <span
                className={cn(
                  "text-[11px] sm:text-xs font-medium",
                  isActive ? "text-foreground font-semibold" : "text-foreground"
                )}
              >
                {type.label}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )

  const productField = isEmbed ? (
    <div>
      <Label className="text-xs text-muted-foreground">Product</Label>
      <p className="text-sm font-medium text-foreground mt-1">
        {productVendorLabel(productName, vendor)}
      </p>
    </div>
  ) : (
    <div className="flex flex-col gap-2">
      <Label className="text-xs text-muted-foreground">Product · Vendor</Label>
      <Popover open={productOpen} onOpenChange={setProductOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            className="w-full justify-between h-10 font-normal bg-card"
            disabled={isSubmitting}
          >
            <span className={cn("truncate", !productName && "text-muted-foreground")}>
              {productName ? productVendorLabel(productName, vendor) : "Select product…"}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="min-w-[300px] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search products…"
              value={productSearch}
              onValueChange={setProductSearch}
            />
            <CommandList>
              <CommandEmpty>No product found.</CommandEmpty>
              <CommandGroup>
                {filteredProducts.map((p) => (
                  <CommandItem
                    key={productVendorKey(p.name, p.vendor)}
                    value={p.label}
                    onSelect={() => {
                      setProductName(p.name)
                      setVendor(p.vendor)
                      setAddingProduct(false)
                      setProductOpen(false)
                      setProductSearch("")
                    }}
                  >
                    {p.label}
                  </CommandItem>
                ))}
                <CommandItem
                  value="__new_product"
                  onSelect={() => {
                    setAddingProduct(true)
                    setNewProductName(productSearch.trim())
                    setNewProductVendor("General")
                    setProductOpen(false)
                  }}
                  className="text-brand"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add new product…
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {addingProduct && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-3 rounded-lg border border-border bg-muted/30">
          <div>
            <Label className="text-xs">Product name</Label>
            <Input
              className="mt-1 bg-card"
              value={newProductName}
              onChange={(e) => setNewProductName(e.target.value)}
              placeholder="Product name"
            />
          </div>
          <div>
            <Label className="text-xs">Vendor</Label>
            <Input
              className="mt-1 bg-card"
              value={newProductVendor}
              onChange={(e) => setNewProductVendor(e.target.value)}
              placeholder="Vendor"
            />
          </div>
          <div className="sm:col-span-2 flex gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                const n = newProductName.trim()
                if (!n) {
                  toast.error("Enter a product name")
                  return
                }
                setProductName(n)
                setVendor(normalizeInventoryVendor(newProductVendor))
                setAddingProduct(false)
              }}
            >
              Use this product
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAddingProduct(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )

  const serialField = isEmbed ? (
    <div>
      <Label className="text-xs text-muted-foreground">
        Serial numbers ({serialFeedback.validSerials.length})
      </Label>
      <p className="text-xs font-mono text-foreground mt-1 break-words">
        {embedMode?.fixedSerials.join(", ")}
      </p>
      {serialFeedback.summary ? (
        <p className="text-xs text-muted-foreground mt-1">{serialFeedback.summary}</p>
      ) : null}
    </div>
  ) : (
    <div className="flex flex-col gap-2">
      <Label className="text-xs text-muted-foreground">
        Serial numbers (comma or newline separated)
      </Label>
      <Textarea
        ref={serialInputRef}
        placeholder="SL-001, SL-002, SL-003 or one per line…"
        value={serialNumbers}
        onChange={handleSerialChange}
        onPaste={handleSerialPaste}
        disabled={isSubmitting}
        className={cn(
          "font-mono text-xs bg-card text-foreground border-border",
          isCompact ? "min-h-[72px]" : "min-h-[100px] sm:min-h-[120px]"
        )}
      />
      {serialNumbers.trim() ? (
        <p className="text-xs text-muted-foreground">{serialFeedback.summary}</p>
      ) : null}
      {serialFeedback.marks.some((m) => m.mark !== "ok") ? (
        <ul className="text-[11px] font-mono space-y-0.5 max-h-24 overflow-auto">
          {serialFeedback.marks
            .filter((m) => m.mark !== "ok")
            .slice(0, 12)
            .map((m) => (
              <li
                key={`${m.serial}-${m.mark}`}
                className={cn(
                  m.mark === "blocked" || m.mark === "not_found" || m.mark === "duplicate"
                    ? "text-warning"
                    : "text-muted-foreground"
                )}
              >
                {m.serial}: {m.detail ?? m.mark}
              </li>
            ))}
        </ul>
      ) : null}
    </div>
  )

  const clientField = showClient ? (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <Label className="text-foreground">Client</Label>
        <Popover open={clientOpen} onOpenChange={setClientOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              className="w-full justify-between h-10 font-normal bg-card"
              disabled={isSubmitting}
            >
              <span className={cn("truncate", !clientId && "text-muted-foreground")}>
                {clientId === NEW_CLIENT_SELECT
                  ? "New client…"
                  : clientId
                    ? formatClientLabel(sortedClients.find((c) => c.id === clientId) ?? {})
                    : "Search existing client…"}
              </span>
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="min-w-[300px] p-0" align="start">
            <Command shouldFilter={false}>
              <CommandInput
                placeholder="Search clients…"
                value={clientSearch}
                onValueChange={(v) => {
                  setClientSearch(v)
                  if (createStep !== "idle") setCreateStep("idle")
                }}
              />
              <CommandList>
                <CommandEmpty>No client found.</CommandEmpty>
                <CommandGroup>
                  {filterClientsForPicker(sortedClients, clientSearch).map((c) => (
                    <CommandItem
                      key={c.id}
                      value={clientCommandItemValue(c)}
                      onSelect={() => {
                        setClientId(c.id)
                        setCreateStep("idle")
                        setClientOpen(false)
                        setClientSearch("")
                      }}
                    >
                      {formatClientLabel(c)}
                    </CommandItem>
                  ))}
                  <CommandItem
                    value="__create_flow"
                    onSelect={() => {
                      setCreateStep("confirm")
                      setClientId(NEW_CLIENT_SELECT)
                      if (!newClientName && clientSearch.trim()) setNewClientName(clientSearch.trim())
                      setClientOpen(false)
                    }}
                    className="text-brand"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Create new client…
                  </CommandItem>
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>

      {clientId === NEW_CLIENT_SELECT && createStep === "confirm" && (
        <div className="flex flex-col gap-2 p-3 rounded-lg border border-border bg-muted/30">
          <p className="text-xs text-muted-foreground">
            Closest matches — pick one, or confirm none match:
          </p>
          {closestForCreate.length === 0 ? (
            <p className="text-xs text-muted-foreground">No close matches in the directory.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {closestForCreate.map((c) => (
                <li key={c.id}>
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full justify-start h-8 px-2 text-sm"
                    onClick={() => {
                      setClientId(c.id)
                      setCreateStep("idle")
                    }}
                  >
                    {formatClientLabel(c)}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => setCreateStep("form")}
          >
            None of these — create new
          </Button>
        </div>
      )}

      {clientId === NEW_CLIENT_SELECT && createStep === "form" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 rounded-lg border border-border bg-muted/30">
          <div className="sm:col-span-2">
            <Label className="text-xs">Contact name (required)</Label>
            <Input
              className="mt-1 bg-card"
              value={newClientName}
              onChange={(e) => setNewClientName(e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs">Company (required)</Label>
            <Input
              className="mt-1 bg-card"
              value={newClientCompany}
              onChange={(e) => setNewClientCompany(e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs">Email (required)</Label>
            <Input
              type="email"
              className="mt-1 bg-card"
              value={newClientEmail}
              onChange={(e) => setNewClientEmail(e.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <Label className="text-xs">Phone (required)</Label>
            <Input
              className="mt-1 bg-card"
              value={newClientPhone}
              onChange={(e) => setNewClientPhone(e.target.value)}
            />
          </div>
          <div className="sm:col-span-2 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs flex items-center gap-1">
                <MapPin className="h-3.5 w-3.5" />
                Sites (at least one address)
              </Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setClientSites((prev) => [...prev, { address: "" }])}
              >
                <Plus className="h-3 w-3 mr-1" />
                Add site
              </Button>
            </div>
            {clientSites.map((site, i) => (
              <div key={i} className="flex gap-2 items-start">
                <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Input
                    placeholder="Site name (optional)"
                    value={site.name ?? ""}
                    onChange={(e) =>
                      setClientSites((prev) =>
                        prev.map((s, idx) => (idx === i ? { ...s, name: e.target.value } : s))
                      )
                    }
                    className="h-9 bg-card"
                  />
                  <Input
                    placeholder="Full address (required)"
                    value={site.address}
                    onChange={(e) =>
                      setClientSites((prev) =>
                        prev.map((s, idx) => (idx === i ? { ...s, address: e.target.value } : s))
                      )
                    }
                    className="h-9 bg-card"
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0"
                  onClick={() => setClientSites((prev) => prev.filter((_, idx) => idx !== i))}
                  disabled={clientSites.length <= 1}
                  aria-label="Remove site"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  ) : null

  const typeSpecificFields = (
    <>
      {showWarehouse && (
        <div className="flex flex-col gap-2">
          <Label className="text-foreground">
            {selectedType === "Inbound"
              ? "Receive location"
              : selectedType === "Sale Return" || selectedType === "Decommissioned"
                ? "Hold / receive location"
                : "Return location"}
          </Label>
          <Select value={toLocation} onValueChange={setToLocation} disabled={isSubmitting}>
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
      )}

      {selectedType === "Transfer" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="flex flex-col gap-2">
            <Label className="text-foreground">Current location (from serials)</Label>
            <Input
              readOnly
              value={
                transferOrigin.mixed
                  ? "Mixed locations — select serials from one place"
                  : transferOrigin.location ?? "—"
              }
              className="bg-muted text-foreground border-border"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label className="text-foreground">Destination</Label>
            <Select value={toLocation} onValueChange={setToLocation} disabled={isSubmitting}>
              <SelectTrigger className="bg-card text-foreground border-border">
                <SelectValue placeholder="Select…" />
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
        </div>
      )}

      {clientField}

      {showReturnDate && (
        <div className="flex flex-col gap-2">
          <Label className="text-foreground">
            {selectedType === "POC Out" ? "Expected return / POC end date" : "Return date"}
          </Label>
          <Input
            type="date"
            className="bg-card text-foreground border-border max-w-xs"
            value={returnDate}
            onChange={(e) => setReturnDate(e.target.value)}
            disabled={isSubmitting}
          />
        </div>
      )}

      {showReturnPool && <ReturnPoolChoice value={returnPool} onChange={setReturnPool} />}

      {showIntake && (
        <IntakeReasonFields
          category={intakeCategory}
          reason={intakeReason}
          onCategory={setIntakeCategory}
          onReason={setIntakeReason}
        />
      )}

      {showInvoice && (
        <InvoiceChoiceFields
          idPrefix={`${source}-invoice`}
          choice={invoiceChoice}
          invoiceNumber={invoiceNumber}
          reason={invoiceReason}
          onChoice={setInvoiceChoice}
          onInvoiceNumber={setInvoiceNumber}
          onReason={setInvoiceReason}
        />
      )}

      {selectedType === "Dispose" && (
        <>
          <div className="flex flex-col gap-2">
            <Label className="text-foreground">Disposal reason (min 15 characters)</Label>
            <Textarea
              className="min-h-[72px] bg-card text-foreground border-border"
              value={disposalReason}
              onChange={(e) => setDisposalReason(e.target.value)}
              placeholder="Why is this unit being disposed?"
              disabled={isSubmitting}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label className="text-foreground">Authorising admin</Label>
            <Select value={authorisedBy} onValueChange={setAuthorisedBy} disabled={isSubmitting}>
              <SelectTrigger className="bg-card text-foreground border-border">
                <SelectValue placeholder="Select active admin…" />
              </SelectTrigger>
              <SelectContent>
                {activeAdmins.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name}
                    {u.email ? ` (${u.email})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {activeAdmins.length === 0 ? (
              <p className="text-xs text-muted-foreground">No active admins found.</p>
            ) : null}
          </div>
        </>
      )}

      {showCloudKeys && (
        <div className="flex flex-col gap-2">
          <Label className="text-foreground">Cloud keys (required for FortiGate)</Label>
          <Textarea
            value={cloudKeysInput}
            onChange={(e) => setCloudKeysInput(e.target.value)}
            placeholder="One key per serial, same order…"
            className="min-h-[72px] font-mono text-sm bg-card text-foreground border-border"
            disabled={isSubmitting}
          />
        </div>
      )}

      <div className="flex flex-col gap-2">
        <Label className="text-foreground">Business date</Label>
        <Input
          type="date"
          min="2020-01-01"
          max={todayYmd}
          className="bg-card text-foreground border-border max-w-xs"
          value={businessDate}
          onChange={(e) => setBusinessDate(e.target.value)}
          disabled={isSubmitting}
        />
      </div>
    </>
  )

  const moreDetailsInner = (
    <>
      <div className="flex flex-col gap-2">
        <Label className="text-foreground">Notes</Label>
        <Textarea
          placeholder="Additional notes…"
          className="min-h-[72px] bg-card text-foreground border-border"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          disabled={isSubmitting}
        />
      </div>
      {showDeliveryNote && (
        <div className="flex flex-col gap-2">
          <Label className="text-foreground flex items-center gap-2">
            <Upload className="w-4 h-4 text-muted-foreground" />
            Delivery note (optional)
          </Label>
          {!deliveryNoteFile ? (
            <Input
              type="file"
              accept=".pdf,image/jpeg,image/png,image/webp,application/pdf"
              className="cursor-pointer text-sm file:mr-2 file:rounded-md file:border-0 file:bg-primary/10 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-primary"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) setDeliveryNoteFile(f)
                e.target.value = ""
              }}
              disabled={isSubmitting}
            />
          ) : (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
              <span className="truncate">{deliveryNoteFile.name}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => setDeliveryNoteFile(null)}
                aria-label="Remove delivery note"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          )}
        </div>
      )}
      {showDecommissionDoc && (
        <div className="flex flex-col gap-2">
          <Label className="text-foreground flex items-center gap-2">
            <Upload className="w-4 h-4 text-muted-foreground" />
            Invoice / reference document (optional)
          </Label>
          {!decommissionDocFile ? (
            <Input
              type="file"
              accept=".pdf,image/jpeg,image/png,image/webp,application/pdf"
              className="cursor-pointer text-sm file:mr-2 file:rounded-md file:border-0 file:bg-primary/10 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-primary"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) setDecommissionDocFile(f)
                e.target.value = ""
              }}
              disabled={isSubmitting}
            />
          ) : (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
              <span className="truncate">{decommissionDocFile.name}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => setDecommissionDocFile(null)}
                aria-label="Remove file"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  )

  const recordButton = (
    <Button
      className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
      onClick={() => void handleRecord()}
      disabled={isSubmitting || Boolean(blockMessage)}
      title={blockMessage ?? undefined}
    >
      {isSubmitting ? (
        <Loader2 className="w-4 h-4 animate-spin mr-1.5" />
      ) : (
        <Package className="w-4 h-4 mr-1.5" />
      )}
      <span className="truncate">{recordLabel}</span>
    </Button>
  )

  if (isCompact) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold text-foreground flex items-center gap-2">
            <ScanBarcode className="w-4 h-4 text-primary" />
            Quick Scan
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {typeSelector}
          {productField}
          {serialField}
          {typeSpecificFields}
          <Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="justify-start gap-1 px-0">
                <ChevronDown
                  className={cn("h-4 w-4 transition-transform", moreOpen && "rotate-180")}
                />
                More details
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-4 pt-2">
              {moreDetailsInner}
            </CollapsibleContent>
          </Collapsible>
          {recordButton}
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-6">
      <div className="lg:col-span-2 flex flex-col gap-4 md:gap-5">
        <Card className="flex flex-col">
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold text-foreground">Movement type</CardTitle>
          </CardHeader>
          <CardContent>{typeSelector}</CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold text-foreground flex items-center gap-2">
              <ScanBarcode className="w-4 h-4 text-primary" />
              {isEmbed ? "Selected items" : "Scan items"}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {productField}
            {serialField}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold text-foreground flex items-center gap-2">
              <FileText className="w-4 h-4 text-muted-foreground" />
              Details
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {typeSpecificFields}
            {moreDetailsInner}
            <div className="lg:hidden">{recordButton}</div>
          </CardContent>
        </Card>
      </div>

      <div className="hidden lg:block">
        <Card className="sticky top-4 flex flex-col">
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold text-foreground">Summary</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex items-center justify-between py-2 border-b border-border">
              <span className="text-sm text-muted-foreground">Type</span>
              {selectedType ? (
                <StatusPill value={selectedType} />
              ) : (
                <span className="text-sm text-muted-foreground">—</span>
              )}
            </div>
            <div className="flex items-center justify-between py-2 border-b border-border">
              <span className="text-sm text-muted-foreground">Product</span>
              <span className="text-sm text-foreground truncate max-w-[160px]" title={productName}>
                {productName ? productVendorLabel(productName, vendor) : "—"}
              </span>
            </div>
            {showClient && (
              <div className="flex items-center justify-between py-2 border-b border-border">
                <span className="text-sm text-muted-foreground">Client</span>
                <span className="text-sm text-foreground truncate max-w-[160px]">{clientDisplay}</span>
              </div>
            )}
            <div className="flex items-center justify-between py-2 border-b border-border">
              <span className="text-sm text-muted-foreground">Valid serials</span>
              <span className="text-sm font-semibold text-foreground">
                {serialFeedback.validSerials.length}
              </span>
            </div>
            {selectedType === "Transfer" && (
              <>
                <div className="flex items-center justify-between py-2 border-b border-border">
                  <span className="text-sm text-muted-foreground">From</span>
                  <span className="text-sm text-foreground">
                    {transferOrigin.location ?? (transferOrigin.mixed ? "Mixed" : "—")}
                  </span>
                </div>
                <div className="flex items-center justify-between py-2 border-b border-border">
                  <span className="text-sm text-muted-foreground">To</span>
                  <span className="text-sm text-foreground">{toLocation || "—"}</span>
                </div>
              </>
            )}
            <div className="pt-2">{recordButton}</div>
            {blockMessage ? (
              <p className="text-xs text-muted-foreground">{blockMessage}</p>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
