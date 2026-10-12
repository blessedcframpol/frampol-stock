"use client"

import { DashboardShell } from "@/components/dashboard-shell"
import { ProblemReportsList } from "@/components/problem-reports-list"
import { useAuth } from "@/lib/auth-context"
import { canManageProblemReports } from "@/lib/permissions"

export default function ProblemReportsPage() {
  const { role } = useAuth()
  // Admin sees everything; everyone else sees only their own (RLS also enforces this).
  const mode = canManageProblemReports(role) ? "admin" : "mine"
  return (
    <DashboardShell>
      <ProblemReportsList mode={mode} />
    </DashboardShell>
  )
}
