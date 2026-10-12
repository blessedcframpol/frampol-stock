"use client"

import { useMemo, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Loader2 } from "lucide-react"
import { PageBreadcrumbs } from "@/components/page-breadcrumbs"
import { PageHeader } from "@/components/page-nav"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useAuth } from "@/lib/auth-context"
import {
  captureProblemContext,
  submitProblemReport,
} from "@/lib/problem-reports"
import { MAX_PROBLEM_REPORT_BYTES } from "@/lib/upload-documents"
import { toast } from "sonner"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"

export function ProblemReportForm() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { user, role } = useAuth()
  const [whatHappened, setWhatHappened] = useState("")
  const [whatExpected, setWhatExpected] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [attempted, setAttempted] = useState(false)

  const fromPath = searchParams.get("from") || ""
  const context = useMemo(() => {
    if (fromPath.startsWith("/")) {
      try {
        const u = new URL(fromPath, "https://fram.local")
        return captureProblemContext(u.pathname, u.search)
      } catch {
        /* fall through */
      }
    }
    return captureProblemContext(pathname, searchParams.toString())
  }, [fromPath, pathname, searchParams])

  const pageUrl =
    typeof window !== "undefined"
      ? fromPath.startsWith("/")
        ? `${window.location.origin}${fromPath}`
        : window.location.href
      : fromPath || pathname

  const happenedProblem = !whatHappened.trim() ? "Describe what happened." : null

  async function onSubmit() {
    setAttempted(true)
    if (!user?.id || happenedProblem) return
    if (file && file.size > MAX_PROBLEM_REPORT_BYTES) {
      toast.error("Screenshot must be 5 MB or less")
      return
    }
    setBusy(true)
    try {
      const result = await submitProblemReport({
        whatHappened: whatHappened.trim(),
        whatExpected: whatExpected.trim() || undefined,
        screenshot: file,
        userId: user.id,
        pageUrl,
        context,
      })
      toast.success(`Thanks, sent to Blessed`, {
        description: `Report ${result.report_number}`,
      })
      router.push(`/problems/${result.id}`)
      router.refresh()
    } catch (e) {
      toastFromCaughtError(e, "Could not send report")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex w-full min-w-0 max-w-2xl flex-col gap-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <PageBreadcrumbs
        items={[
          { label: "Dashboard", href: "/" },
          { label: "Report a problem" },
        ]}
      />
      <PageHeader
        title="Report a problem"
        description="Tell us what went wrong. Blessed gets a notification with the report number."
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">What went wrong?</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <Label htmlFor="pr-happened">What happened?</Label>
            <Textarea
              id="pr-happened"
              value={whatHappened}
              onChange={(e) => setWhatHappened(e.target.value)}
              placeholder="Describe the problem…"
              className="min-h-[120px] bg-card text-base sm:text-sm"
              disabled={busy}
              aria-invalid={attempted && !!happenedProblem}
            />
            {attempted && happenedProblem ? (
              <p className="text-sm text-destructive">{happenedProblem}</p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="pr-expected">What did you expect? (optional)</Label>
            <Textarea
              id="pr-expected"
              value={whatExpected}
              onChange={(e) => setWhatExpected(e.target.value)}
              placeholder="What should have happened…"
              className="min-h-[80px] bg-card text-base sm:text-sm"
              disabled={busy}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="pr-shot">Screenshot (optional, image ≤ 5 MB)</Label>
            <Input
              id="pr-shot"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="min-h-11 cursor-pointer text-base sm:text-sm"
              disabled={busy}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            {file ? (
              <p className="text-xs text-muted-foreground">
                {file.name} · {(file.size / 1024).toFixed(0)} KB
              </p>
            ) : null}
          </div>

          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Captured automatically</p>
            <ul className="mt-1 list-inside list-disc space-y-0.5">
              <li>Page: {pageUrl}</li>
              <li>Role: {role ?? "—"}</li>
              {context.request_number ? <li>Request: {context.request_number}</li> : null}
              {context.request_id ? <li>Request id: {context.request_id}</li> : null}
              {context.batch_id ? <li>Batch: {context.batch_id}</li> : null}
              {context.kit_serial ? <li>Serial: {context.kit_serial}</li> : null}
            </ul>
          </div>

          <div className="flex flex-col-reverse gap-2 border-t border-border pt-3 sm:flex-row">
            <Button
              type="button"
              className="min-h-11 w-full sm:w-auto"
              disabled={busy}
              onClick={() => void onSubmit()}
            >
              {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Send report
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="min-h-11 w-full sm:w-auto"
              disabled={busy}
              onClick={() => router.back()}
            >
              Cancel
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
