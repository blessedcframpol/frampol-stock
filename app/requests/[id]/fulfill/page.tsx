"use client"

import { useParams } from "next/navigation"
import { DashboardShell } from "@/components/dashboard-shell"
import { StockRequestFulfill } from "@/components/stock-request-fulfill"

export default function StockRequestFulfillPage() {
  const params = useParams()
  const id = typeof params?.id === "string" ? params.id : ""

  return (
    <DashboardShell>{id ? <StockRequestFulfill requestId={id} /> : <p className="text-sm text-muted-foreground">Invalid request.</p>}</DashboardShell>
  )
}
