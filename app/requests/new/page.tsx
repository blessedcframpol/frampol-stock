"use client"

import { DashboardShell } from "@/components/dashboard-shell"
import { StockRequestForm } from "@/components/stock-request-form"

export default function NewStockRequestPage() {
  return (
    <DashboardShell>
      <StockRequestForm mode="create" />
    </DashboardShell>
  )
}
