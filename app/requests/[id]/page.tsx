"use client"

import { useParams } from "next/navigation"
import { DashboardShell } from "@/components/dashboard-shell"
import { StockRequestDetail } from "@/components/stock-request-detail"

export default function StockRequestDetailPage() {
  const params = useParams()
  const id = typeof params?.id === "string" ? params.id : ""

  return (
    <DashboardShell>{id ? <StockRequestDetail requestId={id} /> : <p className="text-sm text-muted-foreground">Invalid request.</p>}</DashboardShell>
  )
}
