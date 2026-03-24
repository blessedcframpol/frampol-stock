"use client"

import { useParams } from "next/navigation"
import { DashboardShell } from "@/components/dashboard-shell"
import { StockRequestBilling } from "@/components/stock-request-billing"

export default function StockRequestBillingPage() {
  const params = useParams()
  const id = typeof params?.id === "string" ? params.id : ""

  return (
    <DashboardShell>{id ? <StockRequestBilling requestId={id} /> : <p className="text-sm text-muted-foreground">Invalid request.</p>}</DashboardShell>
  )
}
