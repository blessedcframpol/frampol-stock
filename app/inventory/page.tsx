import { Suspense } from "react"
import { DashboardShell } from "@/components/dashboard-shell"
import { InventoryContent } from "@/components/inventory-content"

export default function InventoryPage() {
  return (
    <DashboardShell>
      <Suspense fallback={<div className="flex items-center justify-center p-8">Loading inventory...</div>}>
        <InventoryContent />
      </Suspense>
    </DashboardShell>
  )
}
