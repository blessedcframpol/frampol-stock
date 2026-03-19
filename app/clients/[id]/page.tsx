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
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { DashboardShell } from "@/components/dashboard-shell"
import { useInventoryStore } from "@/lib/inventory-store"
import { useClients } from "@/lib/supabase/clients-db"
import { cn, formatDateDDMMYYYY } from "@/lib/utils"
import { FileText, ArrowLeft, Mail, Phone, Building2, MapPin, Package, ChevronRight } from "lucide-react"
import type { Transaction } from "@/lib/data"

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

function isOrderForClient(
  txn: { clientId?: string; client: string },
  client: { id: string; company: string; name: string }
): boolean {
  if (txn.clientId === client.id) return true
  if (!txn.client) return false
  const c = txn.client.trim()
  return (
    c === client.company ||
    c === client.name ||
    c.includes(client.company) ||
    c === `${client.name} - ${client.company}`
  )
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
  const { clients, isLoading: clientsLoading } = useClients()
  const { transactions } = useInventoryStore()
  const [detailOpen, setDetailOpen] = useState(false)
  const [selectedConsignment, setSelectedConsignment] = useState<ConsignmentRow | null>(null)
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null)

  const client = id ? (clients.find((c) => c.id === id) ?? null) : null
  const clientOrders = client
    ? transactions.filter((txn) => isOrderForClient(txn, client))
    : []

  const rows = useMemo((): ListRow[] => {
    const byBatch = new Map<string | "standalone", Transaction[]>()
    for (const txn of clientOrders) {
      const key = txn.batchId ?? "standalone"
      const list = byBatch.get(key) ?? []
      list.push(txn)
      byBatch.set(key, list)
    }
    const out: ListRow[] = []
    byBatch.forEach((txns, key) => {
      if (key === "standalone") {
        txns.forEach((t) => out.push({ kind: "single", transaction: t }))
      } else {
        const first = txns[0]!
        out.push({
          kind: "consignment",
          batchId: key,
          type: first.type,
          date: first.date,
          invoiceNumber: first.invoiceNumber,
          count: txns.length,
          transactions: txns,
        })
      }
    })
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
            <CardTitle className="text-lg">{client.name}</CardTitle>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground mt-1">
              <span className="flex items-center gap-1.5">
                <Building2 className="w-4 h-4 shrink-0" />
                {client.company}
              </span>
              {client.email && (
                <a
                  href={`mailto:${client.email}`}
                  className="flex items-center gap-1.5 hover:text-foreground"
                >
                  <Mail className="w-4 h-4 shrink-0" />
                  {client.email}
                </a>
              )}
              {client.phone && (
                <span className="flex items-center gap-1.5">
                  <Phone className="w-4 h-4 shrink-0" />
                  {client.phone}
                </span>
              )}
              {client.address && (
                <span className="flex items-start gap-1.5">
                  <MapPin className="w-4 h-4 shrink-0 mt-0.5" />
                  <span className="text-muted-foreground">{client.address}</span>
                </span>
              )}
            </div>
            <div className="flex gap-4 mt-3 text-sm">
              <span className="text-muted-foreground">
                {clientOrders.length} transaction{clientOrders.length !== 1 ? "s" : ""}
                {rows.length > 0 && (
                  <span> in {rows.length} consignment{rows.length !== 1 ? "s" : ""} / order{rows.length !== 1 ? "s" : ""}</span>
                )}
              </span>
              {(client.totalSpent ?? 0) > 0 && (
                <span className="text-muted-foreground">
                  Total spent: ${(client.totalSpent ?? 0).toLocaleString()}
                </span>
              )}
              {client.lastOrder && (
                <span className="text-muted-foreground">
                  Last order: {formatDateDDMMYYYY(client.lastOrder)}
                </span>
              )}
            </div>
          </CardHeader>
        </Card>

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
                    <TableHead className="text-xs text-muted-foreground font-medium hidden lg:table-cell">
                      Invoice
                    </TableHead>
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
                          <TableCell className="font-mono text-xs text-muted-foreground hidden lg:table-cell">
                            {row.invoiceNumber || "—"}
                          </TableCell>
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
                        <TableCell className="font-mono text-xs text-muted-foreground hidden lg:table-cell">
                          {t.invoiceNumber || "—"}
                        </TableCell>
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
        <SheetContent className="flex flex-col w-full sm:max-w-xl overflow-hidden">
          <SheetHeader>
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
          <ScrollArea className="flex-1 -mx-6 px-6">
            {selectedConsignment && (
              <div className="space-y-4 pb-6">
                <div className="flex flex-wrap gap-2 text-sm">
                  <span className="text-muted-foreground">Invoice:</span>
                  <span className="font-mono">{selectedConsignment.invoiceNumber || "—"}</span>
                </div>
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
            )}
            {selectedTransaction && (
              <dl className="space-y-3 text-sm pb-6">
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
                {selectedTransaction.invoiceNumber && (
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
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </DashboardShell>
  )
}
