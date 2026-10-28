"use client"

import { useIsClient } from "@/hooks/use-is-client"
import { StatCard } from "@/components/fs/stat-card"
import { StockByVendorChart, VendorDistributionChart, MonthlySalesChart } from "@/components/dashboard-charts"
import { LatestRequests } from "@/components/latest-requests"
import { QuickScan } from "@/components/quick-scan"
import { TransactionsTable } from "@/components/transactions-table"
import { PageHeader } from "@/components/page-nav"
import { AdminTodoRow } from "@/components/admin-todo-row"
import { useEffectiveRole } from "@/lib/dev-role-preview"
import { ADMIN, canRecordStockMovement } from "@/lib/permissions"
import { useAlertFeed } from "@/hooks/use-alert-feed"
import { useDashboardSummary } from "@/hooks/use-dashboard-summary"
import { formatCount } from "@/lib/format-display"
import {
  ChartCardSkeleton,
  StatCardsSkeleton,
} from "@/components/fs/content-skeletons"
import { LoadErrorInline } from "@/components/fs/load-error-inline"

export function DashboardContent() {
  const { summary, loading: summaryLoading, error: summaryError, refresh } = useDashboardSummary()
  const { feed, loading: lowStockLoading } = useAlertFeed()
  const role = useEffectiveRole()
  const showQuickScan = canRecordStockMovement(role)
  const clientReady = useIsClient()
  const showStatsSkeleton = clientReady && summaryLoading && summary == null
  const showStatsError = clientReady && summaryError != null && summary == null
  const statsReady = clientReady && summary != null
  const dataReady = statsReady && !lowStockLoading

  const lowStockCount = feed?.counts.lowStock ?? 0

  return (
    <div
      className="flex flex-col gap-4 md:gap-6 min-w-0"
      data-ready={dataReady ? "true" : undefined}
    >
      <PageHeader
        title="Dashboard Overview"
        description="Track inventory, monitor stock movements, and manage operations."
      />

      {role === ADMIN ? <AdminTodoRow /> : null}

      {showStatsError ? (
        <LoadErrorInline message="Couldn't load" onRetry={() => void refresh()} />
      ) : showStatsSkeleton ? (
        <StatCardsSkeleton />
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
          <StatCard
            label="Total inventory"
            value={formatCount(summary!.in_stock_sale)}
            caption={`+ ${formatCount(summary!.in_stock_rental)} rental · ${formatCount(summary!.in_stock_demo)} demo`}
            variant="highlight"
          />
          <StatCard label="Items sold" value={formatCount(summary!.items_sold)} />
          <StatCard label="POC active" value={formatCount(summary!.poc_active)} />
          <StatCard
            label="Low stock alerts"
            value={formatCount(lowStockCount)}
            href="/alerts?chip=lowStock"
            linkLabel="View low stock"
          />
        </div>
      )}

      <div
        className={
          showQuickScan
            ? "grid grid-cols-1 items-stretch gap-3 md:gap-4 lg:grid-cols-2"
            : "grid grid-cols-1 gap-3 md:gap-4"
        }
      >
        {showQuickScan ? <QuickScan /> : null}
        <LatestRequests />
      </div>

      <TransactionsTable />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 md:gap-4 items-stretch min-h-[280px]">
        <div className="lg:col-span-2 min-h-[280px]">
          {showStatsSkeleton ? (
            <ChartCardSkeleton tall />
          ) : (
            <StockByVendorChart data={summary?.in_stock_by_vendor ?? []} />
          )}
        </div>
        <div className="min-h-[280px]">
          {showStatsSkeleton ? (
            <ChartCardSkeleton />
          ) : (
            <VendorDistributionChart data={summary?.all_units_by_vendor ?? []} />
          )}
        </div>
      </div>

      <div className="min-h-[280px]">
        {showStatsSkeleton ? (
          <ChartCardSkeleton tall />
        ) : (
          <MonthlySalesChart data={summary?.monthly_sales ?? []} />
        )}
      </div>
    </div>
  )
}
