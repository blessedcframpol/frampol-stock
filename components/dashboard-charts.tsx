"use client"

import { useMemo } from "react"
import {
  Bar,
  BarChart,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Cell,
  PieChart,
  Pie,
  Tooltip,
  Legend,
} from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { useInventoryStore } from "@/lib/inventory-store"

const CATEGORY_COLORS = ["#6366f1", "#06b6d4", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#64748b"]

const MONTH_LABELS: Record<string, string> = {
  "01": "Jan", "02": "Feb", "03": "Mar", "04": "Apr", "05": "May", "06": "Jun",
  "07": "Jul", "08": "Aug", "09": "Sep", "10": "Oct", "11": "Nov", "12": "Dec",
}

export function StockByCategoryChart() {
  const { inventory } = useInventoryStore()
  const stockByCategory = useMemo(() => {
    const byType: Record<string, { inStock: number; sold: number; poc: number; rented: number; maintenance: number; disposed: number }> = {}
    inventory.forEach((item) => {
      const cat = item.itemType
      if (!byType[cat]) byType[cat] = { inStock: 0, sold: 0, poc: 0, rented: 0, maintenance: 0, disposed: 0 }
      if (item.status === "In Stock") byType[cat].inStock++
      else if (item.status === "Sold") byType[cat].sold++
      else if (item.status === "POC") byType[cat].poc++
      else if (item.status === "Rented") byType[cat].rented++
      else if (item.status === "Maintenance") byType[cat].maintenance++
      else if (item.status === "Disposed") byType[cat].disposed++
    })
    return Object.entries(byType)
      .map(([category, counts]) => ({
        category,
        inStock: counts.inStock,
        sold: counts.sold,
        poc: counts.poc,
        rented: counts.rented,
        maintenance: counts.maintenance,
      }))
      .sort((a, b) => (b.inStock + b.sold + b.poc + b.rented + b.maintenance) - (a.inStock + a.sold + a.poc + a.rented + a.maintenance))
  }, [inventory])

  return (
    <Card className="h-full min-h-[300px] sm:min-h-[340px] flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold text-foreground">Inventory by Category</CardTitle>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col min-h-0">
        <ChartContainer
          config={{
            inStock: { label: "In Stock", color: "#6366f1" },
            sold: { label: "Sold", color: "#10b981" },
            poc: { label: "POC", color: "#06b6d4" },
            rented: { label: "Rented", color: "#3b82f6" },
            maintenance: { label: "Maintenance", color: "#f59e0b" },
          }}
          className="h-[240px] sm:h-[280px]"
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={stockByCategory} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.5} />
              <XAxis dataKey="category" fontSize={10} tickLine={false} axisLine={false} />
              <YAxis fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="inStock" stackId="a" fill="#6366f1" radius={[0, 0, 0, 0]} name="In Stock" />
              <Bar dataKey="sold" stackId="a" fill="#10b981" name="Sold" />
              <Bar dataKey="poc" stackId="a" fill="#06b6d4" name="POC" />
              <Bar dataKey="rented" stackId="a" fill="#3b82f6" name="Rented" />
              <Bar dataKey="maintenance" stackId="a" fill="#f59e0b" radius={[4, 4, 0, 0]} name="Maintenance" />
            </BarChart>
          </ResponsiveContainer>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}

export function CategoryDistributionChart() {
  const { inventory } = useInventoryStore()
  const pieData = useMemo(() => {
    const byType: Record<string, number> = {}
    inventory.forEach((item) => {
      const cat = item.itemType
      byType[cat] = (byType[cat] ?? 0) + 1
    })
    return Object.entries(byType).map(([name], index) => ({
      name,
      value: byType[name],
      fill: CATEGORY_COLORS[index % CATEGORY_COLORS.length],
    })).sort((a, b) => b.value - a.value)
  }, [inventory])

  return (
    <Card className="h-full min-h-[300px] sm:min-h-[340px] flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold text-foreground">Category Distribution</CardTitle>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col min-h-0">
        <div className="h-[240px] sm:h-[280px] flex-1 min-h-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={pieData}
                cx="50%"
                cy="50%"
                innerRadius={50}
                outerRadius={85}
                paddingAngle={3}
                dataKey="value"
              >
                {pieData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.fill} />
                ))}
              </Pie>
              <Tooltip
                formatter={(value: number, name: string) => [`${value} items`, name]}
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "8px",
                  fontSize: "12px",
                  color: "hsl(var(--foreground))",
                }}
              />
              <Legend
                formatter={(value) => <span className="text-foreground text-[11px]">{value}</span>}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}

export function MonthlySalesChart() {
  const { transactions } = useInventoryStore()
  const monthlyData = useMemo(() => {
    const byMonth: Record<string, number> = {}
    transactions.forEach((txn) => {
      if (txn.type !== "Sale") return
      const monthKey = txn.date.slice(0, 7)
      byMonth[monthKey] = (byMonth[monthKey] ?? 0) + 1
    })
    const sorted = Object.entries(byMonth)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-6)
    return sorted.map(([monthKey, count]) => {
      const [y, m] = monthKey.split("-")
      return {
        month: MONTH_LABELS[m] ?? monthKey,
        monthKey,
        sales: count,
      }
    })
  }, [transactions])

  return (
    <Card className="h-full min-h-[300px] sm:min-h-[340px] flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold text-foreground">Monthly Sales</CardTitle>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col min-h-0">
        <ChartContainer
          config={{
            sales: { label: "Orders", color: "#6366f1" },
          }}
          className="h-[240px] sm:h-[280px]"
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={monthlyData} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.5} />
              <XAxis dataKey="month" fontSize={10} tickLine={false} axisLine={false} />
              <YAxis fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="sales" fill="#6366f1" radius={[6, 6, 0, 0]} name="Orders">
                {monthlyData.map((_, index) => (
                  <Cell
                    key={`cell-${index}`}
                    fill="#6366f1"
                    fillOpacity={0.2 + (monthlyData.length ? (index / monthlyData.length) * 0.8 : 0.5)}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}
