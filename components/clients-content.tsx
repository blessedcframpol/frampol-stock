"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/fs/empty-state"
import { FilterChip } from "@/components/fs/filter-chip"
import { ListToolbar, ListToolbarSearch } from "@/components/fs/list-toolbar"
import { Pagination } from "@/components/fs/pagination"
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
import { useClients, insertClient, updateClient } from "@/lib/supabase/clients-db"
import { fetchHeldUnits } from "@/lib/clients-holdings"
import {
  compareDispatchCount,
  dispatchCell,
  fetchClientLastActivity,
  fetchClientSaleDispatchCounts,
  type ClientDispatchCount,
} from "@/lib/clients-orders"
import {
  clientChipCounts,
  clientHasNoContact,
  clientListIdentity,
  compareClientsByName,
  displayContact,
  splitEmails,
  holdingStats,
  type ClientListChip,
  type ClientSort,
  type HeldUnit,
} from "@/lib/clients-directory"
import { clientCompanyDetail } from "@/lib/client-label"
import { todayBusinessDate } from "@/lib/business-date.mjs"
import { useOrgTimezone } from "@/hooks/use-org-timezone"
import { formatDateDDMMYYYY } from "@/lib/utils"
import type { Client, ClientSite } from "@/lib/data"
import {
  MoreHorizontal,
  Plus,
  MapPin,
  Trash2,
} from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "sonner"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"
import { PageHeader } from "@/components/page-nav"
import { useAuth } from "@/lib/auth-context"
import { canEditClients } from "@/lib/permissions"

const PAGE_SIZE = 24

const CHIPS: { id: ClientListChip; label: string }[] = [
  { id: "all", label: "All" },
  { id: "out", label: "Has items out" },
  { id: "overdue", label: "Overdue returns" },
  { id: "noContact", label: "No contact details" },
]

function clientInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  return parts
    .slice(0, 2)
    .map((n) => n[0]!.toUpperCase())
    .join("")
}

export function ClientsContent() {
  const router = useRouter()
  const timeZone = useOrgTimezone()
  const today = todayBusinessDate(timeZone)
  const { role } = useAuth()
  const canEdit = canEditClients(role)
  const [search, setSearch] = useState("")
  const [chip, setChip] = useState<ClientListChip>("all")
  const [sort, setSort] = useState<ClientSort>("activity")
  const [page, setPage] = useState(1)
  const [pageKey, setPageKey] = useState("")
  const listKey = `${search}\0${chip}\0${sort}`
  if (listKey !== pageKey) {
    setPageKey(listKey)
    setPage(1)
  }
  const { clients, isLoading, error, refetch } = useClients()
  const [holdings, setHoldings] = useState<HeldUnit[]>([])
  const [holdingsReady, setHoldingsReady] = useState(false)
  const [dispatchCounts, setDispatchCounts] = useState<Map<string, ClientDispatchCount>>(new Map())
  const [dispatchReady, setDispatchReady] = useState(false)
  const [dispatchError, setDispatchError] = useState(false)
  const [activity, setActivity] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    let cancelled = false
    fetchHeldUnits()
      .then((rows) => {
        if (!cancelled) setHoldings(rows)
      })
      .catch(() => {
        if (!cancelled) setHoldings([])
      })
      .finally(() => {
        if (!cancelled) setHoldingsReady(true)
      })
    fetchClientLastActivity()
      .then((rows) => {
        if (!cancelled) setActivity(rows)
      })
      .catch(() => {
        if (!cancelled) setActivity(new Map())
      })
    fetchClientSaleDispatchCounts()
      .then((rows) => {
        if (!cancelled) setDispatchCounts(rows)
      })
      .catch(() => {
        if (!cancelled) {
          setDispatchCounts(new Map())
          setDispatchError(true)
        }
      })
      .finally(() => {
        if (!cancelled) setDispatchReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

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

  const stats = useMemo(() => holdingStats(clients, holdings, today), [clients, holdings, today])
  const counts = useMemo(() => clientChipCounts(clients, holdings, today), [clients, holdings, today])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = clients.filter((client) => {
      if (chip === "noContact" && !clientHasNoContact(client)) return false
      if (chip === "out" && (stats.get(client.id)?.out ?? 0) === 0) return false
      if (chip === "overdue" && (stats.get(client.id)?.overdue ?? 0) === 0) return false
      if (!q) return true
      const identity = clientListIdentity(client)
      return [identity.title, client.id, client.name, client.company, client.email, client.phone ?? ""]
        .join("\n")
        .toLowerCase()
        .includes(q)
    })
    return [...list].sort((a, b) => {
      if (sort === "out") {
        const diff = (stats.get(b.id)?.out ?? 0) - (stats.get(a.id)?.out ?? 0)
        if (diff !== 0) return diff
      }
      if (sort === "orders" || sort === "units") {
        const diff = compareDispatchCount(dispatchCounts.get(a.id), dispatchCounts.get(b.id), sort)
        if (diff !== 0) return diff
      }
      if (sort === "activity") {
        const left = activity.get(a.id) ?? ""
        const right = activity.get(b.id) ?? ""
        if (left !== right) return right.localeCompare(left)
      }
      return compareClientsByName(a, b)
    })
  }, [activity, chip, clients, dispatchCounts, search, sort, stats])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)

  const pageClients = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE
    return filtered.slice(start, start + PAGE_SIZE)
  }, [filtered, safePage])

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
        description={isLoading ? "Loading…" : `${clients.length} clients`}
        actions={
          canEdit ? (
            <Button onClick={openAddClient} className="w-fit shrink-0">
              <Plus className="w-4 h-4 mr-2" />
              Add client
            </Button>
          ) : null
        }
      />

      {canEdit ? <Dialog
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
      </Dialog> : null}

      {error && (
        <p className="text-sm text-destructive">Failed to load clients.</p>
      )}

      <ListToolbar
        search={
          <ListToolbarSearch
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search clients"
            aria-label="Search clients"
          />
        }
        count={isLoading ? "Loading…" : `${filtered.length}`}
        secondary={
          <Select value={sort} onValueChange={(value) => setSort(value as ClientSort)}>
            <SelectTrigger className="h-10 w-[180px]" aria-label="Sort clients">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name">Name</SelectItem>
              <SelectItem value="activity">Last activity</SelectItem>
              <SelectItem value="orders">Orders</SelectItem>
              <SelectItem value="units">Units</SelectItem>
              <SelectItem value="out">Items out</SelectItem>
            </SelectContent>
          </Select>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        {CHIPS.map((item) => (
          <FilterChip
            key={item.id}
            label={item.label}
            count={
              isLoading || ((item.id === "out" || item.id === "overdue") && !holdingsReady)
                ? undefined
                : counts[item.id]
            }
            selected={chip === item.id}
            onSelect={() => setChip(item.id)}
          />
        ))}
      </div>

      {isLoading ? (
        <div className="rounded-lg border border-border bg-card p-4 space-y-3 animate-pulse">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-10 bg-muted rounded" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState message="No clients found matching your search." />
      ) : (
        <ClientListTable
          clients={pageClients}
          stats={stats}
          activity={activity}
          dispatchCounts={dispatchCounts}
          dispatchReady={dispatchReady}
          dispatchError={dispatchError}
          onEdit={openEditClient}
          onOpen={(client) => router.push(`/clients/${client.id}`)}
          canEdit={canEdit}
        />
      )}

      {!isLoading && filtered.length > 0 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            Showing {rangeStart}–{rangeEnd} of {filtered.length}
            {search.trim() ? " matching" : ""}
          </p>
          <Pagination page={safePage} pageCount={totalPages} onPageChange={setPage} />
        </div>
      )}
    </div>
  )
}

function ClientListTable({
  clients,
  stats,
  activity,
  dispatchCounts,
  dispatchReady,
  dispatchError,
  onEdit,
  onOpen,
  canEdit,
}: {
  clients: Client[]
  stats: Map<string, { out: number; overdue: number }>
  activity: Map<string, string>
  dispatchCounts: Map<string, ClientDispatchCount>
  dispatchReady: boolean
  dispatchError: boolean
  onEdit: (client: Client) => void
  onOpen: (client: Client) => void
  canEdit: boolean
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Client</TableHead>
          <TableHead className="hidden md:table-cell">Email</TableHead>
          <TableHead className="hidden xl:table-cell">Phone</TableHead>
          <TableHead className="hidden sm:table-cell text-right">Orders</TableHead>
          <TableHead className="hidden sm:table-cell text-right">Units</TableHead>
          <TableHead className="hidden lg:table-cell text-right">Items out</TableHead>
          <TableHead className="hidden md:table-cell">Last activity</TableHead>
          {canEdit ? (
            <TableHead className="w-12 text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          ) : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {clients.map((client) => {
          const identity = clientListIdentity(client)
          const company = identity.fallback ? null : displayContact(clientCompanyDetail(client))
          const emails = splitEmails(client.email)
          const phone = displayContact(client.phone)
          const last = activity.get(client.id)
          return (
            <TableRow
              key={client.id}
              className="cursor-pointer hover:bg-muted/40"
              onClick={() => onOpen(client)}
            >
              <TableCell className="font-medium">
                <div className="flex items-center gap-3 min-w-0">
                  <Avatar className="w-8 h-8 shrink-0">
                    <AvatarFallback className="bg-muted text-foreground text-xs font-semibold">
                      {clientInitials(identity.title)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{identity.title}</p>
                    {identity.fallback ? (
                      <p className="truncate font-mono text-xs text-muted-foreground">{client.id}</p>
                    ) : company ? (
                      <p className="text-xs text-muted-foreground truncate">{company}</p>
                    ) : null}
                  </div>
                </div>
              </TableCell>
              <TableCell className="hidden md:table-cell text-xs text-muted-foreground truncate max-w-[220px]">
                {emails.length > 0 ? emails.join("; ") : "—"}
              </TableCell>
              <TableCell className="hidden xl:table-cell text-xs text-muted-foreground">{phone ?? "—"}</TableCell>
              <TableCell className="hidden sm:table-cell text-right text-xs tabular-nums text-muted-foreground">
                {dispatchCell(dispatchCounts.get(client.id), "orders", dispatchReady, dispatchError)}
              </TableCell>
              <TableCell className="hidden sm:table-cell text-right text-xs tabular-nums text-muted-foreground">
                {dispatchCell(dispatchCounts.get(client.id), "units", dispatchReady, dispatchError)}
              </TableCell>
              <TableCell className="hidden lg:table-cell text-right text-xs tabular-nums text-muted-foreground">
                {stats.get(client.id)?.out ?? 0}
              </TableCell>
              <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                {last ? formatDateDDMMYYYY(last) : "—"}
              </TableCell>
              {canEdit ? (
                <TableCell className="text-right" onClick={(event) => event.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-foreground"
                        aria-label={`Actions for ${identity.title}`}
                      >
                        <MoreHorizontal className="w-4 h-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => onEdit(client)}>Edit</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              ) : null}
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
