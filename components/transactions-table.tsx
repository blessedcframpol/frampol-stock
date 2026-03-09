"use client"

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
import { useInventoryStore } from "@/lib/inventory-store"
import { TransactionActions } from "@/components/transaction-actions"
import { cn, formatDateDDMMYYYY } from "@/lib/utils"

const statusStyles: Record<string, string> = {
  Inbound: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  Sale: "bg-red-500/10 text-red-500 dark:text-red-400",
  "POC Out": "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  "POC Return": "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  Rentals: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  Transfer: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  Dispose: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
}

export function TransactionsTable() {
  const { transactions } = useInventoryStore()
  return (
    <Card className="h-full min-h-[300px] sm:min-h-[340px] flex flex-col">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold text-foreground">Recent Transactions</CardTitle>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 overflow-auto overflow-x-auto">
        <Table className="min-w-[560px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="text-xs text-muted-foreground font-medium">Serial Number</TableHead>
              <TableHead className="text-xs text-muted-foreground font-medium hidden sm:table-cell">Item</TableHead>
              <TableHead className="text-xs text-muted-foreground font-medium">Type</TableHead>
              <TableHead className="text-xs text-muted-foreground font-medium hidden md:table-cell">Client / Location</TableHead>
              <TableHead className="text-xs text-muted-foreground font-medium hidden lg:table-cell">Date</TableHead>
              <TableHead className="text-xs text-muted-foreground font-medium hidden lg:table-cell">Invoice</TableHead>
              <TableHead className="text-xs text-muted-foreground font-medium w-[52px]">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {transactions.map((txn) => (
              <TableRow key={txn.id}>
                <TableCell className="font-mono text-xs text-foreground">{txn.serialNumber}</TableCell>
                <TableCell className="text-sm text-foreground hidden sm:table-cell">{txn.itemName}</TableCell>
                <TableCell>
                  <Badge
                    variant="secondary"
                    className={cn("text-[10px] font-medium border-0", statusStyles[txn.type])}
                  >
                    {txn.type}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground hidden md:table-cell">
                  {txn.type === "Transfer" && txn.fromLocation && txn.toLocation
                    ? `${txn.fromLocation} → ${txn.toLocation}`
                    : txn.client}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground hidden lg:table-cell">{formatDateDDMMYYYY(txn.date)}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground hidden lg:table-cell">{txn.invoiceNumber || "\u2014"}</TableCell>
                <TableCell>
                  <TransactionActions transaction={txn} compact />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
