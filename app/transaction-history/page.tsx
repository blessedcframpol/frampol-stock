import { DashboardShell } from "@/components/dashboard-shell"
import { TransactionHistoryContent } from "@/components/transaction-history-content"

export default function TransactionHistoryPage() {
  return (
    <DashboardShell>
      <TransactionHistoryContent />
    </DashboardShell>
  )
}
