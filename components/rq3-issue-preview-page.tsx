"use client"

import { useEffect, useState } from "react"
import { StockRequestFulfill } from "@/components/stock-request-fulfill"
import { PageBreadcrumbs } from "@/components/page-breadcrumbs"
import { useAuth } from "@/lib/auth-context"
import { canFulfillStockRequests } from "@/lib/permissions"
import { getSupabaseClient } from "@/lib/supabase/client"
import { loadRq3IssuePreviewFixture, type Rq3PreviewFixture } from "@/lib/dev/rq3-issue-preview-fixture"
import { Loader2 } from "lucide-react"

/**
 * Dev-only shell: loads (or creates) backing Sale requests, then renders the
 * real issue screen with Issue disabled. Scans hit production preview_issue_scan.
 */
export function Rq3IssuePreviewPage() {
  const { role } = useAuth()
  const allowed = canFulfillStockRequests(role)
  const [fixture, setFixture] = useState<Rq3PreviewFixture | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!allowed) return
    let cancelled = false
    void (async () => {
      try {
        const next = await loadRq3IssuePreviewFixture(getSupabaseClient())
        if (!cancelled) setFixture(next)
      } catch (e) {
        if (!cancelled) {
          const msg =
            e && typeof e === "object" && "message" in e
              ? String((e as { message: unknown }).message)
              : e instanceof Error
                ? e.message
                : "Could not load RQ3b preview fixture"
          setError(msg || "Could not load RQ3b preview fixture")
          console.error("RQ3b preview fixture", e)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [allowed])

  if (!allowed) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <PageBreadcrumbs items={[{ label: "Dev" }, { label: "RQ3 issue preview" }]} />
        <p className="text-sm text-muted-foreground">Sign in as admin or accounts to use this preview.</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <PageBreadcrumbs items={[{ label: "Dev" }, { label: "RQ3 issue preview" }]} />
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      </div>
    )
  }

  if (!fixture) {
    return (
      <div className="flex items-center justify-center gap-2 py-20 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
        Loading preview fixture…
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6">
      <p className="mb-4 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning">
        Development preview only. Scans call real <code className="font-mono text-xs">preview_issue_scan</code>{" "}
        (read-only). Issue is disabled.
      </p>
      <StockRequestFulfill
        requestId={fixture.request.id}
        previewOnly
        fixture={{
          request: fixture.request,
          issuedByLine: fixture.issuedByLine,
          displayStatus: fixture.displayStatus,
          requesterLabel: fixture.requesterLabel,
        }}
        previewRequestByProductId={fixture.previewRequestByProductId}
        previewFallbackRequestId={fixture.previewFallbackRequestId}
      />
    </div>
  )
}
