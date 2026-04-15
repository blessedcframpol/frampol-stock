"use client"

import {
  Bar,
  BarChart,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Cell,
} from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { salesByEmployee, clients, monthlySales } from "@/lib/data"
import { buildCsvFilename } from "@/lib/utils"
import { Download, TrendingUp, Users, DollarSign } from "lucide-react"

const BAR_COLORS = ["#6366f1", "#06b6d4", "#10b981", "#f59e0b"]

const topClients = [...clients].sort((a, b) => b.totalSpent - a.totalSpent).slice(0, 5)

function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n")
}

function downloadCsv(rows: string[][], filename: string) {
  const csv = toCsv(rows)
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function ReportsContent() {
  function handleExportCsv() {
    const rows: string[][] = []

    rows.push(["Section", "Month", "Sales", "Revenue"])
    for (const m of monthlySales) rows.push(["Monthly Sales", m.month, String(m.sales), String(m.revenue)])
    rows.push([])

    rows.push(["Section", "Employee", "Sales", "Revenue"])
    for (const s of salesByEmployee) rows.push(["Sales by Employee", s.name, String(s.sales), String(s.revenue)])
    rows.push([])

    rows.push(["Section", "Client Name", "Company", "Total Orders", "Total Spent"])
    for (const c of topClients) {
      rows.push(["Top Clients", c.name, c.company, String(c.totalOrders), String(c.totalSpent)])
    }

    downloadCsv(rows, buildCsvFilename(["Sales reports"], new Date().toISOString()))
  }

  return (
    <div className="flex flex-col gap-4 md:gap-6 min-w-0">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-foreground tracking-tight text-balance">Reports & Analytics</h1>
          <p className="text-sm text-muted-foreground mt-1">Sales performance and stock turnover insights.</p>
        </div>
        <Button variant="outline" size="sm" className="text-foreground w-fit" onClick={handleExportCsv}>
          <Download className="w-4 h-4 mr-1.5" />
          Export CSV
        </Button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4">
        <Card className="py-5 gap-0">
          <CardContent className="flex items-center gap-4">
            <div className="flex items-center justify-center w-11 h-11 rounded-xl bg-indigo-500/10 shrink-0">
              <DollarSign className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Total Revenue</p>
              <p className="text-xl sm:text-2xl font-bold text-foreground mt-0.5 tracking-tight">
                ${monthlySales.reduce((a, b) => a + b.revenue, 0).toLocaleString()}
              </p>
            </div>
          </CardContent>
        </Card>
        <Card className="py-5 gap-0">
          <CardContent className="flex items-center gap-4">
            <div className="flex items-center justify-center w-11 h-11 rounded-xl bg-emerald-500/10 shrink-0">
              <TrendingUp className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Total Sales</p>
              <p className="text-xl sm:text-2xl font-bold text-foreground mt-0.5 tracking-tight">
                {monthlySales.reduce((a, b) => a + b.sales, 0)}
              </p>
            </div>
          </CardContent>
        </Card>
        <Card className="py-5 gap-0">
          <CardContent className="flex items-center gap-4">
            <div className="flex items-center justify-center w-11 h-11 rounded-xl bg-cyan-500/10 shrink-0">
              <Users className="w-5 h-5 text-cyan-600 dark:text-cyan-400" />
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Active Clients</p>
              <p className="text-xl sm:text-2xl font-bold text-foreground mt-0.5 tracking-tight">{clients.length}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">
        {/* Sales by Employee */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold text-foreground">Sales per Employee</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer
              config={{
                revenue: { label: "Revenue", color: "#6366f1" },
              }}
              className="h-[240px] sm:h-[280px]"
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={salesByEmployee} layout="vertical" margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.5} horizontal={false} />
                  <XAxis type="number" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                  <YAxis dataKey="name" type="category" fontSize={11} tickLine={false} axisLine={false} width={60} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="revenue" radius={[0, 6, 6, 0]} name="Revenue">
                    {salesByEmployee.map((_, index) => (
                      <Cell key={`cell-${index}`} fill={BAR_COLORS[index % BAR_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartContainer>
          </CardContent>
        </Card>

        {/* Top Clients */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold text-foreground">Top Clients by Volume</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-0">
            {topClients.map((client, i) => (
              <div
                key={client.id}
                className={`flex items-center gap-3 py-3 ${i !== topClients.length - 1 ? "border-b border-border" : ""}`}
              >
                <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-secondary shrink-0">
                  <span className="text-xs font-bold text-muted-foreground">#{i + 1}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{client.name}</p>
                  <p className="text-xs text-muted-foreground">{client.company}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-semibold text-foreground">${client.totalSpent.toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground">{client.totalOrders} orders</p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Stock Turnover Metrics */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold text-foreground">Stock Turnover Metrics</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 md:gap-4">
            <div className="flex flex-col gap-1 p-3 sm:p-4 rounded-xl bg-secondary">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Avg. Days in Stock</span>
              <span className="text-lg sm:text-xl font-bold text-foreground">18.5</span>
              <Badge variant="secondary" className="w-fit text-[10px] bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-0">Good</Badge>
            </div>
            <div className="flex flex-col gap-1 p-3 sm:p-4 rounded-xl bg-secondary">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Turnover Rate</span>
              <span className="text-lg sm:text-xl font-bold text-foreground">4.2x</span>
              <Badge variant="secondary" className="w-fit text-[10px] bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-0">Healthy</Badge>
            </div>
            <div className="flex flex-col gap-1 p-3 sm:p-4 rounded-xl bg-secondary">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">POC Conversion</span>
              <span className="text-lg sm:text-xl font-bold text-foreground">67%</span>
              <Badge variant="secondary" className="w-fit text-[10px] bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-0">On Track</Badge>
            </div>
            <div className="flex flex-col gap-1 p-3 sm:p-4 rounded-xl bg-secondary">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Dead Stock</span>
              <span className="text-lg sm:text-xl font-bold text-foreground">3.1%</span>
              <Badge variant="secondary" className="w-fit text-[10px] bg-amber-500/10 text-amber-600 dark:text-amber-400 border-0">Monitor</Badge>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
