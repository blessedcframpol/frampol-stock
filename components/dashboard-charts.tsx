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
  LabelList,
} from "recharts"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { useInventoryStore } from "@/lib/inventory-store"
import { todayBusinessDate } from "@/lib/business-date.mjs"
import { allUnitsByVendor, inStockByVendor, monthlySaleUnits } from "@/lib/dashboard-metrics"
import { useOrgTimezone } from "@/hooks/use-org-timezone"
import { chartAxisTick, chartGridProps, chartTooltipStyle } from "@/components/fs/chart-theme"

const CHART_SERIES = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

const barValueLabel = {
  position: "right" as const,
  fill: "var(--foreground)",
  fontSize: 12,
}

export function StockByVendorChart() {
  const { inventory } = useInventoryStore()
  const stockByVendor = useMemo(() => inStockByVendor(inventory), [inventory])

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold text-foreground">In stock by vendor</CardTitle>
        <CardDescription>In stock units only</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col min-h-0">
        <ChartContainer
          config={{
            units: { label: "In stock", color: "var(--chart-1)" },
          }}
          className="h-[220px]"
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={stockByVendor}
              layout="vertical"
              margin={{ top: 4, right: 36, left: 4, bottom: 4 }}
            >
              <CartesianGrid {...chartGridProps} horizontal={false} vertical />
              <XAxis type="number" tickLine={false} axisLine={false} allowDecimals={false} tick={chartAxisTick} />
              <YAxis
                type="category"
                dataKey="vendor"
                width={84}
                tickLine={false}
                axisLine={false}
                tick={chartAxisTick}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="units" fill="var(--chart-1)" radius={[0, 8, 8, 0]} name="In stock">
                <LabelList dataKey="units" {...barValueLabel} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}

export function VendorDistributionChart() {
  const { inventory } = useInventoryStore()
  const pieData = useMemo(
    () =>
      allUnitsByVendor(inventory).map((row, index) => ({
        name: row.vendor,
        value: row.units,
        fill: CHART_SERIES[index % CHART_SERIES.length],
      })),
    [inventory]
  )

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold text-foreground">All units by vendor</CardTitle>
        <CardDescription>Every status, including sold and disposed</CardDescription>
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
                contentStyle={chartTooltipStyle}
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
  const timeZone = useOrgTimezone()
  const monthlyData = useMemo(
    () => monthlySaleUnits(transactions, todayBusinessDate(timeZone)),
    [transactions, timeZone]
  )

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold text-foreground">Monthly sales</CardTitle>
        <CardDescription>Sale units by business date, last 6 months</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col min-h-0">
        <ChartContainer
          config={{
            units: { label: "Units", color: "var(--chart-1)" },
          }}
          className="h-[240px] sm:h-[280px]"
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={monthlyData} margin={{ top: 5, right: 10, left: 8, bottom: 5 }}>
              <CartesianGrid {...chartGridProps} />
              <XAxis dataKey="month" tickLine={false} axisLine={false} tick={chartAxisTick} />
              <YAxis
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
                tick={chartAxisTick}
                width={48}
                label={{
                  value: "Units",
                  angle: -90,
                  position: "insideLeft",
                  fill: "var(--muted-foreground)",
                  fontSize: 11,
                }}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="units" fill="var(--chart-1)" radius={[8, 8, 0, 0]} name="Units" />
            </BarChart>
          </ResponsiveContainer>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}
