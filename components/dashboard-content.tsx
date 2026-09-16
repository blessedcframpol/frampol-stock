"use client"

import { useIsClient } from "@/hooks/use-is-client"
import { Package, ShoppingCart, Radio, AlertTriangle } from "lucide-react"
import { StatCard } from "@/components/stat-card"
import { StockByVendorChart, VendorDistributionChart, MonthlySalesChart } from "@/components/dashboard-charts"
import { LatestRequests } from "@/components/latest-requests"
import { QuickScan } from "@/components/quick-scan"
import { TransactionsTable } from "@/components/transactions-table"
import { useInventoryStore } from "@/lib/inventory-store"
import { PageHeader } from "@/components/page-nav"
import { useAuth } from "@/lib/auth-context"
import { canRecordStockMovement } from "@/lib/permissions"

export function DashboardContent() {
  const { inventory, getAlerts } = useInventoryStore()
  const { role } = useAuth()
  const showQuickScan = canRecordStockMovement(role)
  // Reorder thresholds come from localStorage. Gate every stat card so the first
  // paint stays "—" instead of showing inventory numbers a frame earlier than before.
  const statsReady = useIsClient()

  const totalStock = inventory.filter((i) => i.status === "In Stock").length
  const itemsSold = inventory.filter((i) => i.status === "Sold").length
  const pocActive = inventory.filter((i) => i.status === "POC").length
  const lowStockCount = getAlerts().lowStock.length

  const showStats = statsReady
  const dash = "—" as const

  return (
    <div className="flex flex-col gap-4 md:gap-6 min-w-0">
      <PageHeader
        title="Dashboard Overview"
        description="Track inventory, monitor stock movements, and manage operations."
      />

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        <StatCard
          title="Total Inventory"
          value={showStats ? totalStock : dash}
          change="In stock"
          changeType="neutral"
          icon={Package}
          iconBg="bg-indigo-500/10"
          iconColor="text-indigo-600 dark:text-indigo-400"
        />
        <StatCard
          title="Items Sold"
          value={showStats ? itemsSold : dash}
          change="Sold to date"
          changeType="neutral"
          icon={ShoppingCart}
          iconBg="bg-emerald-500/10"
          iconColor="text-emerald-600 dark:text-emerald-400"
        />
        <StatCard
          title="POC Active"
          value={showStats ? pocActive : dash}
          change={showStats ? (pocActive > 0 ? "On POC" : "None") : "…"}
          changeType="neutral"
          icon={Radio}
          iconBg="bg-cyan-500/10"
          iconColor="text-cyan-600 dark:text-cyan-400"
        />
        <StatCard
          title="Low Stock Alerts"
          value={showStats ? lowStockCount : dash}
          change={showStats ? (lowStockCount > 0 ? "View alerts" : "All good") : "…"}
          changeType={showStats && lowStockCount > 0 ? "negative" : "neutral"}
          icon={AlertTriangle}
          iconBg="bg-amber-500/10"
          iconColor="text-amber-600 dark:text-amber-400"
        />
      </div>

      {/* Quick Scan (admin/technicians) + Stock by vendor */}
      <div
        className={
          showQuickScan
            ? "grid grid-cols-1 lg:grid-cols-3 gap-3 md:gap-4 items-stretch"
            : "grid grid-cols-1 gap-3 md:gap-4 items-stretch"
        }
      >
        {showQuickScan ? (
          <div className="min-h-[300px] sm:min-h-[340px]">
            <QuickScan />
          </div>
        ) : null}
        <div className={showQuickScan ? "lg:col-span-2 min-h-[300px] sm:min-h-[340px]" : "min-h-[300px] sm:min-h-[340px]"}>
          <StockByVendorChart />
        </div>
      </div>

      {/* Latest requests + Recent Transactions (same row, same height) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 md:gap-4 items-stretch">
        <div className="min-h-[300px] sm:min-h-[340px]">
          <LatestRequests />
        </div>
        <div className="lg:col-span-2 min-h-[300px] sm:min-h-[340px]">
          <TransactionsTable />
        </div>
      </div>

      {/* Vendor distribution + Monthly Revenue (same row, same height) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 md:gap-4 items-stretch">
        <div className="min-h-[300px] sm:min-h-[340px]">
          <VendorDistributionChart />
        </div>
        <div className="lg:col-span-2 min-h-[300px] sm:min-h-[340px]">
          <MonthlySalesChart />
        </div>
      </div>
    </div>
  )
}
