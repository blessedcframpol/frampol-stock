"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { StatusPill } from "@/components/fs/status-pill"
import { EmptyState } from "@/components/fs/empty-state"
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
import { formatClientLabel } from "@/lib/client-label"
import { PageHeader } from "@/components/page-nav"

export function StockRequestsList({ requests }: { requests: StockRequestWithRelations[] }) {
  const { role } = useAuth()
  const canCreate = canCreateStockRequest(role)

  return (
    <div className="flex flex-col gap-4 md:gap-6 min-w-0">
      <PageHeader
        title="Requests"
        description="Sales raise stock requests with quotations; technicians assign serials; accounts invoice."
        actions={
          canCreate ? (
            <Button asChild>
              <Link href="/requests/new" className="gap-2">
                <Plus className="size-4" />
                New request
              </Link>
            </Button>
          ) : undefined
        }
      />

      {requests.length === 0 ? (
        <EmptyState
          message="No stock requests yet."
          action={
            canCreate ? (
              <Button asChild variant="outline" size="sm">
                <Link href="/requests/new">Create one</Link>
              </Button>
            ) : undefined
          }
        />
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
                      {r.client ? formatClientLabel(r.client) : r.client_id}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
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
