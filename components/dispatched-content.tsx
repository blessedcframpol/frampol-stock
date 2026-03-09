"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Input } from "@/components/ui/input"
import { useInventoryStore } from "@/lib/inventory-store"
import type { InventoryItem, ItemStatus, TransactionType } from "@/lib/data"
import { formatDateDDMMYYYY } from "@/lib/utils"
import { ArrowUpRight, Search } from "lucide-react"
import { cn } from "@/lib/utils"

const OUTBOUND_TYPES: TransactionType[] = ["Sale", "POC Out", "Rentals", "Dispose"]

const statusStyles: Record<ItemStatus, string> = {
  "In Stock": "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  Sold: "bg-red-500/10 text-red-500 dark:text-red-400",
  POC: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  Maintenance: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  Disposed: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
}

const movementTypeStyles: Record<string, string> = {
  Sale: "bg-red-500/10 text-red-500 dark:text-red-400",
  "POC Out": "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  Rentals: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  Dispose: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
}

type DispatchedRow = {
  item: InventoryItem
  movementType: TransactionType | null
  dateOut: string | null
}

function buildDispatchedList(
  inventory: InventoryItem[],
  transactions: { type: string; serialNumber: string; date: string }[]
): DispatchedRow[] {
  const movedOut = inventory.filter(
    (i) => i.status === "Sold" || i.status === "POC" || i.status === "Disposed" || i.status === "Maintenance"
  )
  const outboundBySerial = new Map<string, { type: TransactionType; date: string }>()
  const sortedTxns = [...transactions].filter((t) =>
    OUTBOUND_TYPES.includes(t.type as TransactionType)
  ).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
  for (const t of sortedTxns) {
    if (!outboundBySerial.has(t.serialNumber)) {
      outboundBySerial.set(t.serialNumber, { type: t.type as TransactionType, date: t.date })
    }
  }

  return movedOut.map((item) => {
    const out = outboundBySerial.get(item.serialNumber)
    const dateOut = out?.date ?? (item.pocOutDate ?? item.dateAdded)
    return {
      item,
      movementType: out?.type ?? null,
      dateOut: dateOut ?? null,
    }
  })
}

function matchesSearch(row: DispatchedRow, query: string): boolean {
  if (!query.trim()) return true
  const q = query.trim().toLowerCase()
  const serial = (row.item.serialNumber ?? "").toLowerCase()
  const name = (row.item.name ?? "").toLowerCase()
  const assigned = ((row.item.assignedTo ?? row.item.client) ?? "").toLowerCase()
  const movement = (row.movementType ?? "").toLowerCase()
  const status = (row.item.status ?? "").toLowerCase()
  return (
    serial.includes(q) ||
    name.includes(q) ||
    assigned.includes(q) ||
    movement.includes(q) ||
    status.includes(q)
  )
}

export function DispatchedContent() {
  const { inventory, transactions } = useInventoryStore()
  const [typeFilter, setTypeFilter] = useState<string>("all")
  const [search, setSearch] = useState("")

  const dispatched = useMemo(
    () => buildDispatchedList(inventory, transactions.map((t) => ({ type: t.type, serialNumber: t.serialNumber, date: t.date }))),
    [inventory, transactions]
  )

  const filtered = useMemo(() => {
    let list = dispatched
    if (typeFilter !== "all") {
      list = list.filter((row) => row.movementType === typeFilter)
    }
    if (search.trim()) {
      list = list.filter((row) => matchesSearch(row, search))
    }
    return list
  }, [dispatched, typeFilter, search])

  const sorted = useMemo(
    () => [...filtered].sort((a, b) => {
      const dateA = a.dateOut ? new Date(a.dateOut).getTime() : 0
      const dateB = b.dateOut ? new Date(b.dateOut).getTime() : 0
      return dateB - dateA
    }),
    [filtered]
  )

  return (
    <div className="flex flex-col gap-6 min-w-0">
      <div>
        <h1 className="text-xl md:text-2xl font-bold text-foreground tracking-tight">
          Dispatched
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Items that have been moved out: sales, POC, rentals, and disposed.
        </p>
      </div>

      <Card className="border-border">
        <CardContent className="p-0">
          <div className="p-4 border-b border-border space-y-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search by serial, product, client..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 bg-card text-foreground border-border"
              />
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Filter by movement type</p>
              <Tabs value={typeFilter} onValueChange={setTypeFilter}>
                <TabsList className="flex flex-wrap h-auto gap-1.5 bg-muted/70 rounded-md p-1.5">
                  <TabsTrigger value="all" className="text-sm px-4 py-2 data-[state=active]:bg-background data-[state=active]:shadow-sm">
                    All
                  </TabsTrigger>
                  <TabsTrigger value="Sale" className="text-sm px-4 py-2 data-[state=active]:bg-background data-[state=active]:shadow-sm">Sale</TabsTrigger>
                  <TabsTrigger value="POC Out" className="text-sm px-4 py-2 data-[state=active]:bg-background data-[state=active]:shadow-sm">POC Out</TabsTrigger>
                  <TabsTrigger value="Rentals" className="text-sm px-4 py-2 data-[state=active]:bg-background data-[state=active]:shadow-sm">Rentals</TabsTrigger>
                  <TabsTrigger value="Dispose" className="text-sm px-4 py-2 data-[state=active]:bg-background data-[state=active]:shadow-sm">Dispose</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </div>
          {sorted.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <ArrowUpRight className="w-12 h-12 text-muted-foreground/50 mb-3" />
              <p className="text-sm font-medium text-foreground">No dispatched items</p>
              <p className="text-sm text-muted-foreground mt-1">
                {search.trim()
                  ? "No items match your search. Try a different serial, product name, or client."
                  : typeFilter === "all"
                    ? "Items moved out (sold, POC, rentals, disposed) will appear here."
                    : `No items with movement type "${typeFilter}".`}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="text-xs text-muted-foreground font-medium">Serial</TableHead>
                    <TableHead className="text-xs text-muted-foreground font-medium">Product</TableHead>
                    <TableHead className="text-xs text-muted-foreground font-medium">Status</TableHead>
                    <TableHead className="text-xs text-muted-foreground font-medium">Movement</TableHead>
                    <TableHead className="text-xs text-muted-foreground font-medium">Client / Assigned to</TableHead>
                    <TableHead className="text-xs text-muted-foreground font-medium">Date out</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((row) => (
                    <TableRow key={row.item.id}>
                      <TableCell className="font-mono text-sm text-foreground">
                        <Link
                          href={`/inventory?serial=${encodeURIComponent(row.item.serialNumber)}`}
                          className="text-primary hover:underline"
                        >
                          {row.item.serialNumber}
                        </Link>
                      </TableCell>
                      <TableCell className="text-sm text-foreground">{row.item.name}</TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className={cn("text-[10px] font-medium border-0", statusStyles[row.item.status])}
                        >
                          {row.item.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {row.movementType ? (
                          <Badge
                            variant="secondary"
                            className={cn(
                              "text-[10px] font-medium border-0",
                              movementTypeStyles[row.movementType] ?? "bg-muted text-muted-foreground"
                            )}
                          >
                            {row.movementType}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-[180px] truncate" title={row.item.assignedTo ?? row.item.client ?? ""}>
                        {row.item.assignedTo ?? row.item.client ?? "—"}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {row.dateOut ? formatDateDDMMYYYY(row.dateOut) : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
