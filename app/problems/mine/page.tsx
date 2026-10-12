"use client"

import { DashboardShell } from "@/components/dashboard-shell"
import { ProblemReportsList } from "@/components/problem-reports-list"

export default function MyProblemReportsPage() {
  return (
    <DashboardShell>
      <ProblemReportsList mode="mine" />
    </DashboardShell>
  )
}
