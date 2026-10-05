import { DashboardShell } from "@/components/dashboard-shell"
import { InspectionCaseContent } from "@/components/inspection-case-content"

export default async function InspectionCasePage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params
  return (
    <DashboardShell>
      <InspectionCaseContent caseId={caseId} />
    </DashboardShell>
  )
}
