"use client"

import Link from "next/link"
import { useParams } from "next/navigation"
import { useMemo, useState } from "react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { DashboardShell } from "@/components/dashboard-shell"
import { useAuth } from "@/lib/auth-context"
import { canViewFinancials } from "@/lib/permissions"
import { useInventoryStore } from "@/lib/inventory-store"
import { useClients, updateClient } from "@/lib/supabase/clients-db"
import { cn, formatDateDDMMYYYY } from "@/lib/utils"
import { FileText, ArrowLeft, Mail, Phone, Building2, MapPin, Package, ChevronRight, Pencil, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"
import {
  getTransactionOrderGroupKey,
  groupClientOrderTransactions,
  isTransactionForClient,
} from "@/lib/client-transactions"
import type { ClientSite, Transaction } from "@/lib/data"

const statusStyles: Record<string, string> = {
  Inbound: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  Sale: "bg-red-500/10 text-red-500 dark:text-red-400",
  "POC Out": "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  "POC Return": "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  Rentals: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  "Rental Return": "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  Transfer: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  Dispose: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
}

type ConsignmentRow = {
  kind: "consignment"
  batchId: string
  type: string
  date: string
  invoiceNumber?: string
  count: number
  transactions: Transaction[]
}

type SingleRow = {
  kind: "single"
  transaction: Transaction
}

type ListRow = ConsignmentRow | SingleRow

export default function ClientDetailPage() {
  const params = useParams()
  const id = typeof params?.id === "string" ? params.id : ""
  const { role } = useAuth()
  const showFinancials = canViewFinancials(role)
  const { clients, isLoading: clientsLoading, refetch: refetchClients } = useClients()
  const { transactions } = useInventoryStore()
  const [detailOpen, setDetailOpen] = useState(false)
  const [selectedConsignment, setSelectedConsignment] = useState<ConsignmentRow | null>(null)
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [editName, setEditName] = useState("")
  const [editCompany, setEditCompany] = useState("")
  const [editEmail, setEditEmail] = useState("")
  const [editPhone, setEditPhone] = useState("")
  const [editSites, setEditSites] = useState<ClientSite[]>([{ address: "" }])
  const [isSavingClient, setIsSavingClient] = useState(false)

  const client = id ? (clients.find((c) => c.id === id) ?? null) : null
  const clientOrders = client
    ? transactions.filter((txn) => isTransactionForClient(txn, client))
    : []

  const rows = useMemo((): ListRow[] => {
    const groups = groupClientOrderTransactions(clientOrders)
    const out: ListRow[] = []
    for (const txns of groups) {
      if (txns.length === 1) {
        out.push({ kind: "single", transaction: txns[0]! })
      } else {
        const first = txns[0]!
        out.push({
          kind: "consignment",
          batchId: getTransactionOrderGroupKey(first),
          type: first.type,
          date: first.date,
          invoiceNumber: first.invoiceNumber,
          count: txns.length,
          transactions: txns,
        })
      }
    }
    out.sort((a, b) => {
      const dateA = a.kind === "consignment" ? a.date : a.transaction.date
      const dateB = b.kind === "consignment" ? b.date : b.transaction.date
      return new Date(dateB).getTime() - new Date(dateA).getTime()
    })
    return out
  }, [clientOrders])

  const openConsignment = (row: ConsignmentRow) => {
    setSelectedConsignment(row)
    setSelectedTransaction(null)
    setDetailOpen(true)
  }

  const openTransaction = (txn: Transaction) => {
    setSelectedTransaction(txn)
    setSelectedConsignment(null)
    setDetailOpen(true)
  }

  if (clientsLoading) {
    return (
      <DashboardShell>
        <div className="flex flex-col gap-4 min-w-0">
          <p className="text-sm text-muted-foreground">Loading client...</p>
        </div>
      </DashboardShell>
    )
  }

  if (!id || !client) {
    return (
      <DashboardShell>
        <div className="flex flex-col gap-4 min-w-0">
          <p className="text-sm text-muted-foreground">Client not found.</p>
          <Button variant="outline" asChild>
            <Link href="/clients">Back to Clients</Link>
          </Button>
        </div>
      </DashboardShell>
    )
  }

  const activeClient = client

  function openEditClient() {
    setEditName(activeClient.name)
    setEditCompany(activeClient.company)
    setEditEmail(activeClient.email)
    setEditPhone(activeClient.phone ?? "")
    setEditSites(
      activeClient.sites?.length
        ? activeClient.sites.map((s) => ({ name: s.name ?? "", address: s.address }))
        : activeClient.address
          ? [{ name: "", address: activeClient.address }]
          : [{ name: "", address: "" }]
    )
    setEditOpen(true)
  }

  function addEditSiteRow() {
    setEditSites((prev) => [...prev, { name: "", address: "" }])
  }

  function removeEditSiteRow(index: number) {
    setEditSites((prev) => prev.filter((_, i) => i !== index))
  }

  function updateEditSite(index: number, field: "name" | "address", value: string) {
    setEditSites((prev) => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)))
  }

  async function handleSaveClientDetails() {
    const name = editName.trim()
    const company = editCompany.trim()
    const email = editEmail.trim()
    const phone = editPhone.trim()
    const validSites = editSites
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
    setIsSavingClient(true)
    try {
      await updateClient(activeClient.id, { name, company, email, phone, sites: validSites })
      await refetchClients()
      setEditOpen(false)
      toast.success("Client updated")
    } catch (e) {
      toastFromCaughtError(e, "Failed to update client")
    } finally {
      setIsSavingClient(false)
    }
  }

  return (
    <DashboardShell>
      <div className="flex flex-col gap-6 min-w-0">
        <Button variant="ghost" size="sm" className="w-fit -ml-2" asChild>
          <Link href="/clients" className="flex items-center gap-1.5">
            <ArrowLeft className="w-4 h-4" />
            Back to Clients
          </Link>
        </Button>

        {/* Client header */}
        <Card>
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <CardTitle className="text-lg">{activeClient.name}</CardTitle>
              <Button type="button" variant="outline" size="sm" className="w-fit shrink-0" onClick={openEditClient}>
                <Pencil className="w-4 h-4 mr-2" />
                Edit details
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground mt-1">
              <span className="flex items-center gap-1.5">
                <Building2 className="w-4 h-4 shrink-0" />
                {activeClient.company}
              </span>
              {activeClient.email && (
                <a
                  href={`mailto:${activeClient.email}`}
                  className="flex items-center gap-1.5 hover:text-foreground"
                >
                  <Mail className="w-4 h-4 shrink-0" />
                  {activeClient.email}
                </a>
              )}
              {activeClient.phone && (
                <span className="flex items-center gap-1.5">
                  <Phone className="w-4 h-4 shrink-0" />
                  {activeClient.phone}
                </span>
              )}
            </div>
            {(activeClient.sites?.length ?? 0) > 0 ? (
              <div className="mt-3 space-y-2 w-full min-w-0">
                <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                  <MapPin className="w-3.5 h-3.5" />
                  Sites
                </p>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  {activeClient.sites!.map((s, i) => (
                    <li key={i} className="flex items-start gap-2 min-w-0">
                      <MapPin className="w-4 h-4 shrink-0 mt-0.5" />
                      <span className="min-w-0 break-words">
                        {s.name ? <span className="text-foreground font-medium">{s.name}: </span> : null}
                        {s.address}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : activeClient.address ? (
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground mt-3">
                <span className="flex items-start gap-1.5">
                  <MapPin className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{activeClient.address}</span>
                </span>
              </div>
            ) : null}
            <div className="flex gap-4 mt-3 text-sm">
              <span className="text-muted-foreground">
                {clientOrders.length} transaction{clientOrders.length !== 1 ? "s" : ""}
                {rows.length > 0 && (
                  <span> in {rows.length} consignment{rows.length !== 1 ? "s" : ""} / order{rows.length !== 1 ? "s" : ""}</span>
                )}
              </span>
              {(activeClient.totalSpent ?? 0) > 0 && (
                <span className="text-muted-foreground">
                  Total spent: ${(activeClient.totalSpent ?? 0).toLocaleString()}
                </span>
              )}
              {activeClient.lastOrder && (
                <span className="text-muted-foreground">
                  Last order: {formatDateDDMMYYYY(activeClient.lastOrder)}
                </span>
              )}
            </div>
          </CardHeader>
        </Card>

        <Dialog open={editOpen} onOpenChange={setEditOpen}>
          <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Edit client</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-4 py-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="edit-client-name">Name</Label>
                <Input
                  id="edit-client-name"
                  placeholder="Contact name"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="edit-client-company">Company</Label>
                <Input
                  id="edit-client-company"
                  placeholder="Company name"
                  value={editCompany}
                  onChange={(e) => setEditCompany(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="edit-client-email">Email</Label>
                <Input
                  id="edit-client-email"
                  type="email"
                  placeholder="email@example.com"
                  value={editEmail}
                  onChange={(e) => setEditEmail(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="edit-client-phone">Phone</Label>
                <Input
                  id="edit-client-phone"
                  type="tel"
                  placeholder="+250 788 123 456"
                  value={editPhone}
                  onChange={(e) => setEditPhone(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <Label className="flex items-center gap-1.5">
                    <MapPin className="w-3.5 h-3.5 text-muted-foreground" />
                    Sites
                  </Label>
                  <Button type="button" variant="ghost" size="sm" className="h-8 text-xs" onClick={addEditSiteRow}>
                    <Plus className="w-3.5 h-3.5 mr-1" />
                    Add site
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">At least one site address is required.</p>
                <div className="space-y-2">
                  {editSites.map((site, i) => (
                    <div key={i} className="flex gap-2 items-start">
                      <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <Input
                          placeholder="Site name (e.g. HQ, Branch A)"
                          value={site.name ?? ""}
                          onChange={(e) => updateEditSite(i, "name", e.target.value)}
                          className="h-9"
                        />
                        <Input
                          placeholder="Full address"
                          value={site.address}
                          onChange={(e) => updateEditSite(i, "address", e.target.value)}
                          className="h-9"
                        />
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() => removeEditSiteRow(i)}
                        disabled={editSites.length <= 1}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditOpen(false)} disabled={isSavingClient}>
                Cancel
              </Button>
              <Button onClick={handleSaveClientDetails} disabled={isSavingClient}>
                {isSavingClient ? "Saving…" : "Save changes"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Transactions & consignments */}
        <Card className="flex flex-col min-h-[200px]">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold text-foreground flex items-center gap-2">
              <Package className="w-4 h-4" />
              Transactions & consignments
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Click a row to see the items moved and movement type.
            </p>
          </CardHeader>
          <CardContent className="flex-1 min-h-0 overflow-auto overflow-x-auto">
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">
                No transactions or consignments recorded for this client.
              </p>
            ) : (
              <Table className="min-w-[560px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="text-xs text-muted-foreground font-medium">Date</TableHead>
                    <TableHead className="text-xs text-muted-foreground font-medium">Type</TableHead>
                    <TableHead className="text-xs text-muted-foreground font-medium">Items</TableHead>
                    <TableHead className="text-xs text-muted-foreground font-medium hidden sm:table-cell">
                      Serial / Ref
                    </TableHead>
                    {showFinancials && (
                      <TableHead className="text-xs text-muted-foreground font-medium hidden lg:table-cell">
                        Invoice
                      </TableHead>
                    )}
                    <TableHead className="w-8" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    if (row.kind === "consignment") {
                      return (
                        <TableRow
                          key={row.batchId}
                          className="cursor-pointer hover:bg-muted/50"
                          onClick={() => openConsignment(row)}
                        >
                          <TableCell className="text-sm text-muted-foreground">
                            {formatDateDDMMYYYY(row.date)}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="secondary"
                              className={cn("text-[10px] font-medium border-0", statusStyles[row.type])}
                            >
                              {row.type}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm font-medium">{row.count} item{row.count !== 1 ? "s" : ""}</TableCell>
                          <TableCell className="text-sm text-muted-foreground hidden sm:table-cell">—</TableCell>
                          {showFinancials && (
                            <TableCell className="font-mono text-xs text-muted-foreground hidden lg:table-cell">
                              {row.invoiceNumber || "—"}
                            </TableCell>
                          )}
                          <TableCell>
                            <ChevronRight className="w-4 h-4 text-muted-foreground" />
                          </TableCell>
                        </TableRow>
                      )
                    }
                    const t = row.transaction
                    return (
                      <TableRow
                        key={t.id}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => openTransaction(t)}
                      >
                        <TableCell className="text-sm text-muted-foreground">
                          {formatDateDDMMYYYY(t.date)}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="secondary"
                            className={cn("text-[10px] font-medium border-0", statusStyles[t.type])}
                          >
                            {t.type}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm">1 item</TableCell>
                        <TableCell className="font-mono text-xs text-foreground hidden sm:table-cell">
                          {t.serialNumber}
                        </TableCell>
                        {showFinancials && (
                          <TableCell className="font-mono text-xs text-muted-foreground hidden lg:table-cell">
                            {t.invoiceNumber || "—"}
                          </TableCell>
                        )}
                        <TableCell>
                          <ChevronRight className="w-4 h-4 text-muted-foreground" />
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Detail sheet */}
      <Sheet open={detailOpen} onOpenChange={setDetailOpen}>
        <SheetContent className="flex flex-col w-full min-w-0 sm:max-w-2xl overflow-hidden pl-6 pr-[1.4rem] pt-4 pb-6 sm:pl-7 sm:pr-7">
          <SheetHeader className="p-0 space-y-1.5 pb-4 text-left pr-[1.4rem] sm:pr-7 shrink-0">
            <SheetTitle>
              {selectedConsignment
                ? `Consignment — ${selectedConsignment.type}`
                : selectedTransaction
                  ? `Transaction — ${selectedTransaction.type}`
                  : "Details"}
            </SheetTitle>
            <SheetDescription>
              {selectedConsignment
                ? `${selectedConsignment.count} item${selectedConsignment.count !== 1 ? "s" : ""} · ${formatDateDDMMYYYY(selectedConsignment.date)}`
                : selectedTransaction
                  ? formatDateDDMMYYYY(selectedTransaction.date)
                  : ""}
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-auto overscroll-y-contain [scrollbar-gutter:stable]">
            {selectedConsignment && (
              <div className="space-y-4 pb-6 pl-2 sm:pl-3 pr-px max-w-full">
                {showFinancials && (
                  <div className="flex flex-wrap gap-2 text-sm">
                    <span className="text-muted-foreground">Invoice:</span>
                    <span className="font-mono">{selectedConsignment.invoiceNumber || "—"}</span>
                  </div>
                )}
                <div className="min-w-0 w-full max-w-full">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="text-xs">Type</TableHead>
                      <TableHead className="text-xs">Serial</TableHead>
                      <TableHead className="text-xs">Item</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {selectedConsignment.transactions.map((txn) => (
                      <TableRow key={txn.id}>
                        <TableCell>
                          <Badge variant="secondary" className={cn("text-[10px]", statusStyles[txn.type])}>
                            {txn.type}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{txn.serialNumber}</TableCell>
                        <TableCell className="text-sm">{txn.itemName}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                </div>
              </div>
            )}
            {selectedTransaction && (
              <dl className="space-y-3 text-sm pb-6 pl-2 sm:pl-3">
                <div>
                  <dt className="text-muted-foreground text-xs font-medium">Movement type</dt>
                  <dd className="mt-0.5">
                    <Badge variant="secondary" className={cn(statusStyles[selectedTransaction.type])}>
                      {selectedTransaction.type}
                    </Badge>
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs font-medium">Serial number</dt>
                  <dd className="font-mono mt-0.5">{selectedTransaction.serialNumber}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs font-medium">Item</dt>
                  <dd className="mt-0.5">{selectedTransaction.itemName}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs font-medium">Date</dt>
                  <dd className="mt-0.5">{formatDateDDMMYYYY(selectedTransaction.date)}</dd>
                </div>
                {showFinancials && selectedTransaction.invoiceNumber && (
                  <div>
                    <dt className="text-muted-foreground text-xs font-medium">Invoice</dt>
                    <dd className="font-mono mt-0.5">{selectedTransaction.invoiceNumber}</dd>
                  </div>
                )}
                {selectedTransaction.fromLocation != null && (
                  <div>
                    <dt className="text-muted-foreground text-xs font-medium">From</dt>
                    <dd className="mt-0.5">{selectedTransaction.fromLocation}</dd>
                  </div>
                )}
                {selectedTransaction.toLocation != null && (
                  <div>
                    <dt className="text-muted-foreground text-xs font-medium">To</dt>
                    <dd className="mt-0.5">{selectedTransaction.toLocation}</dd>
                  </div>
                )}
                {selectedTransaction.deliveryNoteUrl && (
                  <div>
                    <dt className="text-muted-foreground text-xs font-medium">Delivery note</dt>
                    <dd className="mt-0.5">
                      <a
                        href={selectedTransaction.deliveryNoteUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        <FileText className="w-3.5 h-3.5" />
                        View
                      </a>
                    </dd>
                  </div>
                )}
                {selectedTransaction.notes && (
                  <div>
                    <dt className="text-muted-foreground text-xs font-medium">Notes</dt>
                    <dd className="mt-0.5 text-muted-foreground">{selectedTransaction.notes}</dd>
                  </div>
                )}
              </dl>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </DashboardShell>
  )
}
