"use client"

import Link from "next/link"
import { useParams } from "next/navigation"
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
import { DashboardShell } from "@/components/dashboard-shell"
import { useInventoryStore } from "@/lib/inventory-store"
import { useClients } from "@/lib/supabase/clients-db"
import { cn, formatDateDDMMYYYY } from "@/lib/utils"
import { FileText, ArrowLeft, Mail, Phone, Building2, MapPin } from "lucide-react"

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

export default function ClientDetailPage() {
  const params = useParams()
  const id = typeof params?.id === "string" ? params.id : ""
  const { clients, isLoading: clientsLoading } = useClients()
  const { transactions } = useInventoryStore()

  const client = id ? (clients.find((c) => c.id === id) ?? null) : null
  const clientOrders = client
    ? transactions.filter((txn) => isOrderForClient(txn, client))
    : []

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
                {clientOrders.length} order{clientOrders.length !== 1 ? "s" : ""}
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

        {/* Orders table */}
        <Card className="flex flex-col min-h-[200px]">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold text-foreground">
              Orders
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1 min-h-0 overflow-auto overflow-x-auto">
            {clientOrders.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">
                No orders recorded for this client.
              </p>
            ) : (
              <Table className="min-w-[560px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="text-xs text-muted-foreground font-medium">
                      Date
                    </TableHead>
                    <TableHead className="text-xs text-muted-foreground font-medium">
                      Type
                    </TableHead>
                    <TableHead className="text-xs text-muted-foreground font-medium">
                      Serial Number
                    </TableHead>
                    <TableHead className="text-xs text-muted-foreground font-medium hidden sm:table-cell">
                      Item
                    </TableHead>
                    <TableHead className="text-xs text-muted-foreground font-medium hidden lg:table-cell">
                      Invoice
                    </TableHead>
                    <TableHead className="text-xs text-muted-foreground font-medium hidden xl:table-cell">
                      Delivery note
                    </TableHead>
                    <TableHead className="text-xs text-muted-foreground font-medium hidden md:table-cell">
                      Notes
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {clientOrders.map((txn) => (
                    <TableRow key={txn.id}>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDateDDMMYYYY(txn.date)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className={cn(
                            "text-[10px] font-medium border-0",
                            statusStyles[txn.type]
                          )}
                        >
                          {txn.type}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-foreground">
                        {txn.serialNumber}
                      </TableCell>
                      <TableCell className="text-sm text-foreground hidden sm:table-cell">
                        {txn.itemName}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground hidden lg:table-cell">
                        {txn.invoiceNumber || "—"}
                      </TableCell>
                      <TableCell className="hidden xl:table-cell">
                        {txn.deliveryNoteUrl ? (
                          <a
                            href={txn.deliveryNoteUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                          >
                            <FileText className="w-3.5 h-3.5 shrink-0" />
                            View
                          </a>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground hidden md:table-cell max-w-[200px] truncate">
                        {txn.notes || "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardShell>
  )
}
