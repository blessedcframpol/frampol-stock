"use client"

import { DashboardShell } from "@/components/dashboard-shell"
import { StockRequestsList } from "@/components/stock-requests-list"
import { PageHeader } from "@/components/page-nav"
import { useRequestQueuesRefresh } from "@/hooks/use-request-queues-refresh"
import { useStockRequests } from "@/lib/supabase/stock-requests-db"
import { LoadErrorInline } from "@/components/fs/load-error-inline"

export default function RequestsPage() {
  const { list, loading, error, refetch, softRefetch } = useStockRequests()
  useRequestQueuesRefresh(softRefetch, !loading && !error)

  return (
    <DashboardShell>
      {error && list.length === 0 ? (
        <div className="flex flex-col gap-4 md:gap-6 min-w-0">
          <PageHeader title="Requests" />
          <LoadErrorInline onRetry={() => void refetch()} />
        </div>
      ) : (
        <StockRequestsList
          requests={list}
          loading={loading && list.length === 0}
          onRequestsChanged={() => void softRefetch()}
        />
      )}
    </DashboardShell>
  )
}
