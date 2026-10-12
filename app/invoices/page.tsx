import { Suspense } from "react"
import { DashboardShell } from "@/components/dashboard-shell"
import { InvoicesContent } from "@/components/invoices-content"

export default function InvoicesPage() {
  return (
    <DashboardShell>
      <Suspense fallback={null}>
        <InvoicesContent />
      </Suspense>
    </DashboardShell>
  )
}
