import { Suspense } from "react"
import { DashboardShell } from "@/components/dashboard-shell"
import { StockTakeContent } from "@/components/stock-take-content"

export default function StockTakePage() {
  return (
    <DashboardShell>
      <Suspense fallback={<div className="flex items-center justify-center p-8">Loading stock take…</div>}>
        <StockTakeContent />
      </Suspense>
    </DashboardShell>
  )
}
