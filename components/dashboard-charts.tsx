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
import type { MonthlySaleUnits, VendorUnits } from "@/lib/dashboard-metrics"
import { chartAxisTick, chartGridProps, chartTooltipStyle } from "@/components/fs/chart-theme"
import { formatCount, hundredTicks } from "@/lib/format-display"

const CHART_SERIES = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

const barValueLabel = {
  fill: "var(--foreground)",
  fontSize: 12,
  formatter: (value: number | string) => formatCount(Number(value) || 0),
}

export function StockByVendorChart({ data }: { data: VendorUnits[] }) {
  const stockByVendor = data
  const axis = useMemo(
    () => hundredTicks(Math.max(0, ...stockByVendor.map((row) => row.units))),
    [stockByVendor],
  )

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
              <XAxis
                type="number"
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
                tick={chartAxisTick}
                domain={axis.domain}
                ticks={axis.ticks}
                tickFormatter={(value: number) => formatCount(value)}
              />
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
                <LabelList dataKey="units" position="right" {...barValueLabel} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}

export function VendorDistributionChart({ data }: { data: VendorUnits[] }) {
  const pieData = useMemo(
    () =>
      data.map((row, index) => ({
        name: row.vendor,
        value: row.units,
        fill: CHART_SERIES[index % CHART_SERIES.length],
      })),
    [data]
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
                formatter={(value: number, name: string) => [`${formatCount(value)} items`, name]}
                contentStyle={chartTooltipStyle}
              />
              <Legend
                formatter={(value, entry) => {
                  const count = (entry as { payload?: { value?: number } }).payload?.value ?? 0
                  return (
                    <span className="text-[11px] text-foreground">
                      {value} ({formatCount(count)})
                    </span>
                  )
                }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}

export function MonthlySalesChart({
  data,
}: {
  data: (MonthlySaleUnits & { internal_units?: number; internal_label?: string })[]
}) {
  const monthlyData = data
  const salesAxis = useMemo(
    () => hundredTicks(Math.max(0, ...monthlyData.map((row) => row.units))),
    [monthlyData],
  )
  const internalTotal = monthlyData.reduce((sum, row) => sum + (row.internal_units ?? 0), 0)
  const internalLabel = monthlyData.find((row) => row.internal_label)?.internal_label ?? "Internal"

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold text-foreground">Monthly sales</CardTitle>
        <CardDescription>
          Sale units by business date, last 6 months
          {internalTotal > 0
            ? ` · ${formatCount(internalTotal)} ${internalLabel.toLowerCase()} included`
            : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col min-h-0">
        <ChartContainer
          config={{
            units: { label: "Units", color: "var(--chart-1)" },
          }}
          className="h-[240px] sm:h-[280px]"
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={monthlyData} margin={{ top: 24, right: 10, left: 8, bottom: 5 }}>
              <CartesianGrid {...chartGridProps} />
              <XAxis dataKey="month" tickLine={false} axisLine={false} tick={chartAxisTick} />
              <YAxis
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
                tick={chartAxisTick}
                width={48}
                domain={salesAxis.domain}
                ticks={salesAxis.ticks}
                tickFormatter={(value: number) => formatCount(value)}
                label={{
                  value: "Units",
                  angle: -90,
                  position: "insideLeft",
                  fill: "var(--muted-foreground)",
                  fontSize: 11,
                }}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="units" fill="var(--chart-1)" radius={[8, 8, 0, 0]} name="Units">
                <LabelList dataKey="units" position="top" {...barValueLabel} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}
