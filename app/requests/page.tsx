"use client"

import { DashboardShell } from "@/components/dashboard-shell"
import { StockRequestsList } from "@/components/stock-requests-list"
import { useStockRequests } from "@/lib/supabase/stock-requests-db"
import { AlertCircle, Loader2 } from "lucide-react"

export default function RequestsPage() {
  const { list, loading, error } = useStockRequests()

  return (
    <DashboardShell>
      {loading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground gap-2">
          <Loader2 className="size-5 animate-spin" />
          Loading requests…
        </div>
      ) : error ? (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="size-5 shrink-0" />
          <p>{error.message}</p>
        </div>
      ) : (
        <StockRequestsList requests={list} />
      )}
    </DashboardShell>
  )
}
