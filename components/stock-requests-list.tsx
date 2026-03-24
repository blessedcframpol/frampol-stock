"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Plus, MessageSquare } from "lucide-react"
import { useAuth } from "@/lib/auth-context"
import { canCreateStockRequest } from "@/lib/permissions"
import type { StockRequestWithRelations } from "@/lib/supabase/stock-requests-db"
import { formatDateDDMMYYYY } from "@/lib/utils"

const statusVariant: Record<string, string> = {
  draft: "bg-muted text-foreground",
  submitted: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  in_progress: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  serviced: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  invoiced: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
  cancelled: "bg-destructive/15 text-destructive",
}

export function StockRequestsList({ requests }: { requests: StockRequestWithRelations[] }) {
  const { role } = useAuth()
  const canCreate = canCreateStockRequest(role)

  return (
    <div className="flex flex-col gap-4 md:gap-6 min-w-0">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-foreground tracking-tight text-balance">Requests</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Sales raise stock requests with quotations; technicians assign serials; accounts invoice.
          </p>
        </div>
        {canCreate && (
          <Button asChild>
            <Link href="/requests/new" className="gap-2">
              <Plus className="size-4" />
              New request
            </Link>
          </Button>
        )}
      </div>

      {requests.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No stock requests yet.
            {canCreate && (
              <div className="mt-3">
                <Button asChild variant="outline" size="sm">
                  <Link href="/requests/new">Create one</Link>
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Lines</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-[100px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {requests.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">
                      {r.client ? `${r.client.name} — ${r.client.company}` : r.client_id}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {(r.stock_request_lines ?? []).length} line
                      {(r.stock_request_lines ?? []).length !== 1 ? "s" : ""}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className={`text-[10px] border-0 ${statusVariant[r.status] ?? ""}`}>
                        {r.status.replace("_", " ")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                      {formatDateDDMMYYYY(r.created_at)}
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" asChild>
                        <Link href={`/requests/${r.id}`} className="gap-1">
                          <MessageSquare className="size-3.5" />
                          Open
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
