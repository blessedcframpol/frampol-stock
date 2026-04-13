"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import { useAuth } from "@/lib/auth-context"
import type { DeviceTypeName, ClientSite } from "@/lib/data"
import { useClients, insertClient } from "@/lib/supabase/clients-db"
import { useInventoryStore } from "@/lib/inventory-store"
import { getSupabaseClient } from "@/lib/supabase/client"
import {
  createStockRequest,
  replaceDraftLines,
  submitStockRequest,
  updateDraftRequest,
  uploadQuotationForRequest,
  type StockRequestWithRelations,
} from "@/lib/supabase/stock-requests-db"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"
import { ArrowLeft, ChevronsUpDown, Loader2, Plus, Trash2, Upload, X } from "lucide-react"

const DEVICE_TYPE_LABELS: { value: DeviceTypeName; label: string }[] = [
  { value: "Starlink Kit", label: "Starlink Kit" },
  { value: "Laptop", label: "Laptop" },
  { value: "Desktop", label: "Desktop" },
  { value: "Router", label: "Router" },
  { value: "Switch", label: "Switch" },
  { value: "Access Point", label: "Access Point" },
  { value: "UPS", label: "UPS" },
  { value: "Monitor", label: "Monitor" },
]

export type LineDraft = {
  id: string
  productName: string
  deviceType: string | null
  quantity: number
}

function newLine(): LineDraft {
  return {
    id: `l-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    productName: "",
    deviceType: null,
    quantity: 1,
  }
}

export function StockRequestForm({
  mode,
  initialRequest,
  onCancelHref = "/requests",
}: {
  mode: "create" | "edit"
  initialRequest?: StockRequestWithRelations | null
  onCancelHref?: string
}) {
  const router = useRouter()
  const { user } = useAuth()
  const { clients, refetch: refetchClients } = useClients()
  const { inventory } = useInventoryStore()

  const [clientId, setClientId] = useState("")
  const [notes, setNotes] = useState("")
  const [lines, setLines] = useState<LineDraft[]>([newLine()])
  const [quoteFile, setQuoteFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [newClientOpen, setNewClientOpen] = useState(false)
  const [newClientName, setNewClientName] = useState("")
  const [newClientCompany, setNewClientCompany] = useState("")
  const [newClientEmail, setNewClientEmail] = useState("")
  const [newClientPhone, setNewClientPhone] = useState("")
  const [sites, setSites] = useState<ClientSite[]>([{ address: "" }])

  const productNames = useMemo(() => {
    const names = new Set<string>()
    inventory.forEach((item) => names.add(item.name))
    return Array.from(names).sort()
  }, [inventory])
  const productOptions = useMemo(() => {
    const types = DEVICE_TYPE_LABELS.map((o) => o.label)
    const combined = [...productNames]
    types.forEach((t) => {
      if (!combined.includes(t)) combined.push(t)
    })
    return combined.sort()
  }, [productNames])

  const requestId = mode === "edit" && initialRequest ? initialRequest.id : null

  useEffect(() => {
    if (mode !== "edit" || !initialRequest) return
    setClientId(initialRequest.client_id)
    setNotes(initialRequest.notes ?? "")
    setLines(
      (initialRequest.stock_request_lines ?? []).length === 0
        ? [newLine()]
        : (initialRequest.stock_request_lines ?? []).map((l) => ({
            id: l.id,
            productName: l.product_name,
            deviceType: l.device_type,
            quantity: l.quantity_requested,
          }))
    )
    setQuoteFile(null)
  }, [mode, initialRequest])

  const inferTypeForName = useCallback(
    (name: string): string | null => {
      const row = inventory.find((i) => i.name === name)
      return row?.deviceType ?? null
    },
    [inventory]
  )

  async function ensureClient(): Promise<string | null> {
    if (clientId) return clientId
    toast.error("Select a client.")
    return null
  }

  function validateLines(): LineDraft[] | null {
    const cleaned = lines.filter((l) => l.productName.trim() && l.quantity >= 1)
    if (cleaned.length === 0) {
      toast.error("Add at least one line with product and quantity.")
      return null
    }
    return cleaned.map((l) => ({
      ...l,
      productName: l.productName.trim(),
      deviceType: l.deviceType ?? inferTypeForName(l.productName.trim()),
    }))
  }

  async function persistDraftAndMaybeQuote(
    sb: ReturnType<typeof getSupabaseClient>,
    rid: string,
    effectiveLines: LineDraft[]
  ) {
    await updateDraftRequest(sb, rid, {
      notes: notes.trim() || null,
      clientId,
    })
    await replaceDraftLines(
      sb,
      rid,
      effectiveLines.map((l) => ({
        productName: l.productName.trim(),
        deviceType: l.deviceType ?? inferTypeForName(l.productName.trim()),
        quantity: l.quantity,
      }))
    )
    if (quoteFile) {
      const url = await uploadQuotationForRequest(sb, rid, quoteFile)
      await updateDraftRequest(sb, rid, { quotationUrl: url })
      setQuoteFile(null)
    }
  }

  async function handleSaveDraft() {
    const sbUserId = user?.id
    if (!sbUserId) {
      toast.error("You must be signed in.")
      return
    }
    const cid = await ensureClient()
    if (!cid) return
    const okLines = validateLines()
    if (!okLines) return

    setBusy(true)
    try {
      const sb = getSupabaseClient()
      if (mode === "create" || !requestId) {
        const created = await createStockRequest(sb, {
          clientId: cid,
          createdBy: sbUserId,
          notes: notes.trim() || null,
          lines: okLines.map((l) => ({
            productName: l.productName,
            deviceType: l.deviceType ?? inferTypeForName(l.productName),
            quantity: l.quantity,
          })),
        })
        if (quoteFile) {
          const url = await uploadQuotationForRequest(sb, created.id, quoteFile)
          await updateDraftRequest(sb, created.id, { quotationUrl: url })
          setQuoteFile(null)
        }
        toast.success("Draft saved.")
        router.push(`/requests/${created.id}`)
        router.refresh()
        return
      }
      await persistDraftAndMaybeQuote(sb, requestId, okLines)
      toast.success("Draft updated.")
      router.refresh()
    } catch (e) {
      toastFromCaughtError(e, "Could not save draft")
    } finally {
      setBusy(false)
    }
  }

  async function handleSubmitRequest() {
    const sbUserId = user?.id
    if (!sbUserId) {
      toast.error("You must be signed in.")
      return
    }
    const cid = await ensureClient()
    if (!cid) return
    const okLines = validateLines()
    if (!okLines) return

    setBusy(true)
    try {
      const sb = getSupabaseClient()
      let rid = requestId
      if (mode === "create" || !rid) {
        const created = await createStockRequest(sb, {
          clientId: cid,
          createdBy: sbUserId,
          notes: notes.trim() || null,
          lines: okLines.map((l) => ({
            productName: l.productName,
            deviceType: l.deviceType ?? inferTypeForName(l.productName),
            quantity: l.quantity,
          })),
        })
        rid = created.id
        if (quoteFile) {
          const url = await uploadQuotationForRequest(sb, rid, quoteFile)
          await updateDraftRequest(sb, rid, { quotationUrl: url })
          setQuoteFile(null)
        }
      } else {
        await persistDraftAndMaybeQuote(sb, rid, okLines)
      }
      await submitStockRequest(sb, rid!)
      toast.success("Request submitted.")
      router.push(`/requests/${rid}`)
      router.refresh()
    } catch (e) {
      toastFromCaughtError(e, "Could not submit request")
    } finally {
      setBusy(false)
    }
  }

  async function handleCreateClient() {
    const addr = sites.map((s) => s.address.trim()).filter(Boolean)
    if (!newClientName.trim() || !newClientCompany.trim() || !newClientEmail.trim() || addr.length === 0) {
      toast.error("Name, company, email, and at least one site address are required.")
      return
    }
    setBusy(true)
    try {
      const created = await insertClient({
        name: newClientName.trim(),
        company: newClientCompany.trim(),
        email: newClientEmail.trim(),
        phone: newClientPhone.trim(),
        sites: sites.map((s) => ({ ...s, address: s.address.trim() })).filter((s) => s.address),
      })
      await refetchClients()
      setClientId(created.id)
      setNewClientOpen(false)
      setNewClientName("")
      setNewClientCompany("")
      setNewClientEmail("")
      setNewClientPhone("")
      setSites([{ address: "" }])
      toast.success("Client created.")
    } catch (e) {
      toastFromCaughtError(e, "Could not create client")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" asChild className="gap-1 -ml-2">
          <Link href={onCancelHref}>
            <ArrowLeft className="size-4" />
            Back
          </Link>
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">{mode === "create" ? "New stock request" : "Edit draft"}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label>Client</Label>
              <Button type="button" variant="outline" size="sm" onClick={() => setNewClientOpen(true)}>
                <Plus className="size-3.5 mr-1" />
                New client
              </Button>
            </div>
            <Select value={clientId || undefined} onValueChange={setClientId}>
              <SelectTrigger className="bg-card border-border">
                <SelectValue placeholder="Select client…" />
              </SelectTrigger>
              <SelectContent>
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} — {c.company}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Line products must match inventory item names for availability and serial assignment.</p>
          </div>

          <div className="flex flex-col gap-2">
            <Label>Line items</Label>
            <div className="flex flex-col gap-3">
              {lines.map((line) => (
                <LineRowEditor
                  key={line.id}
                  line={line}
                  productOptions={productOptions}
                  inventory={inventory}
                  disabled={busy}
                  onProductChange={(name) => {
                    const deviceType = inventory.find((i) => i.name === name)?.deviceType ?? null
                    const t = DEVICE_TYPE_LABELS.find((x) => x.label === name)?.value ?? null
                    setLines((prev) =>
                      prev.map((l) =>
                        l.id === line.id ? { ...l, productName: name, deviceType: deviceType ?? t } : l
                      )
                    )
                  }}
                  onQuantityChange={(q) =>
                    setLines((prev) => prev.map((l) => (l.id === line.id ? { ...l, quantity: q } : l)))
                  }
                  onRemove={() => lines.length > 1 && setLines((prev) => prev.filter((l) => l.id !== line.id))}
                  canRemove={lines.length > 1}
                />
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() => setLines((prev) => [...prev, newLine()])}
            >
              <Plus className="size-3.5 mr-1" />
              Add line
            </Button>
          </div>

          <div className="flex flex-col gap-2">
            <Label>Notes (optional)</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Internal notes for technicians or accounts…"
              className="bg-card border-border min-h-[80px]"
              disabled={busy}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label className="flex items-center gap-2">
              <Upload className="size-3.5 text-muted-foreground" />
              Quotation file (optional)
            </Label>
            {!quoteFile ? (
              <Input
                type="file"
                accept=".pdf,image/jpeg,image/png,application/pdf"
                className="cursor-pointer text-sm file:mr-2 file:rounded-md file:border-0 file:bg-primary/10 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-primary"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) setQuoteFile(f)
                  e.target.value = ""
                }}
              />
            ) : (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
                <span className="truncate">{quoteFile.name}</span>
                <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" onClick={() => setQuoteFile(null)}>
                  <X className="size-4" />
                </Button>
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
            <Button type="button" variant="secondary" disabled={busy} onClick={() => void handleSaveDraft()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {mode === "edit" ? "Save draft" : "Save as draft"}
            </Button>
            <Button type="button" disabled={busy} onClick={() => void handleSubmitRequest()}>
              {busy ? <Loader2 className="size-4 animate-spin mr-2" /> : null}
              Submit request
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={newClientOpen} onOpenChange={setNewClientOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New client</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 text-sm">
            <div className="grid gap-2">
              <Label htmlFor="nc-name">Name</Label>
              <Input id="nc-name" value={newClientName} onChange={(e) => setNewClientName(e.target.value)} className="bg-card" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="nc-co">Company</Label>
              <Input id="nc-co" value={newClientCompany} onChange={(e) => setNewClientCompany(e.target.value)} className="bg-card" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="nc-email">Email</Label>
              <Input id="nc-email" type="email" value={newClientEmail} onChange={(e) => setNewClientEmail(e.target.value)} className="bg-card" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="nc-phone">Phone</Label>
              <Input id="nc-phone" value={newClientPhone} onChange={(e) => setNewClientPhone(e.target.value)} className="bg-card" />
            </div>
            <div className="grid gap-2">
              <Label>Site addresses</Label>
              {sites.map((s, i) => (
                <div key={i} className="flex gap-2">
                  <Input
                    placeholder="Address"
                    value={s.address}
                    onChange={(e) =>
                      setSites((prev) => prev.map((x, j) => (j === i ? { ...x, address: e.target.value } : x)))
                    }
                    className="bg-card"
                  />
                  {sites.length > 1 && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => setSites((prev) => prev.filter((_, j) => j !== i))}>
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => setSites((prev) => [...prev, { address: "" }])}>
                Add site
              </Button>
            </div>
            <Button type="button" onClick={() => void handleCreateClient()} disabled={busy}>
              Create client
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function LineRowEditor({
  line,
  productOptions,
  inventory,
  disabled,
  onProductChange,
  onQuantityChange,
  onRemove,
  canRemove,
}: {
  line: LineDraft
  productOptions: string[]
  inventory: { name: string; deviceType: string }[]
  disabled: boolean
  onProductChange: (name: string) => void
  onQuantityChange: (q: number) => void
  onRemove: () => void
  canRemove: boolean
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? productOptions.filter((n) => n.toLowerCase().includes(q)) : productOptions
  }, [productOptions, search])

  const typeHint = inventory.find((i) => i.name === line.productName)?.deviceType ?? line.deviceType

  return (
    <div className="flex flex-col sm:flex-row gap-2 sm:items-end p-3 rounded-lg border border-border bg-muted/20">
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <Label className="text-xs text-muted-foreground">Product (inventory name)</Label>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              disabled={disabled}
              className={cn("w-full justify-between font-normal bg-card", !line.productName && "text-muted-foreground")}
            >
              {line.productName || "Search product…"}
              <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
            <Command shouldFilter={false}>
              <CommandInput placeholder="Search…" value={search} onValueChange={setSearch} />
              <CommandList>
                <CommandEmpty>No match.</CommandEmpty>
                <CommandGroup>
                  {filtered.slice(0, 100).map((name) => (
                    <CommandItem
                      key={name}
                      value={name}
                      onSelect={() => {
                        onProductChange(name)
                        setSearch("")
                        setOpen(false)
                      }}
                    >
                      {name}
                    </CommandItem>
                  ))}
                  {search.trim() &&
                    !productOptions.some((o) => o.toLowerCase() === search.trim().toLowerCase()) && (
                      <CommandItem
                        value={`__add:${search.trim()}`}
                        onSelect={() => {
                          onProductChange(search.trim())
                          setSearch("")
                          setOpen(false)
                        }}
                        className="text-primary"
                      >
                        Use &quot;{search.trim()}&quot;
                      </CommandItem>
                    )}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        {typeHint ? <p className="text-[11px] text-muted-foreground">Type: {typeHint}</p> : null}
      </div>
      <div className="w-full sm:w-24 flex flex-col gap-1">
        <Label className="text-xs text-muted-foreground">Qty</Label>
        <Input
          type="number"
          min={1}
          value={line.quantity}
          onChange={(e) => onQuantityChange(Math.max(1, parseInt(e.target.value, 10) || 1))}
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
