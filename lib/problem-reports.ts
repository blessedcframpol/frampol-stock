import { getSupabaseClient } from "@/lib/supabase/client"
import {
  ALLOWED_PROBLEM_SCREENSHOT_MIME_TYPES,
  MAX_PROBLEM_REPORT_BYTES,
  uploadDocument,
} from "@/lib/upload-documents"
import type { AppRole } from "@/lib/permissions"
import type { Json } from "@/lib/supabase/database.types"

export type ProblemReportStatus = "open" | "in_progress" | "resolved"

export const PROBLEM_REPORT_STATUS_LABELS: Record<ProblemReportStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
}

export type ProblemReportContext = {
  request_number?: string
  request_id?: string
  batch_id?: string
  kit_serial?: string
  [key: string]: string | undefined
}

export type ProblemReportRow = {
  id: string
  report_number: string
  created_by: string
  what_happened: string
  what_expected: string | null
  screenshot_path: string | null
  page_url: string
  reporter_role: AppRole | null
  browser: string | null
  device: string | null
  context: ProblemReportContext
  status: ProblemReportStatus
  resolution_note: string | null
  resolved_by: string | null
  resolved_at: string | null
  created_at: string
  updated_at: string
}

export function captureProblemContext(pathname: string, search: string): ProblemReportContext {
  const ctx: ProblemReportContext = {}
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)

  const requestMatch = pathname.match(/\/requests\/([0-9a-f-]{36})/i)
  if (requestMatch) ctx.request_id = requestMatch[1]

  const reqNum =
    params.get("request") ||
    params.get("request_number") ||
    params.get("req")
  if (reqNum && /^REQ-\d{2}-\d+$/i.test(reqNum)) ctx.request_number = reqNum.toUpperCase()

  const batch =
    params.get("batch") ||
    params.get("batch_id") ||
    params.get("batchId")
  if (batch) ctx.batch_id = batch

  const serial =
    params.get("serial") ||
    params.get("kit") ||
    params.get("kit_serial")
  if (serial) ctx.kit_serial = serial.trim()

  return ctx
}

export function captureBrowserInfo(): { browser: string; device: string } {
  if (typeof navigator === "undefined") return { browser: "", device: "" }
  const browser = navigator.userAgent || ""
  const device =
    typeof window !== "undefined"
      ? `${window.innerWidth}x${window.innerHeight}${navigator.maxTouchPoints > 0 ? " touch" : ""}`
      : ""
  return { browser, device }
}

async function uploadProblemScreenshot(userId: string, file: File): Promise<string> {
  if (file.size <= 0 || file.size > MAX_PROBLEM_REPORT_BYTES) {
    throw new Error("Screenshot must be between 1 byte and 5 MB")
  }
  if (!(ALLOWED_PROBLEM_SCREENSHOT_MIME_TYPES as readonly string[]).includes(file.type)) {
    throw new Error(`Unsupported file type. Allowed: ${ALLOWED_PROBLEM_SCREENSHOT_MIME_TYPES.join(", ")}`)
  }
  // Server route enforces scopeId === authenticated user id and stores under problem-reports/{userId}/...
  return uploadDocument("problem-report", userId, file)
}

export async function submitProblemReport(input: {
  whatHappened: string
  whatExpected?: string
  screenshot?: File | null
  userId: string
  pageUrl: string
  context?: ProblemReportContext
}): Promise<{ id: string; report_number: string }> {
  let screenshotPath: string | null = null
  if (input.screenshot) {
    screenshotPath = await uploadProblemScreenshot(input.userId, input.screenshot)
  }
  const { browser, device } = captureBrowserInfo()
  const { data, error } = await getSupabaseClient().rpc("submit_problem_report", {
    p_what_happened: input.whatHappened,
    p_what_expected: input.whatExpected?.trim() || null,
    p_screenshot_path: screenshotPath,
    p_page_url: input.pageUrl,
    p_browser: browser || null,
    p_device: device || null,
    p_context: (input.context ?? {}) as Json,
  })
  if (error) throw error
  const row = data as { id?: string; report_number?: string } | null
  if (!row?.id || !row.report_number) throw new Error("Submit did not return a report number")
  return { id: row.id, report_number: row.report_number }
}

export async function fetchProblemReports(opts?: {
  mineOnly?: boolean
}): Promise<ProblemReportRow[]> {
  let q = getSupabaseClient()
    .from("problem_reports")
    .select(
      "id, report_number, created_by, what_happened, what_expected, screenshot_path, page_url, reporter_role, browser, device, context, status, resolution_note, resolved_by, resolved_at, created_at, updated_at"
    )
    .order("created_at", { ascending: false })
  if (opts?.mineOnly) {
    // RLS already scopes non-admins; explicit filter keeps the query small for reporters.
    const { data: userData } = await getSupabaseClient().auth.getUser()
    const uid = userData.user?.id
    if (uid) q = q.eq("created_by", uid)
  }
  const { data, error } = await q
  if (error) throw error
  return (data ?? []).map(mapRow)
}

export async function fetchProblemReport(id: string): Promise<ProblemReportRow | null> {
  const { data, error } = await getSupabaseClient()
    .from("problem_reports")
    .select(
      "id, report_number, created_by, what_happened, what_expected, screenshot_path, page_url, reporter_role, browser, device, context, status, resolution_note, resolved_by, resolved_at, created_at, updated_at"
    )
    .eq("id", id)
    .maybeSingle()
  if (error) throw error
  return data ? mapRow(data) : null
}

export async function updateProblemReportStatus(
  id: string,
  status: ProblemReportStatus,
  note?: string
): Promise<void> {
  const { error } = await getSupabaseClient().rpc("update_problem_report_status", {
    p_id: id,
    p_status: status,
    p_resolution_note: note?.trim() || null,
  })
  if (error) throw error
}

function mapRow(row: Record<string, unknown>): ProblemReportRow {
  const ctx = (row.context && typeof row.context === "object" ? row.context : {}) as ProblemReportContext
  return {
    id: String(row.id),
    report_number: String(row.report_number),
    created_by: String(row.created_by),
    what_happened: String(row.what_happened),
    what_expected: (row.what_expected as string | null) ?? null,
    screenshot_path: (row.screenshot_path as string | null) ?? null,
    page_url: String(row.page_url),
    reporter_role: (row.reporter_role as AppRole | null) ?? null,
    browser: (row.browser as string | null) ?? null,
    device: (row.device as string | null) ?? null,
    context: ctx,
    status: row.status as ProblemReportStatus,
    resolution_note: (row.resolution_note as string | null) ?? null,
    resolved_by: (row.resolved_by as string | null) ?? null,
    resolved_at: (row.resolved_at as string | null) ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }
}
