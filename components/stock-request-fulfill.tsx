"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { RequestStatusPill } from "@/components/request-status-pill"
import { PageHeader } from "@/components/page-nav"
import { PageBreadcrumbs } from "@/components/page-breadcrumbs"
import { useAuth } from "@/lib/auth-context"
import { ADMIN, canFulfillStockRequests } from "@/lib/permissions"
import { getSupabaseClient } from "@/lib/supabase/client"
import { formatClientLabel } from "@/lib/client-label"
import { formatDateDDMMYYYY } from "@/lib/utils"
import { useNotificationsMuted } from "@/hooks/use-inbox-notifications"
import { playIssueScanError, playIssueScanSuccess, requestIsAllFortinet } from "@/lib/issue-scan-feedback"
import {
  alreadyScannedSerials,
  applyCloudKeyToAwaiting,
  applySuccessfulSerial,
  buildEmptySlots,
  consumeScanBuffer,
  enqueueScans,
  filledScansForIssue,
  issueButtonLabel,
  removeSlotSerial,
  takeNextScan,
  type IssueScanMode,
  type IssueScanSlot,
} from "@/lib/issue-scan"
import {
  cancelRequest,
  closeOutstanding,
  fetchIssuedCountsByLineId,
  fetchIssuedSerialsForRequest,
  fetchProfileLabels,
  fetchRequestDisplayStatus,
  fetchStockRequestById,
  issueUnits,
  previewIssueScan,
  rejectRequest,
  type IssueUnitsResult,
  type RejectReasonCode,
  type StockRequestWithRelations,
} from "@/lib/supabase/stock-requests-db"
import {
  displayStatusOrReviewState,
  REJECT_REASON_LABELS,
  requestInvoiceColumnLabel,
  type RequestDisplayStatus,
} from "@/lib/stock-request-statuses"
import { toast } from "sonner"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"
import {
  isAuthFailure,
  loadErrorFromCaught,
  notifySessionExpired,
  signedOutLoadError,
} from "@/lib/unauthorized"
import { AlertCircle, Copy, ExternalLink, Loader2, ScanLine, Truck, Volume2, VolumeX, X } from "lucide-react"
import { cn } from "@/lib/utils"

type Loaded = {
  request: StockRequestWithRelations | null
  issuedByLine: Record<string, number>
  displayStatus: RequestDisplayStatus | null
  requesterLabel: string | null
}

const EMPTY: Loaded = { request: null, issuedByLine: {}, displayStatus: null, requesterLabel: null }

async function load(requestId: string): Promise<Loaded> {
  const sb = getSupabaseClient()
  const request = await fetchStockRequestById(sb, requestId)
  if (!request) return EMPTY
  const [issuedByLine, displayStatus, labels] = await Promise.all([
    fetchIssuedCountsByLineId(
      sb,
      request.stock_request_lines.map((l) => l.id)
    ),
    fetchRequestDisplayStatus(sb, requestId).catch(() => null),
    fetchProfileLabels(sb, [request.created_by]),
  ])
  return {
    request,
    issuedByLine,
    displayStatus,
    requesterLabel: labels.get(request.created_by) ?? null,
  }
}

async function copyText(text: string, toastLabel: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(toastLabel)
  } catch {
    toast.error("Could not copy")
  }
}

export type StockRequestFulfillProps = {
  requestId: string
  /** Dev preview: Issue (and other writes) stay disabled. */
  previewOnly?: boolean
  /** Skip DB load; use this fixture instead. */
  fixture?: Loaded
  /** product_id → real request id for preview_issue_scan (mixed-line preview). */
  previewRequestByProductId?: Record<string, string>
  previewFallbackRequestId?: string
}

export function StockRequestFulfill({
  requestId,
  previewOnly = false,
  fixture,
  previewRequestByProductId,
  previewFallbackRequestId,
}: StockRequestFulfillProps) {
  const { role } = useAuth()
  const allowed = canFulfillStockRequests(role)
  const { muted, setMuted } = useNotificationsMuted()

  const [data, setData] = useState<Loaded>(fixture ?? EMPTY)
  const [loading, setLoading] = useState(!fixture)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadedForId, setLoadedForId] = useState(requestId)
  if (requestId !== loadedForId) {
    setLoadedForId(requestId)
    setLoading(!fixture)
    setLoadError(null)
    setData(fixture ?? EMPTY)
  }

  const [slots, setSlots] = useState<IssueScanSlot[]>([])
  const [scanBuffer, setScanBuffer] = useState("")
  const [scanQueue, setScanQueue] = useState<string[]>([])
  const [mode, setMode] = useState<IssueScanMode>("serial")
  const [cloudKeyPrompt, setCloudKeyPrompt] = useState<string | null>(null)
  const [manualCloudKey, setManualCloudKey] = useState("")
  const [lastError, setLastError] = useState<{ serial: string; reason: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [issueResult, setIssueResult] = useState<IssueUnitsResult | null>(null)
  const [issuedView, setIssuedView] = useState<
    { serial: string; cloudKey: string | null; productName: string }[] | null
  >(null)
  const [postStatus, setPostStatus] = useState<RequestDisplayStatus | null>(null)

  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectCode, setRejectCode] = useState<RejectReasonCode | "">("")
  const [rejectNote, setRejectNote] = useState("")
  const [closeOpen, setCloseOpen] = useState(false)
  const [closeReason, setCloseReason] = useState("")
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelReason, setCancelReason] = useState("")
  const [confirmPartial, setConfirmPartial] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const processingRef = useRef(false)
  const slotsRef = useRef(slots)
  const modeRef = useRef(mode)
  slotsRef.current = slots
  modeRef.current = mode

  const refresh = useCallback(
    async (isCancelled: () => boolean = () => false) => {
      if (fixture) {
        if (isCancelled()) return
        setData(fixture)
        setSlots(
          buildEmptySlots(
            fixture.request!.stock_request_lines.map((l) => ({
              id: l.id,
              product_id: l.product_id,
              product_name: l.product_name,
              quantity_requested: l.quantity_requested,
            })),
            fixture.issuedByLine
          )
        )
        setLoading(false)
        return
      }
      try {
        const next = await load(requestId)
        if (isCancelled()) return
        if (!next.request) {
          const sessionErr = await signedOutLoadError(getSupabaseClient())
          if (isCancelled()) return
          if (sessionErr) {
            setLoadError(sessionErr)
            setData(EMPTY)
            return
          }
        }
        setLoadError(null)
        setData(next)
        if (next.request) {
          setSlots(
            buildEmptySlots(
              next.request.stock_request_lines.map((l) => ({
                id: l.id,
                product_id: l.product_id,
                product_name: l.product_name,
                quantity_requested: l.quantity_requested,
              })),
              next.issuedByLine
            )
          )
        }
      } catch (e) {
        if (isCancelled()) return
        if (isAuthFailure(e)) notifySessionExpired()
        else toastFromCaughtError(e, "Could not load request")
        setLoadError(loadErrorFromCaught(e, "Could not load this request."))
        setData(EMPTY)
      } finally {
        if (!isCancelled()) setLoading(false)
      }
    },
    [requestId, fixture]
  )

  useEffect(() => {
    if (!allowed) return
    let cancelled = false
    void refresh(() => cancelled)
    return () => {
      cancelled = true
    }
  }, [allowed, refresh])

  useEffect(() => {
    if (!loading && !issuedView) inputRef.current?.focus()
  }, [loading, issuedView, mode, cloudKeyPrompt])

  const { request, issuedByLine, requesterLabel } = data
  const lines = useMemo(() => request?.stock_request_lines ?? [], [request])

  // Process queue with a ref-backed loop so rapid scans stay ordered.
  const queueRef = useRef<string[]>([])

  const processOne = useCallback(
    async (raw: string) => {
      if (!request || issuedView) return
      const value = raw.trim()
      if (!value) return

      if (modeRef.current === "cloud_key") {
        const applied = applyCloudKeyToAwaiting(slotsRef.current, value)
        if (!applied.ok) {
          setLastError({ serial: value, reason: applied.reason ?? "Cloud key rejected" })
          if (!muted) playIssueScanError()
          return
        }
        setSlots(applied.slots)
        setMode("serial")
        setCloudKeyPrompt(null)
        setManualCloudKey("")
        setLastError(null)
        if (!muted) playIssueScanSuccess()
        return
      }

      try {
        const already = alreadyScannedSerials(slotsRef.current)
        const sb = getSupabaseClient()
        let previewRequestId = request.id
        if (previewOnly && previewFallbackRequestId) {
          const { data: item } = await sb
            .from("inventory_items")
            .select("product_id")
            .eq("serial_number", value)
            .is("deleted_at", null)
            .maybeSingle()
          const productId = item?.product_id
          previewRequestId =
            (productId && previewRequestByProductId?.[productId]) || previewFallbackRequestId
        }
        const preview = await previewIssueScan(sb, previewRequestId, value, already)
        if (!preview.ok) {
          setLastError({ serial: preview.serial, reason: preview.reason })
          if (!muted) playIssueScanError()
          return
        }
        const applied = applySuccessfulSerial(slotsRef.current, preview)
        if (!applied) {
          setLastError({ serial: value, reason: "No empty slot left for this product" })
          if (!muted) playIssueScanError()
          return
        }
        setSlots(applied.slots)
        setMode(applied.mode)
        setCloudKeyPrompt(applied.cloudKeyPrompt)
        setLastError(null)
        if (!muted) playIssueScanSuccess()
      } catch (e) {
        toastFromCaughtError(e, "Could not check scan")
        setLastError({ serial: value, reason: "Could not check this scan on the server" })
        if (!muted) playIssueScanError()
      }
    },
    [request, issuedView, muted, previewOnly, previewRequestByProductId, previewFallbackRequestId]
  )

  const drainQueue = useCallback(async () => {
    if (processingRef.current || !request || issuedView) return
    processingRef.current = true
    setProcessing(true)
    try {
      while (queueRef.current.length > 0) {
        const { next, rest } = takeNextScan(queueRef.current)
        queueRef.current = rest
        setScanQueue(rest)
        if (next) await processOne(next)
      }
    } finally {
      processingRef.current = false
      setProcessing(false)
      if (queueRef.current.length > 0) void drainQueue()
    }
  }, [processOne, request, issuedView])

  function pushScans(incoming: string[]) {
    if (incoming.length === 0) return
    queueRef.current = enqueueScans(queueRef.current, incoming)
    setScanQueue([...queueRef.current])
    void drainQueue()
  }

  function onScanKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault()
      // Use the live input value — React state can lag a keyboard-wedge Enter.
      const { complete, rest } = consumeScanBuffer(e.currentTarget.value + "\n")
      setScanBuffer(rest)
      pushScans(complete)
    }
  }

  function onScanChange(e: React.ChangeEvent<HTMLInputElement>) {
    const { complete, rest } = consumeScanBuffer(e.target.value)
    setScanBuffer(rest)
    pushScans(complete)
  }

  function onManualCloudKey() {
    const key = manualCloudKey.trim()
    if (!key) return
    pushScans([key])
    setManualCloudKey("")
  }

  async function onIssue(force = false) {
    if (!request || previewOnly) return
    const filled = filledScansForIssue(slots)
    if (filled.length === 0) return
    const outstanding = slots.length
    const btn = issueButtonLabel(filled.length, outstanding)
    if (btn.needsConfirm && !force) {
      setConfirmPartial(true)
      return
    }
    setConfirmPartial(false)
    setBusy(true)
    setIssueResult(null)
    try {
      const res = await issueUnits(
        getSupabaseClient(),
        request.id,
        filled.map((s) => ({ serial: s.serial, lineId: s.lineId, cloudKey: s.cloudKey }))
      )
      setIssueResult(res)
      if (res.ok) {
        toast.success(`Issued ${res.serials.length} unit${res.serials.length === 1 ? "" : "s"}.`)
        const [serials, displayStatus] = await Promise.all([
          fetchIssuedSerialsForRequest(getSupabaseClient(), request.id),
          fetchRequestDisplayStatus(getSupabaseClient(), request.id).catch(() => null),
        ])
        const just = new Set(res.serials.map((s) => s.trim().toLowerCase()))
        setIssuedView(
          serials
            .filter((s) => just.has(s.serial.trim().toLowerCase()))
            .map((s) => ({ serial: s.serial, cloudKey: s.cloudKey, productName: s.productName }))
        )
        setPostStatus(displayStatus)
        setSlots([])
        setMode("serial")
        setCloudKeyPrompt(null)
        void refresh()
      } else {
        setSlots((prev) =>
          prev.map((slot) => {
            const fail = res.failures.find(
              (f) => f.serial.trim().toLowerCase() === (slot.serial ?? "").trim().toLowerCase()
            )
            if (!fail) return slot
            return { ...slot, status: "error" as const, reason: fail.reason, flash: "error" as const }
          })
        )
        toast.error(
          res.failures.length === 1
            ? `${res.failures[0].serial || "A scan"}: ${res.failures[0].reason}`
            : `${res.failures.length} scans failed. Nothing was issued.`
        )
        if (!muted) playIssueScanError()
      }
    } catch (e) {
      toastFromCaughtError(e, "Could not issue units")
    } finally {
      setBusy(false)
      inputRef.current?.focus()
    }
  }

  async function runAction(fn: () => Promise<void>, okMsg: string, failMsg: string) {
    setBusy(true)
    try {
      await fn()
      toast.success(okMsg)
      await refresh()
      return true
    } catch (e) {
      toastFromCaughtError(e, failMsg)
      return false
    } finally {
      setBusy(false)
    }
  }

  const crumbs = [
    { label: "Requests", href: "/requests" },
    { label: request?.request_number ?? requestId, href: `/requests/${requestId}` },
    { label: "Issue units" },
  ]

  if (!allowed) {
    return (
      <div className="flex flex-col gap-4">
        <PageBreadcrumbs items={crumbs} />
        <p className="text-sm text-muted-foreground">Only admin or accounts can issue units.</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground gap-2">
        <Loader2 className="size-5 animate-spin" />
        Loading…
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="flex flex-col gap-4">
        <PageBreadcrumbs items={crumbs} />
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
      </div>
    )
  }

  if (!request) {
    return (
      <div className="flex flex-col gap-4">
        <PageBreadcrumbs items={crumbs} />
        <p className="text-sm text-muted-foreground">Request not found.</p>
      </div>
    )
  }

  const displayStatus =
    postStatus ?? data.displayStatus ?? displayStatusOrReviewState(null, request.review_state)
  const requested = lines.reduce((n, l) => n + l.quantity_requested, 0)
  const issued = lines.reduce((n, l) => n + Math.min(l.quantity_requested, issuedByLine[l.id] ?? 0), 0)
  const outstanding = Math.max(0, requested - issued)
  const allFortinet = requestIsAllFortinet(lines)
  const filled = filledScansForIssue(slots)
  const btn = issueButtonLabel(filled.length, slots.length)

  const blocked =
    request.review_state !== "submitted"
      ? request.review_state === "awaiting_approval"
        ? "This request is waiting for 00000 approval. Units can be issued after an admin approves it."
        : `This request is ${displayStatus.replaceAll("_", " ")}. Units cannot be issued.`
      : outstanding === 0 && !issuedView
        ? "Every requested unit is already issued."
        : role !== ADMIN && !allFortinet
          ? "Accounts can only issue Fortinet units."
          : null

  const descriptionLines =
    issuedView?.map((s) =>
      s.cloudKey ? `${s.productName}\t${s.serial}\t${s.cloudKey}` : `${s.productName}\t${s.serial}`
    ) ?? []
  const serialOnlyLines = issuedView?.map((s) => s.serial) ?? []

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <PageHeader
        title={request.request_number}
        description={`${request.type} · ${request.client ? formatClientLabel(request.client) : request.client_id}`}
        actions={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1"
            onClick={() => setMuted(!muted)}
            aria-pressed={muted}
            title={muted ? "Sound is muted" : "Sound is on"}
          >
            {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
            {muted ? "Muted" : "Sound on"}
          </Button>
        }
      />
      <PageBreadcrumbs items={crumbs} />

      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <RequestStatusPill status={displayStatus} />
        {allFortinet ? (
          <span className="rounded-md border border-border bg-muted/40 px-2 py-0.5 text-xs font-medium text-foreground">
            Fortinet
          </span>
        ) : null}
        <span>
          issued {issued} of {requested}
        </span>
      </div>

      <Card>
        <CardContent className="grid gap-3 pt-4 text-sm sm:grid-cols-2">
          <div>
            <p className="text-xs text-muted-foreground">Client</p>
            <p className="font-medium">{request.client ? formatClientLabel(request.client) : request.client_id}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Requester</p>
            <p className="font-medium">{requesterLabel ?? `User ${request.created_by.slice(0, 8)}`}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Type</p>
            <p className="font-medium">{request.type}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Invoice</p>
            <p className="font-medium">{requestInvoiceColumnLabel(request)}</p>
          </div>
          {request.return_date ? (
            <div>
              <p className="text-xs text-muted-foreground">Return date</p>
              <p className="font-medium">{formatDateDDMMYYYY(request.return_date)}</p>
            </div>
          ) : null}
          <div className="sm:col-span-2">
            <p className="text-xs text-muted-foreground">Atlas task</p>
            {request.atlas_task_url ? (
              <a
                href={request.atlas_task_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-medium text-brand hover:underline"
              >
                Open Atlas task
                <ExternalLink className="size-3.5" />
              </a>
            ) : (
              <p>—</p>
            )}
          </div>
          {request.notes ? (
            <div className="sm:col-span-2">
              <p className="text-xs text-muted-foreground">Notes</p>
              <p className="whitespace-pre-wrap">{request.notes}</p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {issuedView ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex flex-wrap items-center justify-between gap-2">
              <span>Just issued</span>
              <span className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="gap-1"
                  onClick={() => void copyText(descriptionLines.join("\n"), "Copied with descriptions")}
                >
                  <Copy className="size-3.5" />
                  Copy with descriptions
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="gap-1"
                  onClick={() => void copyText(serialOnlyLines.join("\n"), "Copied serials")}
                >
                  <Copy className="size-3.5" />
                  Copy serials only
                </Button>
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <RequestStatusPill status={displayStatus} />
              <span className="text-sm text-muted-foreground">Request status after this issue</span>
            </div>
            <ul className="flex flex-col gap-2">
              {issuedView.map((s) => (
                <li key={s.serial} className="rounded-lg border border-success/40 bg-success-soft px-3 py-2 text-sm">
                  <p className="font-medium">{s.productName}</p>
                  <p className="font-mono text-xs">{s.serial}</p>
                  {s.cloudKey ? <p className="font-mono text-xs text-muted-foreground">Cloud key {s.cloudKey}</p> : null}
                </li>
              ))}
            </ul>
            <Button variant="outline" asChild className="w-fit">
              <Link href={`/requests/${request.id}`}>Back to request</Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {blocked && !issuedView ? (
        <div
          role="alert"
          className="flex gap-3 rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning"
        >
          <AlertCircle className="size-5 shrink-0" />
          <div className="flex flex-col gap-2">
            <p>{blocked}</p>
            <Link href={`/requests/${request.id}`} className="underline w-fit">
              Back to request
            </Link>
          </div>
        </div>
      ) : null}

      {!blocked && !issuedView ? (
        <>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Lines</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {lines.map((l) => {
                const got = Math.min(l.quantity_requested, issuedByLine[l.id] ?? 0)
                const lineSlots = slots.filter((s) => s.lineId === l.id)
                return (
                  <div key={l.id} className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="font-medium text-sm">{l.product_name}</p>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        requested {l.quantity_requested} · issued {got}
                      </p>
                    </div>
                    <ul className="grid gap-2 sm:grid-cols-2">
                      {lineSlots.map((slot) => (
                        <li
                          key={slot.id}
                          className={cn(
                            "flex items-start justify-between gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
                            slot.flash === "success" && "border-success bg-success-soft",
                            slot.flash === "error" || slot.status === "error"
                              ? "border-danger/50 bg-danger-soft"
                              : null,
                            slot.status === "awaiting_cloud_key" && "border-brand/50 bg-brand/10",
                            slot.status === "empty" && "border-dashed border-border bg-muted/10",
                            slot.status === "ok" && !slot.flash && "border-border bg-muted/20"
                          )}
                        >
                          <div className="min-w-0">
                            {slot.serial ? (
                              <>
                                <p className="font-mono text-xs">{slot.serial}</p>
                                {slot.cloudKey ? (
                                  <p className="font-mono text-[11px] text-muted-foreground">Key {slot.cloudKey}</p>
                                ) : slot.status === "awaiting_cloud_key" ? (
                                  <p className="text-xs text-brand">Waiting for cloud key</p>
                                ) : null}
                                {slot.reason ? <p className="text-xs text-danger mt-0.5">{slot.reason}</p> : null}
                              </>
                            ) : (
                              <p className="text-xs text-muted-foreground">Empty slot</p>
                            )}
                          </div>
                          {slot.serial ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="size-7 shrink-0 text-muted-foreground"
                              disabled={busy}
                              aria-label={`Remove ${slot.serial}`}
                              onClick={() => {
                                setSlots((prev) => removeSlotSerial(prev, slot.id))
                                if (slot.status === "awaiting_cloud_key") {
                                  setMode("serial")
                                  setCloudKeyPrompt(null)
                                }
                                setIssueResult(null)
                              }}
                            >
                              <X className="size-3.5" />
                            </Button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Scan</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div
                className={cn(
                  "rounded-lg border px-3 py-2 transition-colors",
                  lastError ? "border-danger/50 bg-danger-soft" : "border-border bg-card",
                  mode === "cloud_key" && !lastError && "border-brand/50 bg-brand/5"
                )}
              >
                <Label htmlFor="issue-scan" className="sr-only">
                  Scan serial
                </Label>
                <div className="relative">
                  <ScanLine className="pointer-events-none absolute left-0 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="issue-scan"
                    ref={inputRef}
                    value={scanBuffer}
                    onChange={onScanChange}
                    onKeyDown={onScanKeyDown}
                    placeholder={
                      mode === "cloud_key"
                        ? cloudKeyPrompt ?? "Scan cloud key"
                        : "Scan serial (Enter or Tab)"
                    }
                    className="border-0 bg-transparent pl-7 font-mono shadow-none focus-visible:ring-0"
                    disabled={busy}
                    autoFocus
                    autoComplete="off"
                    aria-label={mode === "cloud_key" ? "Cloud key" : "Serial number"}
                  />
                </div>
                {mode === "cloud_key" && cloudKeyPrompt ? (
                  <p className="mt-1 text-sm font-medium text-brand" role="status">
                    {cloudKeyPrompt}
                  </p>
                ) : null}
                {lastError ? (
                  <p className="mt-1 text-sm text-danger" role="alert">
                    <span className="font-mono">{lastError.serial}</span> — {lastError.reason}
                  </p>
                ) : processing || scanQueue.length > 0 ? (
                  <p className="mt-1 text-xs text-muted-foreground" role="status">
                    Checking{scanQueue.length > 0 ? ` · ${scanQueue.length} queued` : "…"}
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Keep focus here. Results also show as colour and text when sound is muted.
                  </p>
                )}
              </div>

              {mode === "cloud_key" ? (
                <div className="flex flex-wrap gap-2">
                  <Input
                    value={manualCloudKey}
                    onChange={(e) => setManualCloudKey(e.target.value)}
                    placeholder="Or type cloud key"
                    className="font-mono bg-card max-w-xs"
                    disabled={busy}
                    aria-label="Manual cloud key"
                  />
                  <Button type="button" variant="secondary" disabled={busy || !manualCloudKey.trim()} onClick={onManualCloudKey}>
                    Add key
                  </Button>
                </div>
              ) : null}

              {issueResult && !issueResult.ok ? (
                <p className="text-sm text-destructive">
                  Nothing was issued. Fix the marked slots and try again.
                </p>
              ) : null}

              <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                {previewOnly ? (
                  <Button disabled className="gap-1">
                    Preview only
                  </Button>
                ) : (
                  <Button
                    disabled={busy || filled.length === 0 || mode === "cloud_key"}
                    onClick={() => void onIssue(false)}
                    className="gap-1"
                  >
                    {busy ? <Loader2 className="size-4 animate-spin" /> : <Truck className="size-4" />}
                    {btn.label}
                  </Button>
                )}
                <Button
                  variant="outline"
                  disabled={busy || previewOnly}
                  onClick={() => setRejectOpen(true)}
                >
                  Reject
                </Button>
                {outstanding > 0 && issued > 0 ? (
                  <Button
                    variant="outline"
                    disabled={busy || previewOnly}
                    onClick={() => setCloseOpen(true)}
                  >
                    Close outstanding
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  disabled={busy || previewOnly}
                  onClick={() => setCancelOpen(true)}
                >
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}

      <Dialog open={confirmPartial} onOpenChange={setConfirmPartial}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Issue partial?</DialogTitle>
            <DialogDescription>{btn.confirmMessage}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmPartial(false)}>
              Keep scanning
            </Button>
            <Button onClick={() => void onIssue(true)}>Issue {filled.length}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reject this request</DialogTitle>
            <DialogDescription>The requester sees the reason and can edit and resubmit.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-2">
              <Label>Reason</Label>
              <Select value={rejectCode || undefined} onValueChange={(v) => setRejectCode(v as RejectReasonCode)}>
                <SelectTrigger className="bg-card">
                  <SelectValue placeholder="Pick a reason…" />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(REJECT_REASON_LABELS) as RejectReasonCode[]).map((code) => (
                    <SelectItem key={code} value={code}>
                      {REJECT_REASON_LABELS[code]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="fulfill-reject-note">
                Note{rejectCode === "other" ? " (required)" : " (optional)"}
              </Label>
              <Textarea
                id="fulfill-reject-note"
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
                className="bg-card"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setRejectOpen(false)}>
              Back
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (!rejectCode) {
                  toast.error("Pick a rejection reason.")
                  return
                }
                if (rejectCode === "other" && !rejectNote.trim()) {
                  toast.error("Explain the rejection when the reason is Other.")
                  return
                }
                void runAction(
                  () => rejectRequest(getSupabaseClient(), request.id, rejectCode, rejectNote.trim() || null),
                  "Request rejected.",
                  "Could not reject"
                ).then((ok) => {
                  if (ok) {
                    setRejectOpen(false)
                    setRejectCode("")
                    setRejectNote("")
                  }
                })
              }}
            >
              Reject request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={closeOpen} onOpenChange={setCloseOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Close outstanding units</DialogTitle>
            <DialogDescription>
              Remaining units will never be issued. Units already issued stay issued.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="fulfill-close-reason">Reason (at least 15 characters)</Label>
            <Textarea
              id="fulfill-close-reason"
              value={closeReason}
              onChange={(e) => setCloseReason(e.target.value)}
              className="bg-card"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setCloseOpen(false)}>
              Back
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                if (closeReason.trim().length < 15) {
                  toast.error("Give a reason of at least 15 characters.")
                  return
                }
                void runAction(
                  () => closeOutstanding(getSupabaseClient(), request.id, closeReason.trim()),
                  "Outstanding units closed.",
                  "Could not close outstanding units"
                ).then((ok) => {
                  if (ok) {
                    setCloseOpen(false)
                    setCloseReason("")
                  }
                })
              }}
            >
              Close outstanding
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel this request?</DialogTitle>
            <DialogDescription>A reason is optional.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="fulfill-cancel-reason">Reason</Label>
            <Textarea
              id="fulfill-cancel-reason"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              className="bg-card"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setCancelOpen(false)}>
              Keep request
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                void runAction(
                  () => cancelRequest(getSupabaseClient(), request.id, cancelReason.trim() || null),
                  "Request cancelled.",
                  "Could not cancel"
                ).then((ok) => {
                  if (ok) {
                    setCancelOpen(false)
                    setCancelReason("")
                  }
                })
              }}
            >
              Cancel request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
