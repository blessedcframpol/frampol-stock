import { Suspense } from "react"
import { DashboardShell } from "@/components/dashboard-shell"
import { SearchResultsContent } from "@/components/search-results-content"

export default function SearchPage() {
  return (
    <DashboardShell>
      <Suspense fallback={<div className="flex items-center justify-center p-8">Loading search...</div>}>
        <SearchResultsContent />
      </Suspense>
    </DashboardShell>
  )
}
