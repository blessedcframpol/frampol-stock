import { Suspense } from "react"
import { DashboardShell } from "@/components/dashboard-shell"
import { AdminProductsContent } from "@/components/admin-products-content"

export default function AdminProductsPage() {
  return (
    <DashboardShell>
      <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading products…</div>}>
        <AdminProductsContent />
      </Suspense>
    </DashboardShell>
  )
}
