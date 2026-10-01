"use client"

import { useParams, useRouter } from "next/navigation"
import { useEffect, useMemo, useState } from "react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { clientCompanyDetail } from "@/lib/client-label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  clientListIdentity,
  displayContact,
  holderMatchesClient,
  holdingsForClient,
  OPEN_REQUEST_STATUSES,
  realSites,
  splitEmails,
  type HeldUnit,
} from "@/lib/clients-directory"
import { fetchHeldUnits } from "@/lib/clients-holdings"
import { formatReturnAge, isOverdue } from "@/lib/alerts"
import { todayBusinessDate } from "@/lib/business-date.mjs"
import { fetchRemediationCases, type RemediationCaseRow } from "@/lib/supabase/remediation-db"
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
import { PageBreadcrumbs } from "@/components/page-breadcrumbs"
import { useAuth } from "@/lib/auth-context"
import { canEditClients, canViewFinancials } from "@/lib/permissions"
import { useClients, updateClient } from "@/lib/supabase/clients-db"
import { getSupabaseClient } from "@/lib/supabase/client"
import { fetchAllPages } from "@/lib/supabase/postgrest-page"
import {
  fetchStockRequestsForClient,
  type StockRequestWithRelations,
} from "@/lib/supabase/stock-requests-db"
import { SignedStorageLink } from "@/components/signed-storage-link"
import { BusinessDateLabel } from "@/components/business-date-label"
import { useOrgTimezone } from "@/hooks/use-org-timezone"
import { compareBusinessDatesDesc, latestRecordedAt } from "@/lib/business-date.mjs"
import { formatDateDDMMYYYY } from "@/lib/utils"
import {
  FileText,
  Mail,
  Phone,
  MapPin,
  ChevronRight,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"
import { isAuthFailure, SESSION_EXPIRED_MESSAGE } from "@/lib/unauthorized"
import { ledgerTextDiffersFromClient } from "@/lib/client-transactions"
import { fetchClientTransactions, type ResolvedClientTransaction } from "@/lib/clients-orders"
import type { ClientSite, Transaction } from "@/lib/data"
import { StatusPill } from "@/components/fs/status-pill"

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
  const timeZone = useOrgTimezone()
  const params = useParams()
  const id = typeof params?.id === "string" ? params.id : ""
  const { role } = useAuth()
  const showFinancials = canViewFinancials(role)
  const canEdit = canEditClients(role)
  const { clients, isLoading: clientsLoading, error: clientsError, refetch: refetchClients } =
    useClients()
  const [ledger, setLedger] = useState<ResolvedClientTransaction[]>([])
  const [ledgerReady, setLedgerReady] = useState(false)
  const [ledgerForId, setLedgerForId] = useState(id)
  if (id !== ledgerForId) {
    setLedgerForId(id)
    setLedger([])
    setLedgerReady(false)
  }
  const [detailOpen, setDetailOpen] = useState(false)
  const [tab, setTab] = useState<string | null>(null)
  const [selectedConsignment, setSelectedConsignment] = useState<ConsignmentRow | null>(null)
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [editName, setEditName] = useState("")
  const [editCompany, setEditCompany] = useState("")
  const [editEmail, setEditEmail] = useState("")
  const [editPhone, setEditPhone] = useState("")
  const [editSites, setEditSites] = useState<ClientSite[]>([{ address: "" }])
  const [isSavingClient, setIsSavingClient] = useState(false)
  const router = useRouter()
  const today = todayBusinessDate(timeZone)
  const [heldUnits, setHeldUnits] = useState<HeldUnit[]>([])
  const [cases, setCases] = useState<RemediationCaseRow[]>([])
  const [caseHolders, setCaseHolders] = useState<Record<string, string>>({})
  const [clientRequests, setClientRequests] = useState<StockRequestWithRelations[]>([])
  const [requestsLoading, setRequestsLoading] = useState(true)
  const [requestsForId, setRequestsForId] = useState(id)
  if (id !== requestsForId) {
    setRequestsForId(id)
    setClientRequests([])
    setRequestsLoading(true)
  }

  const client = id ? (clients.find((c) => c.id === id) ?? null) : null

  useEffect(() => {
    // No client: the "not found" return below is the empty view. This page is
    // not keyed on id; a reused instance resets the list during render above.
    if (!id || !client?.id) return
    let cancelled = false
    ;(async () => {
      try {
        const sb = getSupabaseClient()
        const list = await fetchStockRequestsForClient(sb, id)
        if (!cancelled) setClientRequests(list)
      } catch {
        if (!cancelled) setClientRequests([])
      } finally {
        if (!cancelled) setRequestsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id, client?.id])

  useEffect(() => {
    let cancelled = false
    fetchHeldUnits()
      .then((rows) => {
        if (!cancelled) setHeldUnits(rows)
      })
      .catch(() => {
        if (!cancelled) setHeldUnits([])
      })
    ;(async () => {
      try {
        const sb = getSupabaseClient()
        const rows = await fetchRemediationCases(sb)
        if (cancelled) return
        setCases(rows)
        const ids = [
          ...new Set(
            rows.flatMap((row) =>
              [row.faulty_inventory_item_id, row.loaner_inventory_item_id].filter((id): id is string => Boolean(id)),
            ),
          ),
        ]
        if (ids.length === 0) return
        const data = await fetchAllPages((from, to) =>
          sb.from("inventory_items").select("id, client, assigned_to").in("id", ids).order("id").range(from, to),
        )
        if (cancelled) return
        const holders: Record<string, string> = {}
        for (const item of data) {
          holders[item.id] = (item.assigned_to ?? "").trim() || (item.client ?? "").trim()
        }
        setCaseHolders(holders)
      } catch {
        if (!cancelled) setCases([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!id) return
    let cancelled = false
    fetchClientTransactions(id)
      .then((rows) => {
        if (!cancelled) setLedger(rows)
      })
      .catch(() => {
        if (!cancelled) setLedger([])
      })
      .finally(() => {
        if (!cancelled) setLedgerReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [id])

  const saleStats = useMemo(() => {
    const keys = new Set<string>()
    let units = 0
    let last = ""
    for (const txn of ledger) {
      const day = txn.date.slice(0, 10)
      if (day > last) last = day
      if (txn.type !== "Sale") continue
      units += 1
      keys.add(txn.batchKey)
    }
    return { orders: keys.size, units, last }
  }, [ledger])

  const rows = useMemo((): ListRow[] => {
    const groups = new Map<string, ResolvedClientTransaction[]>()
    for (const txn of ledger) {
      const list = groups.get(txn.batchKey) ?? []
      list.push(txn)
      groups.set(txn.batchKey, list)
    }
    const out: ListRow[] = []
    for (const [batchKey, txns] of groups) {
      if (txns.length === 1) {
        out.push({ kind: "single", transaction: txns[0]! })
      } else {
        const first = txns[0]!
        out.push({
          kind: "consignment",
          batchId: batchKey,
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
      return compareBusinessDatesDesc(dateA, dateB)
    })
    return out
  }, [ledger])

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

  if (clientsError) {
    return (
      <DashboardShell>
        <div className="flex flex-col gap-4 min-w-0">
          <PageBreadcrumbs items={[{ label: "Clients", href: "/clients" }, { label: "Client" }]} />
          <p role="alert" className="text-sm text-destructive">
            {isAuthFailure(clientsError) ? SESSION_EXPIRED_MESSAGE : "Could not load this client."}
          </p>
        </div>
      </DashboardShell>
    )
  }

  if (!id || !client) {
    return (
      <DashboardShell>
        <div className="flex flex-col gap-4 min-w-0">
          <PageBreadcrumbs items={[{ label: "Clients", href: "/clients" }, { label: "Client" }]} />
          <p className="text-sm text-muted-foreground">Client not found.</p>
        </div>
      </DashboardShell>
    )
  }

  const activeClient = client
  const held = holdingsForClient(heldUnits, activeClient)
  const overdueHeld = held.filter((unit) => unit.returnDate && isOverdue(unit.returnDate, today))
  const openRequests = clientRequests.filter((request) => OPEN_REQUEST_STATUSES.has(request.status))
  const lastActivity = ledgerReady ? saleStats.last : ""
  const emails = splitEmails(activeClient.email)
  const phone = displayContact(activeClient.phone)
  const sites = realSites(
    activeClient.sites?.length
      ? activeClient.sites
      : activeClient.address
        ? [{ address: activeClient.address }]
        : [],
  )
  const company = displayContact(clientCompanyDetail(activeClient))
  const identity = clientListIdentity(activeClient)
  const clientCases = cases.filter((row) => {
    const faulty = caseHolders[row.faulty_inventory_item_id]
    const loaner = row.loaner_inventory_item_id ? caseHolders[row.loaner_inventory_item_id] : ""
    return holderMatchesClient(faulty, activeClient) || holderMatchesClient(loaner, activeClient)
  })

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
        <PageBreadcrumbs items={[{ label: "Clients", href: "/clients" }, { label: identity.title }]} />

        {/* Client header */}
        <Card>
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <CardTitle className="text-lg">{identity.title}</CardTitle>
                {identity.fallback ? (
                  <p className="mt-1 font-mono text-xs text-muted-foreground">{activeClient.id}</p>
                ) : company ? (
                  <p className="mt-1 text-sm text-muted-foreground">{company}</p>
                ) : null}
              </div>
              {canEdit ? (
                <Button type="button" variant="outline" size="sm" className="w-fit shrink-0" onClick={openEditClient}>
                  <Pencil className="w-4 h-4 mr-2" />
                  Edit details
                </Button>
              ) : null}
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Items held" value={String(held.length)} />
              <Stat label="Orders" value={ledgerReady ? String(saleStats.orders) : "…"} />
              <Stat label="Units" value={ledgerReady ? String(saleStats.units) : "…"} />
              <Stat label="Overdue returns" value={String(overdueHeld.length)} />
              <Stat label="Open requests" value={String(openRequests.length)} />
              <Stat label="Last activity" value={!ledgerReady ? "…" : lastActivity ? formatDateDDMMYYYY(lastActivity) : "—"} />
            </dl>
          </CardHeader>
        </Card>

        {canEdit ? <Dialog open={editOpen} onOpenChange={setEditOpen}>
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
        </Dialog> : null}

        <div className="grid w-full min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Tabs value={tab ?? (held.length > 0 ? "held" : "transactions")} onValueChange={setTab} className="min-w-0">
          <TabsList className="flex h-auto w-full flex-wrap justify-start">
            <TabsTrigger value="requests">Requests {clientRequests.length}</TabsTrigger>
            <TabsTrigger value="transactions">Transactions {ledgerReady ? rows.length : "…"}</TabsTrigger>
            <TabsTrigger value="held">Items held {held.length}</TabsTrigger>
            <TabsTrigger value="cases">Cases {clientCases.length}</TabsTrigger>
          </TabsList>
          <TabsContent value="requests">
        <Card className="flex flex-col min-h-[120px]">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold text-foreground">Requests</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 min-h-0 overflow-auto overflow-x-auto">
            {requestsLoading ? (
              <p className="text-sm text-muted-foreground py-4">Loading requests…</p>
            ) : clientRequests.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">No stock requests for this client yet.</p>
            ) : (
              <Table className="min-w-[480px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Lines</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="w-24" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {clientRequests.map((r) => (
                    <TableRow
                      key={r.id}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => router.push(`/requests/${r.id}`)}
                    >
                      <TableCell className="text-sm text-muted-foreground">
                        {(r.stock_request_lines ?? []).length} line
                        {(r.stock_request_lines ?? []).length !== 1 ? "s" : ""}
                      </TableCell>
                      <TableCell>
                        <StatusPill value={r.status} />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {formatDateDDMMYYYY(r.created_at)}
                      </TableCell>
                      <TableCell>
                        <ChevronRight className="w-4 h-4 text-muted-foreground" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
          </TabsContent>
          <TabsContent value="transactions">
        <Card className="flex flex-col min-h-[200px]">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold text-foreground">Transactions</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 min-h-0 overflow-auto overflow-x-auto">
            {!ledgerReady ? (
              <p className="text-sm text-muted-foreground py-4">Loading transactions…</p>
            ) : rows.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">No transactions for this client.</p>
            ) : (
              <Table className="min-w-[560px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Date</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Items</TableHead>
                    <TableHead className="hidden sm:table-cell">
                      Serial / Ref
                    </TableHead>
                    {showFinancials && (
                      <TableHead className="hidden lg:table-cell">
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
                            <BusinessDateLabel
                              date={row.date}
                              createdAt={latestRecordedAt(row.transactions.map((txn) => txn.createdAt))}
                              timeZone={timeZone}
                            />
                          </TableCell>
                          <TableCell>
                            <StatusPill value={row.type} />
                            <LedgerMismatch labels={mismatchLabels(row.transactions, activeClient)} />
                          </TableCell>
                          <TableCell className="text-right text-sm font-medium tabular-nums">{row.count} item{row.count !== 1 ? "s" : ""}</TableCell>
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
                          <BusinessDateLabel date={t.date} createdAt={t.createdAt} timeZone={timeZone} />
                        </TableCell>
                        <TableCell>
                          <StatusPill value={t.type} />
                          <LedgerMismatch labels={mismatchLabels([t], activeClient)} />
                        </TableCell>
                        <TableCell className="text-right text-sm tabular-nums">1 item</TableCell>
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
          </TabsContent>
          <TabsContent value="held">
            <HeldTable units={held} today={today} />
          </TabsContent>
          <TabsContent value="cases">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Cases</CardTitle>
              </CardHeader>
              <CardContent>
                {clientCases.length === 0 ? (
                  <p className="py-4 text-sm text-muted-foreground">No remediation cases for this client.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Faulty serial</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Loaner</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {clientCases.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell className="font-mono text-xs">{row.faulty_serial}</TableCell>
                          <TableCell><StatusPill value={row.status} /></TableCell>
                          <TableCell className="font-mono text-xs">{row.loaner_serial ?? "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
        <Card className="w-full lg:sticky lg:top-4 lg:w-[320px]">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Contact</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-sm">
            {emails.length > 0 ? (
              <div className="flex flex-col gap-1">
                {emails.map((email) => (
                  <a key={email} href={`mailto:${email}`} className="inline-flex items-center gap-2 break-words hover:text-foreground text-muted-foreground">
                    <Mail className="size-4 shrink-0" />
                    {email}
                  </a>
                ))}
              </div>
            ) : null}
            {phone ? (
              <a href={`tel:${phone.replace(/\s/g, "")}`} className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground">
                <Phone className="size-4 shrink-0" />
                {phone}
              </a>
            ) : null}
            {sites.length > 0 ? (
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">Sites</p>
                <ul className="space-y-2 text-muted-foreground">
                  {sites.map((site) => (
                    <li key={`${site.name ?? ""}-${site.address}`} className="flex items-start gap-2">
                      <MapPin className="mt-0.5 size-4 shrink-0" />
                      <span className="break-words">
                        {site.name ? <span className="font-medium text-foreground">{site.name}: </span> : null}
                        {site.address}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {emails.length === 0 && !phone && sites.length === 0 ? (
              <p className="text-muted-foreground">No contact details.</p>
            ) : null}
          </CardContent>
        </Card>
        </div>
      </div>

      {/* Detail sheet */}
      <Sheet open={detailOpen} onOpenChange={setDetailOpen}>
        <SheetContent className="flex flex-col w-full min-w-0 sm:max-w-2xl overflow-hidden pl-6 pr-[1.4rem] pt-4 pb-6 sm:pl-7 sm:pr-7">
          <SheetHeader className="p-0 space-y-1.5 pb-4 text-left pr-[1.4rem] sm:pr-7 shrink-0">
            <SheetTitle>
              {selectedConsignment
                ? `Transactions — ${selectedConsignment.type}`
                : selectedTransaction
                  ? `Transaction — ${selectedTransaction.type}`
                  : "Details"}
            </SheetTitle>
            <SheetDescription>
              {selectedConsignment ? (
                <>
                  {`${selectedConsignment.count} item${selectedConsignment.count !== 1 ? "s" : ""} · `}
                  <BusinessDateLabel
                    date={selectedConsignment.date}
                    createdAt={latestRecordedAt(selectedConsignment.transactions.map((txn) => txn.createdAt))}
                    timeZone={timeZone}
                  />
                </>
              ) : selectedTransaction ? (
                <BusinessDateLabel
                  date={selectedTransaction.date}
                  createdAt={selectedTransaction.createdAt}
                  timeZone={timeZone}
                />
              ) : (
                ""
              )}
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
                      <TableHead>Type</TableHead>
                      <TableHead>Serial</TableHead>
                      <TableHead>Item</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {selectedConsignment.transactions.map((txn) => (
                      <TableRow key={txn.id}>
                        <TableCell>
                          <StatusPill value={txn.type} />
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
                    <StatusPill value={selectedTransaction.type} />
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
                  <dd className="mt-0.5">
                    <BusinessDateLabel
                      date={selectedTransaction.date}
                      createdAt={selectedTransaction.createdAt}
                      timeZone={timeZone}
                    />
                  </dd>
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
                      <SignedStorageLink
                        path={selectedTransaction.deliveryNoteUrl}
                        className="inline-flex items-center gap-1 text-brand hover:underline"
                      >
                        <FileText className="w-3.5 h-3.5" />
                        View
                      </SignedStorageLink>
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

function mismatchLabels(
  txns: readonly { client: string }[],
  client: { name?: string | null; company?: string | null },
): string[] {
  const seen: string[] = []
  for (const txn of txns) {
    const text = txn.client.trim()
    if (!text || seen.includes(text)) continue
    if (ledgerTextDiffersFromClient(text, client)) seen.push(text)
  }
  return seen
}

function LedgerMismatch({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null
  return <p className="mt-1 max-w-[16rem] text-xs text-muted-foreground">{labels.join(" · ")}</p>
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium tabular-nums text-foreground">{value}</dd>
    </div>
  )
}

function HeldTable({ units, today }: { units: HeldUnit[]; today: string }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Items held</CardTitle>
      </CardHeader>
      <CardContent>
        {units.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">No POC or rental units are out with this client.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Serial</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Date out</TableHead>
                <TableHead>Return date</TableHead>
                <TableHead>Age</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {units.map((unit) => {
                const overdue = Boolean(unit.returnDate && isOverdue(unit.returnDate, today))
                return (
                  <TableRow key={unit.id}>
                    <TableCell className="font-mono text-xs">{unit.serialNumber}</TableCell>
                    <TableCell className="text-sm">
                      <div className="flex flex-col items-start gap-1">
                        <span>{unit.product}</span>
                        <StatusPill value={unit.kind === "POC" ? "POC" : "Rented"}>{unit.kind}</StatusPill>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {unit.dateOut ? formatDateDDMMYYYY(unit.dateOut) : "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {unit.returnDate ? formatDateDDMMYYYY(unit.returnDate) : "—"}
                    </TableCell>
                    <TableCell>
                      {unit.returnDate ? (
                        <span
                          className={
                            overdue
                              ? "inline-flex items-center rounded-md bg-warning-soft px-2 py-0.5 text-sm font-medium text-warning"
                              : "inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-sm font-medium text-muted-foreground"
                          }
                        >
                          {formatReturnAge(unit.returnDate, today)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
