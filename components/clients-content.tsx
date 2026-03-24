"use client"

import Link from "next/link"
import { useMemo, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
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
import { useClients, insertClient } from "@/lib/supabase/clients-db"
import type { ClientSite } from "@/lib/data"
import { Search, Mail, Phone, Building2, ShoppingBag, Plus, MapPin, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"

export function ClientsContent() {
  const [search, setSearch] = useState("")
  const { clients, isLoading, error, refetch } = useClients()
  const { transactions } = useInventoryStore()

  /** One per batch (multi-item shipment) or per unbatched movement — not per serial line. */
  const orderCountByClientId = useMemo(() => {
    const map = new Map<string, number>()
    for (const c of clients) {
      map.set(c.id, countOrderGroupsForClient(transactions, c))
    }
    return map
  }, [clients, transactions])
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [newName, setNewName] = useState("")
  const [newCompany, setNewCompany] = useState("")
  const [newEmail, setNewEmail] = useState("")
  const [newPhone, setNewPhone] = useState("")
  const [newSites, setNewSites] = useState<ClientSite[]>([{ address: "" }])
  const [isSubmitting, setIsSubmitting] = useState(false)

  function addNewSiteRow() {
    setNewSites((prev) => [...prev, { address: "" }])
  }

  function removeNewSiteRow(index: number) {
    setNewSites((prev) => prev.filter((_, i) => i !== index))
  }

  function updateNewSite(index: number, field: "name" | "address", value: string) {
    setNewSites((prev) => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)))
  }

  const filtered = clients.filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.company.toLowerCase().includes(search.toLowerCase())
  )

  async function handleAddClient() {
    const name = newName.trim()
    const company = newCompany.trim()
    const email = newEmail.trim()
    const phone = newPhone.trim()
    const validSites = newSites
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
      await insertClient({ name, company, email, phone, sites: validSites })
      await refetch()
      setAddModalOpen(false)
      setNewName("")
      setNewCompany("")
      setNewEmail("")
      setNewPhone("")
      setNewSites([{ address: "" }])
      toast.success("Client added")
    } catch (e) {
      toastFromCaughtError(e, "Failed to add client")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 md:gap-6 min-w-0">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-foreground tracking-tight text-balance">Clients</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {isLoading ? "Loading..." : `${clients.length} active clients`}
          </p>
        </div>
        <Button onClick={() => setAddModalOpen(true)} className="w-fit shrink-0">
          <Plus className="w-4 h-4 mr-2" />
          Add client
        </Button>
      </div>

      {/* Add client modal */}
      <Dialog
        open={addModalOpen}
        onOpenChange={(open) => {
          setAddModalOpen(open)
          if (!open) setNewSites([{ address: "" }])
        }}
      >
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add client</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="new-client-name">Name</Label>
              <Input
                id="new-client-name"
                placeholder="Contact name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="new-client-company">Company</Label>
              <Input
                id="new-client-company"
                placeholder="Company name"
                value={newCompany}
                onChange={(e) => setNewCompany(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="new-client-email">Email</Label>
              <Input
                id="new-client-email"
                type="email"
                placeholder="email@example.com"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="new-client-phone">Phone</Label>
              <Input
                id="new-client-phone"
                type="tel"
                placeholder="+250 788 123 456"
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <Label className="flex items-center gap-1.5">
                  <MapPin className="w-3.5 h-3.5 text-muted-foreground" />
                  Sites
                </Label>
                <Button type="button" variant="ghost" size="sm" className="h-8 text-xs" onClick={addNewSiteRow}>
                  <Plus className="w-3.5 h-3.5 mr-1" />
                  Add site
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">Add one or more office, branch, or delivery addresses.</p>
              <div className="space-y-2">
                {newSites.map((site, i) => (
                  <div key={i} className="flex gap-2 items-start">
                    <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <Input
                        placeholder="Site name (e.g. HQ, Branch A)"
                        value={site.name ?? ""}
                        onChange={(e) => updateNewSite(i, "name", e.target.value)}
                        className="h-9"
                      />
                      <Input
                        placeholder="Full address"
                        value={site.address}
                        onChange={(e) => updateNewSite(i, "address", e.target.value)}
                        className="h-9"
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => removeNewSiteRow(i)}
                      disabled={newSites.length <= 1}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddModalOpen(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button onClick={handleAddClient} disabled={isSubmitting}>
              {isSubmitting ? "Adding…" : "Add client"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {error && (
        <p className="text-sm text-destructive">
          Failed to load clients. Showing fallback data.
        </p>
      )}

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Search clients..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9 h-9 bg-card text-foreground border-border"
        />
      </div>

      {/* Client Grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 md:gap-4">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="pt-6">
                <div className="h-11 w-11 rounded-full bg-muted" />
                <div className="mt-4 h-4 bg-muted rounded w-3/4" />
                <div className="mt-2 h-3 bg-muted rounded w-1/2" />
                <div className="mt-4 pt-4 border-t border-border space-y-2">
                  <div className="h-3 bg-muted rounded w-full" />
                  <div className="h-3 bg-muted rounded w-2/3" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 md:gap-4">
        {filtered.map((client) => {
          const orderCount = orderCountByClientId.get(client.id) ?? 0
          return (
          <Link key={client.id} href={`/clients/${client.id}`}>
            <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
            <CardContent className="pt-6">
              <div className="flex items-start gap-4">
                <Avatar className="w-11 h-11 shrink-0">
                  <AvatarFallback className="bg-muted text-foreground text-sm font-semibold">
                    {client.name.split(" ").map((n) => n[0]).join("")}
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
          </Card>
          </Link>
          )
        })}
      </div>
      )}

      {!isLoading && filtered.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No clients found matching your search.
        </div>
      )}
    </div>
  )
}
