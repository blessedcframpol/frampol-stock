"use client"

import Link from "next/link"
import { useState } from "react"
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
import { useClients, insertClient } from "@/lib/supabase/clients-db"
import { Search, Mail, Phone, Building2, ShoppingBag, Plus, MapPin } from "lucide-react"
import { toast } from "sonner"

export function ClientsContent() {
  const [search, setSearch] = useState("")
  const { clients, isLoading, error, refetch } = useClients()
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [newName, setNewName] = useState("")
  const [newCompany, setNewCompany] = useState("")
  const [newEmail, setNewEmail] = useState("")
  const [newPhone, setNewPhone] = useState("")
  const [newAddress, setNewAddress] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)

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
    const address = newAddress.trim()
    if (!name || !company || !email || !phone || !address) {
      toast.error("All fields are required: name, company, email, phone, and company address")
      return
    }
    setIsSubmitting(true)
    try {
      await insertClient({ name, company, email, phone, address })
      await refetch()
      setAddModalOpen(false)
      setNewName("")
      setNewCompany("")
      setNewEmail("")
      setNewPhone("")
      setNewAddress("")
      toast.success("Client added")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add client")
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
      <Dialog open={addModalOpen} onOpenChange={setAddModalOpen}>
        <DialogContent className="sm:max-w-md">
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
              <Label htmlFor="new-client-address">Company address</Label>
              <Input
                id="new-client-address"
                placeholder="Street, city, country"
                value={newAddress}
                onChange={(e) => setNewAddress(e.target.value)}
              />
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
        {filtered.map((client) => (
          <Link key={client.id} href={`/clients/${client.id}`}>
            <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
            <CardContent className="pt-6">
              <div className="flex items-start gap-4">
                <Avatar className="w-11 h-11 shrink-0">
                  <AvatarFallback className="bg-primary/10 text-primary text-sm font-semibold">
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
                {client.address && (
                  <div className="flex items-center gap-2">
                    <MapPin className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span className="text-xs text-muted-foreground truncate">{client.address}</span>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between mt-4 pt-4 border-t border-border">
                <div className="flex items-center gap-1.5">
                  <ShoppingBag className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">{client.totalOrders} orders</span>
                </div>
                <Badge variant="secondary" className="text-[10px] bg-primary/10 text-primary border-0">
                  ${(client.totalSpent ?? 0).toLocaleString()}
                </Badge>
              </div>
            </CardContent>
          </Card>
          </Link>
        ))}
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
