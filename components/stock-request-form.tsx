"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { InvoiceChoiceFields } from "@/components/invoice-choice-fields"
import { useAuth } from "@/lib/auth-context"
import { formatClientLabel } from "@/lib/client-label"
import { useClients } from "@/lib/clients-store"
import { ClientNc1Fields } from "@/components/client-nc1-fields"
import { ClientDuplicateDialog } from "@/components/client-duplicate-dialog"
import { useNc1ClientCreate } from "@/lib/use-nc1-client-create"
import { getSupabaseClient } from "@/lib/supabase/client"
import { fetchProductCatalogue } from "@/lib/product-catalogue"
import {
  resubmitRequest,
  submitRequest,
  type StockRequestWithRelations,
} from "@/lib/supabase/stock-requests-db"
import { clientCommandItemValue, filterClientsForPicker } from "@/lib/search"
import { invoiceChoiceProblem, type InvoiceChoice, type NotInvoicedKind } from "@/lib/invoices"
import { fetchAppSettings } from "@/lib/settings"
import {
  ATLAS_TASK_URL_EXAMPLE,
  REQUEST_TYPES,
  atlasTaskUrlProblemWhenRequired,
  clientIsAutomatic,
  requestLinesProblem,
  requestTypeNeedsReturnDate,
  returnDateProblem,
  type FormLine,
  type RequestType,
} from "@/lib/stock-request-form-rules"
import { REJECT_REASON_LABELS } from "@/lib/stock-request-statuses"
import { todayBusinessDate } from "@/lib/business-date.mjs"
import { useOrgTimezone } from "@/hooks/use-org-timezone"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"
import { AlertCircle, Check, ChevronsUpDown, Loader2, Plus, Trash2 } from "lucide-react"
import { PageBreadcrumbs } from "@/components/page-breadcrumbs"
import { ADMIN, canCreateStockRequest } from "@/lib/permissions"
import { availabilityByProductId, fetchStockAvailability, overRequestWarning } from "@/lib/stock-availability"
import { useEffectiveRole } from "@/lib/dev-role-preview"

type LineDraft = {
  id: string
  productId: string
  productName: string
  vendor: string | null
  quantity: number
}

type ProductOption = { id: string; name: string; vendor: string | null }

function newLine(): LineDraft {
  return {
    id: `l-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    productId: "",
    productName: "",
    vendor: null,
    quantity: 1,
  }
}

function linesFromRequest(request: StockRequestWithRelations): LineDraft[] {
  const rows = request.stock_request_lines ?? []
  if (rows.length === 0) return [newLine()]
  return rows.map((l) => ({
    id: l.id,
    productId: l.product_id,
    productName: l.product_name,
    vendor: l.vendor,
    quantity: l.quantity_requested,
  }))
}

function choiceFromRequest(request: StockRequestWithRelations): InvoiceChoice {
  if (request.invoice_status === "invoiced") return "number"
  if (request.invoice_status === "not_invoiced") return "not_invoiced"
  return "pending"
}

function toFormLines(lines: LineDraft[]): FormLine[] {
  return lines.map((l) => ({
    productId: l.productId,
    productName: l.productName,
    vendor: l.vendor,
    quantity: l.quantity,
  }))
}

export function StockRequestForm({
  mode,
  initialRequest,
  onCancelHref = "/requests",
}: {
  mode: "create" | "resubmit"
  initialRequest?: StockRequestWithRelations | null
  onCancelHref?: string
}) {
  const router = useRouter()
  const { user } = useAuth()
  const role = useEffectiveRole()
  const canCreate = canCreateStockRequest(role)
  const timeZone = useOrgTimezone()
  const today = todayBusinessDate(timeZone)
  const { clients, upsertClient } = useClients()
  // Catalogue via product_catalogue (not inventory serials). Counts via stock_availability.
  const [catalogue, setCatalogue] = useState<ProductOption[]>([])
  const [availability, setAvailability] = useState<Record<string, number> | null>(null)

  useEffect(() => {
    if (!canCreate) return
    let cancelled = false
    void Promise.all([fetchProductCatalogue(), fetchStockAvailability()])
      .then(([products, rows]) => {
        if (cancelled) return
        setCatalogue(
          products.map((p) => ({
            id: p.product_id,
            name: p.product_name,
            vendor: p.vendor?.trim() || null,
          }))
        )
        setAvailability(availabilityByProductId(rows))
      })
      .catch(() => {
        // Catalogue/counts failure still leaves the form usable for resubmit seed lines.
      })
    return () => {
      cancelled = true
    }
  }, [canCreate])

  const seed = mode === "resubmit" ? (initialRequest ?? null) : null

  const [type, setType] = useState<RequestType>(() => (seed?.type as RequestType | undefined) ?? "Sale")
  const [returnDate, setReturnDate] = useState(() => seed?.return_date ?? "")
  const [clientId, setClientId] = useState(() => seed?.client_id ?? "")
  const [clientOpen, setClientOpen] = useState(false)
  const [clientSearch, setClientSearch] = useState("")
  const [atlasUrl, setAtlasUrl] = useState(() => seed?.atlas_task_url ?? "")
  const [atlasTouched, setAtlasTouched] = useState(false)
  const [notes, setNotes] = useState(() => seed?.notes ?? "")
  const [lines, setLines] = useState<LineDraft[]>(() => (seed ? linesFromRequest(seed) : [newLine()]))
  const [invoiceChoice, setInvoiceChoice] = useState<InvoiceChoice | "">(() =>
    seed ? choiceFromRequest(seed) : ""
  )
  const [invoiceNumber, setInvoiceNumber] = useState(() => seed?.invoice_number ?? "")
  const [notInvoicedReason, setNotInvoicedReason] = useState(() => seed?.not_invoiced_reason ?? "")
  const [notInvoicedKind, setNotInvoicedKind] = useState<NotInvoicedKind | "">(
    () => seed?.not_invoiced_kind ?? ""
  )
  const [busy, setBusy] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [newClientOpen, setNewClientOpen] = useState(false)
  const [atlasLinkRequired, setAtlasLinkRequired] = useState(true)
  const isAdmin = role === ADMIN
  const nc1 = useNc1ClientCreate(isAdmin)

  useEffect(() => {
    if (!canCreate) return
    let cancelled = false
    void fetchAppSettings()
      .then((s) => {
        if (!cancelled) setAtlasLinkRequired(s.atlasLinkRequired)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [canCreate])

  const productOptions = useMemo<ProductOption[]>(() => {
    const byId = new Map<string, ProductOption>()
    for (const p of catalogue) byId.set(p.id, p)
    // A resubmitted request may name a product that is no longer active.
    for (const l of seed?.stock_request_lines ?? []) {
      if (!byId.has(l.product_id)) {
        byId.set(l.product_id, { id: l.product_id, name: l.product_name, vendor: l.vendor })
      }
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [catalogue, seed])

  const sortedClients = useMemo(() => {
    const collator = new Intl.Collator(undefined, { sensitivity: "base" })
    return [...clients].sort((a, b) =>
      collator.compare(`${a.name} ${a.company}`.trim(), `${b.name} ${b.company}`.trim())
    )
  }, [clients])

  const selectedClient = clients.find((c) => c.id === clientId) ?? null
  const clientAuto = clientIsAutomatic(invoiceChoice, notInvoicedKind)
  const needsReturnDate = requestTypeNeedsReturnDate(type)

  const atlasProblem = atlasTaskUrlProblemWhenRequired(atlasUrl, atlasLinkRequired)
  const returnProblem = returnDateProblem(type, returnDate, today)
  const linesProblem = requestLinesProblem(type, toFormLines(lines))
  const invoiceProblem = invoiceChoiceProblem(invoiceChoice, invoiceNumber, notInvoicedReason, notInvoicedKind)
  const clientProblem = clientAuto || clientId ? null : "Pick a client from the directory"

  const firstProblem = clientProblem ?? returnProblem ?? atlasProblem ?? linesProblem ?? invoiceProblem

  function updateLine(id: string, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)))
  }

  async function handleSubmit() {
    setAttempted(true)
    setAtlasTouched(true)
    if (!user?.id) {
      toast.error("You must be signed in.")
      return
    }
    if (firstProblem) {
      toast.error(firstProblem)
      return
    }
    if (invoiceChoice === "") return

    setBusy(true)
    try {
      const sb = getSupabaseClient()
      const common = {
        clientId: clientAuto ? "" : clientId,
        type,
        returnDate: needsReturnDate ? returnDate : null,
        atlasTaskUrl: atlasUrl.trim(),
        notes: notes.trim() || null,
        invoiceChoice,
        invoiceNumber: invoiceChoice === "number" ? invoiceNumber.trim() : null,
        notInvoicedReason: invoiceChoice === "not_invoiced" ? notInvoicedReason.trim() : null,
        notInvoicedKind: invoiceChoice === "not_invoiced" ? notInvoicedKind || null : null,
        lines: lines.map((l) => ({
          productId: l.productId,
          productName: l.productName,
          quantity: l.quantity,
        })),
      }

      let requestId: string
      if (mode === "resubmit" && seed) {
        requestId = seed.id
        await resubmitRequest(sb, requestId, common)
        toast.success("Request resubmitted.")
      } else {
        requestId = await submitRequest(sb, common)
        toast.success("Request submitted.")
      }
      router.push(`/requests/${requestId}`)
      router.refresh()
    } catch (e) {
      toastFromCaughtError(e, mode === "resubmit" ? "Could not resubmit request" : "Could not submit request")
    } finally {
      setBusy(false)
    }
  }

  async function finishNewClientSelection(created: { id: string }) {
    // created row already upserted by caller when available; ensure id is selected
    setClientId(created.id)
    setNewClientOpen(false)
    nc1.reset()
    toast.success("Client created.")
  }

  async function handleCreateClient() {
    const created = await nc1.submitNewClient()
    if (created) {
      upsertClient(created)
      await finishNewClientSelection(created)
    }
  }

  async function handleNc1CreateAnyway() {
    const created = await nc1.confirmCreateAnyway()
    if (created) {
      upsertClient(created)
      await finishNewClientSelection(created)
    }
  }

  const breadcrumbs =
    mode === "resubmit" && initialRequest
      ? [
          { label: "Requests", href: "/requests" },
          { label: initialRequest.id, href: onCancelHref },
          { label: "Edit and resubmit" },
        ]
      : [{ label: "Requests", href: "/requests" }, { label: "New" }]

  if (!canCreate) {
    return (
      <div className="flex flex-col gap-4">
        <PageBreadcrumbs items={breadcrumbs} />
        <p className="text-sm text-muted-foreground">
          Your account has read-only access to stock requests.
        </p>
      </div>
    )
  }

  const rejectReason =
    seed?.reject_reason_code != null
      ? `${REJECT_REASON_LABELS[seed.reject_reason_code] ?? seed.reject_reason_code}${
          seed.reject_note ? ` — ${seed.reject_note}` : ""
        }`
      : null

  return (
    <div className="flex flex-col gap-6 max-w-3xl min-w-0 w-full pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <PageBreadcrumbs items={breadcrumbs} />

      {mode === "resubmit" && rejectReason ? (
        <div
          role="alert"
          className="flex gap-3 rounded-lg border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger"
        >
          <AlertCircle className="size-5 shrink-0" />
          <p>
            <span className="font-medium">Rejected:</span> {rejectReason}. Fix what was asked for and resubmit.
          </p>
        </div>
      ) : null}

      {!atlasLinkRequired && mode === "create" ? (
        <div
          role="status"
          className="flex gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-950 dark:text-amber-100"
        >
          <AlertCircle className="size-5 shrink-0" />
          <p>
            Atlas is down — you can submit without a task link and add it later.
          </p>
        </div>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">
            {mode === "create" ? "New stock request" : "Edit and resubmit"}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="rq-type">Type</Label>
              <Select
                value={type}
                onValueChange={(v) => {
                  setType(v as RequestType)
                  if (!requestTypeNeedsReturnDate(v)) setReturnDate("")
                }}
              >
                <SelectTrigger id="rq-type" className="min-h-11 bg-card border-border text-base sm:text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REQUEST_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {needsReturnDate ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor="rq-return">Return date</Label>
                <Input
                  id="rq-return"
                  type="date"
                  value={returnDate}
                  min={today}
                  onChange={(e) => setReturnDate(e.target.value)}
                  className="min-h-11 bg-card border-border text-base sm:text-sm"
                  disabled={busy}
                  aria-invalid={attempted && returnProblem ? true : undefined}
                />
                {returnDate && returnProblem ? (
                  <p className="text-sm text-destructive">{returnProblem}</p>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label>Client</Label>
              {!clientAuto ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setNewClientOpen(true)}>
                  <Plus className="size-3.5 mr-1" />
                  New client
                </Button>
              ) : null}
            </div>
            {clientAuto ? (
              <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                Internal 00000 request — the internal client is set automatically.
              </p>
            ) : (
              <Popover open={clientOpen} onOpenChange={setClientOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    role="combobox"
                    aria-expanded={clientOpen}
                    className="min-h-11 w-full justify-between font-normal bg-card text-base sm:text-sm"
                    disabled={busy}
                  >
                    <span className={cn("truncate", !selectedClient && "text-muted-foreground")}>
                      {selectedClient ? formatClientLabel(selectedClient) : "Search existing client…"}
                    </span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-0 max-w-[calc(100vw-2rem)] sm:min-w-[300px] p-0" align="start">
                  <Command shouldFilter={false}>
                    <CommandInput
                      placeholder="Search clients…"
                      value={clientSearch}
                      onValueChange={setClientSearch}
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
                              setClientOpen(false)
                              setClientSearch("")
                            }}
                          >
                            <Check className={cn("mr-2 size-4", c.id === clientId ? "opacity-100" : "opacity-0")} />
                            {formatClientLabel(c)}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            )}
            {attempted && clientProblem ? <p className="text-sm text-destructive">{clientProblem}</p> : null}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="rq-atlas">
              Atlas task link{!atlasLinkRequired ? " (optional while Atlas is down)" : ""}
            </Label>
            <Input
              id="rq-atlas"
              value={atlasUrl}
              onChange={(e) => setAtlasUrl(e.target.value)}
              onBlur={() => setAtlasTouched(true)}
              placeholder={ATLAS_TASK_URL_EXAMPLE}
              className="min-h-11 bg-card border-border font-mono text-sm sm:text-xs"
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="done"
              aria-invalid={(atlasTouched || attempted || atlasUrl.length > 0) && atlasProblem ? true : undefined}
            />
            {atlasUrl.length > 0 ? (
              atlasProblem ? (
                <p className="text-sm text-destructive">{atlasProblem}</p>
              ) : (
                <p className="flex items-center gap-1 text-sm text-success">
                  <Check className="size-3.5" />
                  Link looks right
                </p>
              )
            ) : attempted || atlasTouched ? (
              <p className="text-sm text-destructive">{atlasProblem}</p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <Label>Line items</Label>
            <div className="flex flex-col gap-3">
              {lines.map((line) => (
                <LineRowEditor
                  key={line.id}
                  line={line}
                  products={productOptions}
                  taken={new Set(lines.filter((l) => l.id !== line.id).map((l) => l.productId))}
                  available={line.productId && availability ? (availability[line.productId] ?? null) : null}
                  disabled={busy}
                  onProduct={(p) =>
                    updateLine(line.id, { productId: p.id, productName: p.name, vendor: p.vendor })
                  }
                  onQuantity={(q) => updateLine(line.id, { quantity: q })}
                  onRemove={() => setLines((prev) => prev.filter((l) => l.id !== line.id))}
                  canRemove={lines.length > 1}
                />
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-fit"
              disabled={busy}
              onClick={() => setLines((prev) => [...prev, newLine()])}
            >
              <Plus className="size-3.5 mr-1" />
              Add line
            </Button>
            {(attempted || lines.some((l) => l.productId)) && linesProblem ? (
              <p className="text-sm text-destructive">{linesProblem}</p>
            ) : null}
          </div>

          <InvoiceChoiceFields
            idPrefix="rq-invoice"
            choice={invoiceChoice}
            invoiceNumber={invoiceNumber}
            reason={notInvoicedReason}
            kind={notInvoicedKind}
            onChoice={setInvoiceChoice}
            onInvoiceNumber={setInvoiceNumber}
            onReason={setNotInvoicedReason}
            onKind={setNotInvoicedKind}
          />
          {attempted && !invoiceChoice ? (
            <p className="-mt-3 text-sm text-destructive">{invoiceProblem}</p>
          ) : null}

          <div className="flex flex-col gap-2">
            <Label>Notes (optional)</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Notes for whoever issues the units…"
              className="bg-card border-border min-h-[80px]"
              disabled={busy}
            />
          </div>

          <div className="flex flex-col-reverse gap-2 pt-2 border-t border-border sm:flex-row sm:flex-wrap">
            <Button
              type="button"
              className="min-h-11 w-full sm:w-auto"
              disabled={busy}
              onClick={() => void handleSubmit()}
            >
              {busy ? <Loader2 className="size-4 animate-spin mr-2" /> : null}
              {mode === "resubmit" ? "Resubmit request" : "Submit request"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="min-h-11 w-full sm:w-auto"
              disabled={busy}
              onClick={() => router.push(onCancelHref)}
            >
              Cancel
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={newClientOpen}
        onOpenChange={(open) => {
          setNewClientOpen(open)
          if (!open) nc1.reset()
        }}
      >
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New client</DialogTitle>
          </DialogHeader>
          <ClientNc1Fields
            idPrefix="request-new-client"
            kind={nc1.kind}
            onKind={nc1.setKind}
            name={nc1.name}
            onName={nc1.setName}
            company={nc1.company}
            onCompany={nc1.setCompany}
            email={nc1.email}
            onEmail={nc1.setEmail}
            phone={nc1.phone}
            onPhone={nc1.setPhone}
            sites={nc1.sites}
            onSites={nc1.setSites}
            errors={nc1.fieldErrors}
            showKindPicker
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setNewClientOpen(false)} disabled={nc1.busy}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void handleCreateClient()} disabled={nc1.busy || busy}>
              {nc1.busy ? <Loader2 className="size-4 animate-spin mr-2" /> : null}
              Create client
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ClientDuplicateDialog
        open={nc1.dupOpen}
        matches={nc1.dupMatches}
        isAdmin={isAdmin}
        forceReason={nc1.dupForceReason}
        onForceReason={nc1.setDupForceReason}
        onUseExisting={(id) => {
          nc1.setDupOpen(false)
          setClientId(id)
          setNewClientOpen(false)
          nc1.reset()
        }}
        onCreateAnyway={() => void handleNc1CreateAnyway()}
        onCancel={() => nc1.setDupOpen(false)}
        busy={nc1.busy}
      />
    </div>
  )
}

function LineRowEditor({
  line,
  products,
  taken,
  available,
  disabled,
  onProduct,
  onQuantity,
  onRemove,
  canRemove,
}: {
  line: LineDraft
  products: ProductOption[]
  /** Product ids already used on other lines. */
  taken: Set<string>
  /** Units in stock for the chosen product; null when unknown. */
  available: number | null
  disabled: boolean
  onProduct: (product: ProductOption) => void
  onQuantity: (q: number) => void
  onRemove: () => void
  canRemove: boolean
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return products.filter(
      (p) =>
        !taken.has(p.id) &&
        (!q || p.name.toLowerCase().includes(q) || (p.vendor ?? "").toLowerCase().includes(q))
    )
  }, [products, taken, search])

  const stockWarning = overRequestWarning(line.quantity, available)

  return (
    <div className="flex flex-col sm:flex-row gap-2 sm:items-end p-3 rounded-lg border border-border bg-muted/20">
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <Label className="text-xs text-muted-foreground">Product</Label>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              role="combobox"
              aria-expanded={open}
              className="w-full justify-between h-10 font-normal bg-card"
              disabled={disabled}
            >
              <span className={cn("truncate", !line.productId && "text-muted-foreground")}>
                {line.productName || "Select a product…"}
              </span>
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-0 max-w-[calc(100vw-2rem)] sm:min-w-[260px] p-0" align="start">
            <Command shouldFilter={false}>
              <CommandInput placeholder="Search products…" value={search} onValueChange={setSearch} />
              <CommandList>
                <CommandEmpty>No product found.</CommandEmpty>
                <CommandGroup>
                  {visible.map((p) => (
                    <CommandItem
                      key={p.id}
                      value={`${p.name} ${p.vendor ?? ""} ${p.id}`}
                      onSelect={() => {
                        onProduct(p)
                        setOpen(false)
                        setSearch("")
                      }}
                    >
                      <Check className={cn("mr-2 size-4", p.id === line.productId ? "opacity-100" : "opacity-0")} />
                      <span className="truncate">{p.name}</span>
                      {p.vendor ? <span className="ml-auto pl-2 text-xs text-muted-foreground">{p.vendor}</span> : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        {line.vendor || available != null ? (
          <p className="flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
            {line.vendor ? <span>Vendor: {line.vendor}</span> : null}
            {available != null ? <span>In stock: {available}</span> : null}
          </p>
        ) : null}
        {stockWarning ? (
          <p role="status" className="text-xs text-warning">
            {stockWarning}
          </p>
        ) : null}
      </div>
      <div className="w-full sm:w-24 flex flex-col gap-1">
        <Label className="text-xs text-muted-foreground">Qty</Label>
        <Input
          type="number"
          min={1}
          value={line.quantity}
          onChange={(e) => onQuantity(Math.max(1, parseInt(e.target.value, 10) || 1))}
          className="bg-card"
          disabled={disabled}
        />
      </div>
      {canRemove && (
        <Button type="button" variant="ghost" size="icon" className="shrink-0 text-muted-foreground" disabled={disabled} onClick={onRemove}>
          <Trash2 className="size-4" />
        </Button>
      )}
    </div>
  )
}
