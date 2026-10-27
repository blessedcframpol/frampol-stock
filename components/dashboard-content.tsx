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
import { EMPTY, formatCount } from "@/lib/format-display"

export function DashboardContent() {
  const { summary, loading: summaryLoading } = useDashboardSummary()
  const { feed, loading: lowStockLoading } = useAlertFeed()
  const role = useEffectiveRole()
  const showQuickScan = canRecordStockMovement(role)
  const statsReady = useIsClient() && !summaryLoading && summary != null

  const lowStockCount = feed?.counts.lowStock ?? 0
  const dash = EMPTY

  return (
    <div className="flex flex-col gap-4 md:gap-6 min-w-0">
      <PageHeader
        title="Dashboard Overview"
        description="Track inventory, monitor stock movements, and manage operations."
      />

      {role === ADMIN ? <AdminTodoRow /> : null}

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        <StatCard
          label="Total inventory"
          value={statsReady ? formatCount(summary.in_stock_sale) : dash}
          caption={
            statsReady
              ? `+ ${formatCount(summary.in_stock_rental)} rental · ${formatCount(summary.in_stock_demo)} demo`
              : undefined
          }
          variant="highlight"
        />
        <StatCard
          label="Items sold"
          value={statsReady ? formatCount(summary.items_sold) : dash}
        />
        <StatCard
          label="POC active"
          value={statsReady ? formatCount(summary.poc_active) : dash}
        />
        <StatCard
          label="Low stock alerts"
          value={statsReady && !lowStockLoading ? formatCount(lowStockCount) : dash}
          href="/alerts?chip=lowStock"
          linkLabel="View low stock"
        />
      </div>

      {/* Quick Scan beside Latest requests. Viewers see requests on their own. */}
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 md:gap-4 items-stretch">
        <div className="lg:col-span-2">
          <StockByVendorChart data={summary?.in_stock_by_vendor ?? []} />
        </div>
        <VendorDistributionChart data={summary?.all_units_by_vendor ?? []} />
      </div>

      <MonthlySalesChart data={summary?.monthly_sales ?? []} />
    </div>
  )
}
