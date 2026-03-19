import { DashboardShell } from "@/components/dashboard-shell"
import { StockTakeHistoryDetailContent } from "@/components/stock-take-history-detail-content"

export default async function StockTakeHistoryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  return (
    <DashboardShell>
      <StockTakeHistoryDetailContent id={id} />
    </DashboardShell>
  )
}
