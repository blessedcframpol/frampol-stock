"use client"

import Link from "next/link"
import { useEffect, useMemo, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { countOrderGroupsForClient } from "@/lib/client-transactions"
import { useInventoryStore } from "@/lib/inventory-store"
import { useClients, insertClient, updateClient } from "@/lib/supabase/clients-db"
import type { Client, ClientSite } from "@/lib/data"
import {
  Search,
  Mail,
  Phone,
  Building2,
  ShoppingBag,
  Plus,
  MapPin,
  Trash2,
  LayoutList,
  LayoutGrid,
  ChevronLeft,
  ChevronRight,
  Pencil,
} from "lucide-react"
import { toast } from "sonner"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"
import { PageHeader } from "@/components/page-nav"

const PAGE_SIZE = 24

type ClientView = "list" | "tiles"

function clientInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  return parts
    .slice(0, 2)
    .map((n) => n[0]!.toUpperCase())
    .join("")
}

export function ClientsContent() {
  const [search, setSearch] = useState("")
  const [view, setView] = useState<ClientView>("list")
  const [page, setPage] = useState(1)
  const { clients, isLoading, error, refetch } = useClients()
  const { transactions } = useInventoryStore()

  const [formOpen, setFormOpen] = useState(false)
  const [editingClient, setEditingClient] = useState<Client | null>(null)
  const [formName, setFormName] = useState("")
  const [formCompany, setFormCompany] = useState("")
  const [formEmail, setFormEmail] = useState("")
  const [formPhone, setFormPhone] = useState("")
  const [formSites, setFormSites] = useState<ClientSite[]>([{ address: "" }])
  const [isSubmitting, setIsSubmitting] = useState(false)

  function resetFormFields() {
    setEditingClient(null)
    setFormName("")
    setFormCompany("")
    setFormEmail("")
    setFormPhone("")
    setFormSites([{ address: "" }])
  }

  function openAddClient() {
    resetFormFields()
    setFormOpen(true)
  }

  function openEditClient(client: Client) {
    setEditingClient(client)
    setFormName(client.name)
    setFormCompany(client.company)
    setFormEmail(client.email)
    setFormPhone(client.phone ?? "")
    setFormSites(
      client.sites?.length
        ? client.sites.map((s) => ({ name: s.name ?? "", address: s.address }))
        : client.address
          ? [{ name: "", address: client.address }]
          : [{ name: "", address: "" }]
    )
    setFormOpen(true)
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = !q
      ? clients
      : clients.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            c.company.toLowerCase().includes(q) ||
            c.email.toLowerCase().includes(q) ||
            (c.phone ?? "").toLowerCase().includes(q)
        )
    return [...list].sort((a, b) => {
      const companyCmp = a.company.localeCompare(b.company, undefined, { sensitivity: "base" })
      if (companyCmp !== 0) return companyCmp
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    })
  }, [clients, search])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)

  useEffect(() => {
    setPage(1)
  }, [search])

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  const pageClients = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE
    return filtered.slice(start, start + PAGE_SIZE)
  }, [filtered, safePage])

  /** Only for the visible page — full-directory count was O(clients × transactions). */
  const orderCountByClientId = useMemo(() => {
    const map = new Map<string, number>()
    for (const c of pageClients) {
      map.set(c.id, countOrderGroupsForClient(transactions, c))
    }
    return map
  }, [pageClients, transactions])

  function addFormSiteRow() {
    setFormSites((prev) => [...prev, { address: "" }])
  }

  function removeFormSiteRow(index: number) {
    setFormSites((prev) => prev.filter((_, i) => i !== index))
  }

  function updateFormSite(index: number, field: "name" | "address", value: string) {
    setFormSites((prev) => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)))
  }

  async function handleSaveClient() {
    const name = formName.trim()
    const company = formCompany.trim()
    const email = formEmail.trim()
    const phone = formPhone.trim()
    const validSites = formSites
      .filter((s) => s.address.trim())
      .map((s) => ({
        ...(s.name?.trim() ? { name: s.name.trim() } : {}),
        address: s.address.trim(),
      }))
    if (!name || !company || !email || !phone) {
      toast.error("All fields are required: name, company, email, and phone")
      return
    }
    if (validSites.length === 0) {
      toast.error("Add at least one site with an address")
      return
    }
    setIsSubmitting(true)
    try {
      if (editingClient) {
        await updateClient(editingClient.id, { name, company, email, phone, sites: validSites })
        toast.success("Client updated")
      } else {
        await insertClient({ name, company, email, phone, sites: validSites })
        toast.success("Client added")
      }
      await refetch()
      setFormOpen(false)
      resetFormFields()
    } catch (e) {
      toastFromCaughtError(e, editingClient ? "Failed to update client" : "Failed to add client")
    } finally {
      setIsSubmitting(false)
    }
  }

  const rangeStart = filtered.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1
  const rangeEnd = Math.min(safePage * PAGE_SIZE, filtered.length)

  return (
    <div className="flex flex-col gap-4 md:gap-6 min-w-0">
      <PageHeader
        title="Clients"
        description={isLoading ? "Loading…" : `${clients.length} active clients`}
        actions={
          <Button onClick={openAddClient} className="w-fit shrink-0">
            <Plus className="w-4 h-4 mr-2" />
            Add client
          </Button>
        }
      />

      <Dialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open)
          if (!open) resetFormFields()
        }}
      >
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingClient ? "Edit client" : "Add client"}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="client-form-name">Name</Label>
              <Input
                id="client-form-name"
                placeholder="Contact name"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="client-form-company">Company</Label>
              <Input
                id="client-form-company"
                placeholder="Company name"
                value={formCompany}
                onChange={(e) => setFormCompany(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="client-form-email">Email</Label>
              <Input
                id="client-form-email"
                type="email"
                placeholder="email@example.com"
                value={formEmail}
                onChange={(e) => setFormEmail(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="client-form-phone">Phone</Label>
              <Input
                id="client-form-phone"
                type="tel"
                placeholder="+250 788 123 456"
                value={formPhone}
                onChange={(e) => setFormPhone(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <Label className="flex items-center gap-1.5">
                  <MapPin className="w-3.5 h-3.5 text-muted-foreground" />
                  Sites
                </Label>
                <Button type="button" variant="ghost" size="sm" className="h-8 text-xs" onClick={addFormSiteRow}>
                  <Plus className="w-3.5 h-3.5 mr-1" />
                  Add site
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {editingClient
                  ? "At least one site address is required."
                  : "Add one or more office, branch, or delivery addresses."}
              </p>
              <div className="space-y-2">
                {formSites.map((site, i) => (
                  <div key={i} className="flex gap-2 items-start">
                    <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <Input
                        placeholder="Site name (e.g. HQ, Branch A)"
                        value={site.name ?? ""}
                        onChange={(e) => updateFormSite(i, "name", e.target.value)}
                        className="h-9"
                      />
                      <Input
                        placeholder="Full address"
                        value={site.address}
                        onChange={(e) => updateFormSite(i, "address", e.target.value)}
                        className="h-9"
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => removeFormSiteRow(i)}
                      disabled={formSites.length <= 1}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button onClick={handleSaveClient} disabled={isSubmitting}>
              {isSubmitting
                ? editingClient
                  ? "Saving…"
                  : "Adding…"
                : editingClient
                  ? "Save changes"
                  : "Add client"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {error && (
        <p className="text-sm text-destructive">Failed to load clients. Showing fallback data.</p>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative max-w-md w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search clients..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9 bg-card text-foreground border-border"
          />
        </div>
        <div className="flex rounded-md border border-border overflow-hidden w-fit shrink-0">
          <Button
            variant={view === "list" ? "secondary" : "ghost"}
            size="sm"
            className="rounded-none h-9 px-3 text-foreground"
            onClick={() => setView("list")}
          >
            <LayoutList className="w-4 h-4" />
            <span className="sr-only">List view</span>
          </Button>
          <Button
            variant={view === "tiles" ? "secondary" : "ghost"}
            size="sm"
            className="rounded-none h-9 px-3 text-foreground"
            onClick={() => setView("tiles")}
          >
            <LayoutGrid className="w-4 h-4" />
            <span className="sr-only">Tile view</span>
          </Button>
        </div>
      </div>

      {isLoading ? (
        view === "list" ? (
          <div className="rounded-lg border border-border bg-card p-4 space-y-3 animate-pulse">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-10 bg-muted rounded" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 md:gap-4">
            {[1, 2, 3].map((i) => (
              <Card key={i} className="animate-pulse">
                <CardContent className="pt-6">
                  <div className="h-11 w-11 rounded-full bg-muted" />
                  <div className="mt-4 h-4 bg-muted rounded w-3/4" />
                  <div className="mt-2 h-3 bg-muted rounded w-1/2" />
                </CardContent>
              </Card>
            ))}
          </div>
        )
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          No clients found matching your search.
        </div>
      ) : view === "list" ? (
        <ClientListTable
          clients={pageClients}
          orderCountByClientId={orderCountByClientId}
          onEdit={openEditClient}
        />
      ) : (
        <ClientTiles
          clients={pageClients}
          orderCountByClientId={orderCountByClientId}
          onEdit={openEditClient}
        />
      )}

      {!isLoading && filtered.length > 0 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            Showing {rangeStart}–{rangeEnd} of {filtered.length}
            {search.trim() ? " matching" : ""}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              disabled={safePage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft className="w-4 h-4 mr-1" />
              Previous
            </Button>
            <span className="text-sm text-muted-foreground tabular-nums px-1">
              {safePage} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              disabled={safePage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
              <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function ClientListTable({
  clients,
  orderCountByClientId,
  onEdit,
}: {
  clients: Client[]
  orderCountByClientId: Map<string, number>
  onEdit: (client: Client) => void
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Client</TableHead>
          <TableHead className="hidden md:table-cell">Email</TableHead>
          <TableHead className="hidden lg:table-cell">Phone</TableHead>
          <TableHead className="hidden sm:table-cell text-right">Orders</TableHead>
          <TableHead className="text-right">Spent</TableHead>
          <TableHead className="w-12 text-right">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {clients.map((client) => {
          const orderCount = orderCountByClientId.get(client.id) ?? 0
          return (
            <TableRow key={client.id} className="hover:bg-muted/40">
              <TableCell className="font-medium">
                <Link href={`/clients/${client.id}`} className="flex items-center gap-3 min-w-0">
                  <Avatar className="w-8 h-8 shrink-0">
                    <AvatarFallback className="bg-muted text-foreground text-xs font-semibold">
                      {clientInitials(client.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{client.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{client.company}</p>
                  </div>
                </Link>
              </TableCell>
              <TableCell className="hidden md:table-cell">
                <Link href={`/clients/${client.id}`} className="text-xs text-muted-foreground truncate block max-w-[220px]">
                  {client.email}
                </Link>
              </TableCell>
              <TableCell className="hidden lg:table-cell">
                <Link href={`/clients/${client.id}`} className="text-xs text-muted-foreground">
                  {client.phone || "—"}
                </Link>
              </TableCell>
              <TableCell className="hidden sm:table-cell text-right">
                <Link href={`/clients/${client.id}`} className="text-xs text-muted-foreground tabular-nums">
                  {orderCount}
                </Link>
              </TableCell>
              <TableCell className="text-right">
                <Link href={`/clients/${client.id}`}>
                  <Badge variant="secondary" className="text-[10px] text-secondary-foreground border-transparent">
                    ${(client.totalSpent ?? 0).toLocaleString()}
                  </Badge>
                </Link>
              </TableCell>
              <TableCell className="text-right">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-foreground"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onEdit(client)
                  }}
                  aria-label={`Edit ${client.name}`}
                >
                  <Pencil className="w-4 h-4" />
                </Button>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

function ClientTiles({
  clients,
  orderCountByClientId,
  onEdit,
}: {
  clients: Client[]
  orderCountByClientId: Map<string, number>
  onEdit: (client: Client) => void
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 md:gap-4">
      {clients.map((client) => {
        const orderCount = orderCountByClientId.get(client.id) ?? 0
        return (
          <Card key={client.id} className="hover:shadow-md transition-shadow h-full relative">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute top-3 right-3 z-10 h-8 w-8 text-muted-foreground hover:text-foreground"
              onClick={() => onEdit(client)}
              aria-label={`Edit ${client.name}`}
            >
              <Pencil className="w-4 h-4" />
            </Button>
            <Link href={`/clients/${client.id}`} className="block h-full">
              <CardContent className="pt-6">
                <div className="flex items-start gap-4 pr-8">
                  <Avatar className="w-11 h-11 shrink-0">
                    <AvatarFallback className="bg-muted text-foreground text-sm font-semibold">
                      {clientInitials(client.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-foreground">{client.name}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <Building2 className="w-3 h-3 text-muted-foreground shrink-0" />
                      <p className="text-xs text-muted-foreground truncate">{client.company}</p>
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-2 mt-4 pt-4 border-t border-border">
                  <div className="flex items-center gap-2">
                    <Mail className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span className="text-xs text-muted-foreground truncate">{client.email}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Phone className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span className="text-xs text-muted-foreground">{client.phone}</span>
                  </div>
                  {(client.sites?.length ?? 0) > 1 ? (
                    <div className="flex items-center gap-2">
                      <MapPin className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      <span className="text-xs text-muted-foreground">{client.sites!.length} sites</span>
                    </div>
                  ) : client.address ? (
                    <div className="flex items-center gap-2">
                      <MapPin className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      <span className="text-xs text-muted-foreground truncate">{client.address}</span>
                    </div>
                  ) : null}
                </div>

                <div className="flex items-center justify-between mt-4 pt-4 border-t border-border">
                  <div className="flex items-center gap-1.5">
                    <ShoppingBag className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">
                      {orderCount} order{orderCount !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <Badge variant="secondary" className="text-[10px] text-secondary-foreground border-transparent">
                    ${(client.totalSpent ?? 0).toLocaleString()}
                  </Badge>
                </div>
              </CardContent>
            </Link>
          </Card>
        )
      })}
    </div>
  )
}
