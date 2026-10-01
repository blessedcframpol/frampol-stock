import { Suspense } from "react"
import { DashboardShell } from "@/components/dashboard-shell"
import { InventorySerialsContent } from "@/components/inventory-serials-content"

export default async function InventoryProductPage({
  params,
}: {
  params: Promise<{ productId: string }>
}) {
  const { productId } = await params
  return (
    <DashboardShell>
      <Suspense fallback={<div className="flex items-center justify-center p-8">Loading inventory...</div>}>
        <InventorySerialsContent productId={decodeURIComponent(productId)} />
      </Suspense>
    </DashboardShell>
  )
}
