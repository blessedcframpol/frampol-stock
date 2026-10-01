import { DashboardShell } from "@/components/dashboard-shell"
import { StockMovementContent } from "@/components/stock-movement-content"

export default async function InventoryMovementPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; serials?: string }>
}) {
  const params = await searchParams
  return (
    <DashboardShell>
      <StockMovementContent prefillType={params.type} prefillSerials={params.serials} />
    </DashboardShell>
  )
}
