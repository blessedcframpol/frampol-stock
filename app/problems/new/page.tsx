"use client"

import { Suspense } from "react"
import { DashboardShell } from "@/components/dashboard-shell"
import { ProblemReportForm } from "@/components/problem-report-form"
import { Loader2 } from "lucide-react"

export default function NewProblemReportPage() {
  return (
    <DashboardShell>
      <Suspense
        fallback={
          <div className="flex items-center gap-2 py-16 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" /> Loading…
          </div>
        }
      >
        <ProblemReportForm />
      </Suspense>
    </DashboardShell>
  )
}
