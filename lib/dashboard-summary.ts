import { getSupabaseClient } from "@/lib/supabase/client"
import type { MonthlySaleUnits, VendorUnits } from "@/lib/dashboard-metrics"

export type DashboardSummary = {
  in_stock_sale: number
  in_stock_rental: number
  in_stock_demo: number
  items_sold: number
  poc_active: number
  in_stock_by_vendor: VendorUnits[]
  all_units_by_vendor: VendorUnits[]
  monthly_sales: (MonthlySaleUnits & {
    internal_units: number
    internal_label: string
  })[]
}

function asVendorUnits(value: unknown): VendorUnits[] {
  if (!Array.isArray(value)) return []
  return value
    .map((row) => {
      if (!row || typeof row !== "object") return null
      const vendor = String((row as { vendor?: unknown }).vendor ?? "")
      const units = Number((row as { units?: unknown }).units ?? 0)
      if (!vendor || !Number.isFinite(units)) return null
      return { vendor, units }
    })
    .filter((row): row is VendorUnits => row != null)
}

function asMonthly(value: unknown): DashboardSummary["monthly_sales"] {
  if (!Array.isArray(value)) return []
  return value
    .map((row) => {
      if (!row || typeof row !== "object") return null
      const r = row as Record<string, unknown>
      const month_key = String(r.month_key ?? "")
      const month = String(r.month ?? "")
      const units = Number(r.units ?? 0)
      const internal_units = Number(r.internal_units ?? 0)
      const internal_label = String(r.internal_label ?? "Internal")
      if (!month_key || !Number.isFinite(units)) return null
      return { monthKey: month_key, month, units, internal_units, internal_label }
    })
    .filter((row): row is DashboardSummary["monthly_sales"][number] => row != null)
}

export function parseDashboardSummary(raw: unknown): DashboardSummary | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  return {
    in_stock_sale: Number(r.in_stock_sale ?? 0),
    in_stock_rental: Number(r.in_stock_rental ?? 0),
    in_stock_demo: Number(r.in_stock_demo ?? 0),
    items_sold: Number(r.items_sold ?? 0),
    poc_active: Number(r.poc_active ?? 0),
    in_stock_by_vendor: asVendorUnits(r.in_stock_by_vendor),
    all_units_by_vendor: asVendorUnits(r.all_units_by_vendor),
    monthly_sales: asMonthly(r.monthly_sales),
  }
}

export async function fetchDashboardSummary(): Promise<DashboardSummary> {
  const { data, error } = await getSupabaseClient().rpc("dashboard_summary")
  if (error) throw error
  const parsed = parseDashboardSummary(data)
  if (!parsed) throw new Error("dashboard_summary returned an unexpected shape")
  return parsed
}
