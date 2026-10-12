"use client"

import { use } from "react"
import { DashboardShell } from "@/components/dashboard-shell"
import { ProblemReportDetail } from "@/components/problem-report-detail"

export default function ProblemReportDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  return (
    <DashboardShell>
      <ProblemReportDetail id={id} />
    </DashboardShell>
  )
}
