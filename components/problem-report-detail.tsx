"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { Loader2 } from "lucide-react"
import { PageBreadcrumbs } from "@/components/page-breadcrumbs"
import { PageHeader } from "@/components/page-nav"
import { SignedStorageLink } from "@/components/signed-storage-link"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useAuth } from "@/lib/auth-context"
import { canManageProblemReports, ROLE_LABELS } from "@/lib/permissions"
import {
  fetchProblemReport,
  PROBLEM_REPORT_STATUS_LABELS,
  updateProblemReportStatus,
  type ProblemReportRow,
  type ProblemReportStatus,
} from "@/lib/problem-reports"
import { formatDateDDMMYYYY } from "@/lib/utils"
import { toast } from "sonner"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"
import { getSupabaseClient } from "@/lib/supabase/client"

export function ProblemReportDetail({ id }: { id: string }) {
  const { role, user } = useAuth()
  const canManage = canManageProblemReports(role)
  const [row, setRow] = useState<ProblemReportRow | null>(null)
  const [reporterName, setReporterName] = useState<string>("")
  const [resolverName, setResolverName] = useState<string>("")
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<ProblemReportStatus>("open")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchProblemReport(id)
      setRow(data)
      if (data) {
        setStatus(data.status)
        setNote(data.resolution_note || "")
        const ids = [data.created_by, data.resolved_by].filter(Boolean) as string[]
        if (ids.length) {
          const { data: labels } = await getSupabaseClient().rpc("profile_display_labels", {
            p_ids: ids,
          })
          for (const l of labels ?? []) {
            if (l.id === data.created_by) setReporterName(l.label)
            if (data.resolved_by && l.id === data.resolved_by) setResolverName(l.label)
          }
        }
      }
    } catch (e) {
      toastFromCaughtError(e, "Could not load report")
      setRow(null)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  async function onSaveStatus() {
    if (!row || !canManage) return
    setBusy(true)
    try {
      await updateProblemReportStatus(row.id, status, note)
      toast.success("Status updated")
      await load()
    } catch (e) {
      toastFromCaughtError(e, "Could not update status")
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-16 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" /> Loading report…
      </div>
    )
  }

  if (!row) {
    return (
      <div className="flex flex-col gap-4">
        <PageBreadcrumbs
          items={[
            { label: "Dashboard", href: "/" },
            { label: "Problems", href: canManage ? "/problems" : "/problems/mine" },
            { label: "Not found" },
          ]}
        />
        <p className="text-sm text-muted-foreground">
          Report not found, or you do not have access.
        </p>
      </div>
    )
  }

  const listHref =
    canManage || user?.id !== row.created_by
      ? canManage
        ? "/problems"
        : "/problems/mine"
      : "/problems/mine"

  const ctxEntries = Object.entries(row.context).filter(([, v]) => v)

  return (
    <div className="flex w-full min-w-0 max-w-3xl flex-col gap-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <PageBreadcrumbs
        items={[
          { label: "Dashboard", href: "/" },
          {
            label: canManage ? "Reported problems" : "My reported problems",
            href: listHref,
          },
          { label: row.report_number },
        ]}
      />
      <PageHeader
        title={row.report_number}
        description={`Filed ${formatDateDDMMYYYY(row.created_at)}${
          reporterName ? ` by ${reporterName}` : ""
        }`}
        actions={<StatusBadge status={row.status} />}
      />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">What happened</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="whitespace-pre-wrap text-foreground">{row.what_happened}</p>
          {row.what_expected ? (
            <div>
              <p className="text-xs font-medium text-muted-foreground">Expected</p>
              <p className="mt-1 whitespace-pre-wrap">{row.what_expected}</p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Captured context</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
          <Field label="Page URL">
            <a href={row.page_url} className="break-all text-brand hover:underline" target="_blank" rel="noreferrer">
              {row.page_url}
            </a>
          </Field>
          <Field label="Role">
            {row.reporter_role ? ROLE_LABELS[row.reporter_role] : "—"}
          </Field>
          <Field label="Browser">{row.browser || "—"}</Field>
          <Field label="Device">{row.device || "—"}</Field>
          {ctxEntries.map(([k, v]) => (
            <Field key={k} label={k.replace(/_/g, " ")}>
              {v}
            </Field>
          ))}
          <Field label="Screenshot">
            {row.screenshot_path ? (
              <SignedStorageLink path={row.screenshot_path} className="text-brand hover:underline">
                Open screenshot
              </SignedStorageLink>
            ) : (
              "—"
            )}
          </Field>
        </CardContent>
      </Card>

      {row.status === "resolved" || row.resolution_note ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Resolution</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {row.resolution_note ? (
              <p className="whitespace-pre-wrap">{row.resolution_note}</p>
            ) : null}
            {row.resolved_at ? (
              <p className="text-xs text-muted-foreground">
                Resolved {formatDateDDMMYYYY(row.resolved_at)}
                {resolverName ? ` by ${resolverName}` : ""}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {canManage ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Update status</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label>Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as ProblemReportStatus)}>
                <SelectTrigger className="min-h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PROBLEM_REPORT_STATUS_LABELS) as ProblemReportStatus[]).map(
                    (s) => (
                      <SelectItem key={s} value={s}>
                        {PROBLEM_REPORT_STATUS_LABELS[s]}
                      </SelectItem>
                    )
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="pr-note">Note</Label>
              <Textarea
                id="pr-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Resolution note (shown to the reporter when resolved)…"
                className="min-h-[80px]"
                disabled={busy}
              />
            </div>
            <Button className="min-h-11 w-full sm:w-fit" disabled={busy} onClick={() => void onSaveStatus()}>
              {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Save status
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <Button variant="outline" className="min-h-11 w-full sm:w-fit" asChild>
        <Link href={listHref}>Back to list</Link>
      </Button>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium capitalize text-muted-foreground">{label}</p>
      <div className="mt-0.5 break-words text-foreground">{children}</div>
    </div>
  )
}

function StatusBadge({ status }: { status: ProblemReportStatus }) {
  const tone =
    status === "resolved"
      ? "bg-success/15 text-success"
      : status === "in_progress"
        ? "bg-warning/15 text-warning"
        : "bg-muted text-foreground"
  return (
    <Badge variant="secondary" className={tone}>
      {PROBLEM_REPORT_STATUS_LABELS[status]}
    </Badge>
  )
}
