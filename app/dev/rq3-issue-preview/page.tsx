import { DashboardShell } from "@/components/dashboard-shell"
import { Rq3IssuePreviewPage } from "@/components/rq3-issue-preview-page"

/**
 * Development preview of the real issue screen.
 * Stripped from production builds via scripts/strip-dev-routes.mjs (npm run build).
 */
export default function Page() {
  return (
    <DashboardShell>
      <Rq3IssuePreviewPage />
    </DashboardShell>
  )
}
