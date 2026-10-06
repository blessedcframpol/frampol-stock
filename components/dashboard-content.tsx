"use client"

import { useIsClient } from "@/hooks/use-is-client"
import { StatCard } from "@/components/fs/stat-card"
import { StockByVendorChart, VendorDistributionChart, MonthlySalesChart } from "@/components/dashboard-charts"
import { LatestRequests } from "@/components/latest-requests"
import { QuickScan } from "@/components/quick-scan"
import { TransactionsTable } from "@/components/transactions-table"
import { useInventoryStore } from "@/lib/inventory-store"
import { PageHeader } from "@/components/page-nav"
import { useAuth } from "@/lib/auth-context"
import { inStockPoolCounts } from "@/lib/inventory-products"
import { canRecordStockMovement } from "@/lib/permissions"
import { useAlertFeed } from "@/hooks/use-alert-feed"
import { EMPTY, formatCount } from "@/lib/format-display"

export function DashboardContent() {
  const { inventory } = useInventoryStore()
  const { feed, loading: lowStockLoading } = useAlertFeed()
  const { role } = useAuth()
  const showQuickScan = canRecordStockMovement(role)
  const statsReady = useIsClient()

  const pools = inStockPoolCounts(inventory)
  const itemsSold = inventory.filter((i) => i.status === "Sold").length
  const pocActive = inventory.filter((i) => i.status === "POC").length
  const lowStockCount = feed?.counts.lowStock ?? 0

  const showStats = statsReady
  const dash = EMPTY

  return (
    <div className="flex flex-col gap-4 md:gap-6 min-w-0">
      <PageHeader
        title="Dashboard Overview"
        description="Track inventory, monitor stock movements, and manage operations."
      />

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        <StatCard
          label="Total inventory"
          value={showStats ? formatCount(pools.sale) : dash}
          caption={showStats ? `+ ${formatCount(pools.rental)} rental · ${formatCount(pools.demo)} demo` : undefined}
          variant="highlight"
        />
        <StatCard
          label="Items sold"
          value={showStats ? formatCount(itemsSold) : dash}
        />
        <StatCard
          label="POC active"
          value={showStats ? formatCount(pocActive) : dash}
        />
        <StatCard
          label="Low stock alerts"
          value={showStats && !lowStockLoading ? formatCount(lowStockCount) : dash}
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
          <StockByVendorChart />
        </div>
        <VendorDistributionChart />
      </div>

      <MonthlySalesChart />
    </div>
  )
}
