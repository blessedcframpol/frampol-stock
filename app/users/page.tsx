import { Suspense } from "react"
import { DashboardShell } from "@/components/dashboard-shell"
import { UsersContent } from "@/components/users-content"

export default function UsersPage() {
  return (
    <DashboardShell>
      <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading users…</div>}>
        <UsersContent />
      </Suspense>
    </DashboardShell>
  )
}
