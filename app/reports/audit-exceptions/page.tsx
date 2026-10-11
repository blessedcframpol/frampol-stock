import { Suspense } from "react"
import { DashboardShell } from "@/components/dashboard-shell"
import { AuditExceptionsReport } from "@/components/audit-exceptions-report"

export default function AuditExceptionsPage() {
  return (
    <DashboardShell>
      <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
        <AuditExceptionsReport />
      </Suspense>
    </DashboardShell>
  )
}
