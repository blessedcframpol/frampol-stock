"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
import { useInventoryStore } from "@/lib/inventory-store"
import { getSupabaseClient } from "@/lib/supabase/client"
import { formatClientLabel } from "@/lib/client-label"
import {
  fetchIssuedCountsByLineId,
  fetchRequestDisplayStatus,
  fetchStockRequestById,
  issueUnits,
  type IssueUnitsResult,
  type StockRequestWithRelations,
} from "@/lib/supabase/stock-requests-db"
import { displayStatusOrReviewState, type RequestDisplayStatus } from "@/lib/stock-request-statuses"
import { toast } from "sonner"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"
import {
  isAuthFailure,
  loadErrorFromCaught,
  notifySessionExpired,
  signedOutLoadError,
} from "@/lib/unauthorized"
import { AlertCircle, Loader2, ScanLine, Trash2, Truck } from "lucide-react"

type Scan = {
  serial: string
  cloudKey: string
}

type Loaded = {
  request: StockRequestWithRelations | null
  issuedByLine: Record<string, number>
  displayStatus: RequestDisplayStatus | null
}

const EMPTY: Loaded = { request: null, issuedByLine: {}, displayStatus: null }

async function load(requestId: string): Promise<Loaded> {
  const sb = getSupabaseClient()
  const request = await fetchStockRequestById(sb, requestId)
  if (!request) return EMPTY
  const [issuedByLine, displayStatus] = await Promise.all([
    fetchIssuedCountsByLineId(
      sb,
      request.stock_request_lines.map((l) => l.id)
    ),
    fetchRequestDisplayStatus(sb, requestId).catch(() => null),
  ])
  return { request, issuedByLine, displayStatus }
}

export function StockRequestFulfill({ requestId }: { requestId: string }) {
  const router = useRouter()
  const { role } = useAuth()
  const { inventory } = useInventoryStore()
  const allowed = canFulfillStockRequests(role)

  const [data, setData] = useState<Loaded>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadedForId, setLoadedForId] = useState(requestId)
  if (requestId !== loadedForId) {
    setLoadedForId(requestId)
    setLoading(true)
    setLoadError(null)
    setData(EMPTY)
  }

  const [serialInput, setSerialInput] = useState("")
  const [scans, setScans] = useState<Scan[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<IssueUnitsResult | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(
    async (isCancelled: () => boolean = () => false) => {
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
    [requestId]
  )

  useEffect(() => {
    if (!allowed) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refresh is async; setState is after await
    void refresh(() => cancelled)
    return () => {
      cancelled = true
    }
  }, [allowed, refresh])

  const { request, issuedByLine } = data
  const lines = useMemo(() => request?.stock_request_lines ?? [], [request])

  const itemBySerial = useMemo(() => {
    const map = new Map<string, (typeof inventory)[number]>()
    for (const item of inventory) {
      if (!item.deletedAt) map.set(item.serialNumber.trim().toLowerCase(), item)
    }
    return map
  }, [inventory])

  /** What each scan will land on, as far as the client can tell. The server decides. */
  const scanInfo = useMemo(() => {
    const pending: Record<string, number> = {}
    return scans.map((s) => {
      const item = itemBySerial.get(s.serial.trim().toLowerCase())
      const line = item?.productId ? lines.find((l) => l.product_id === item.productId) : undefined
      const needsKey = Boolean(line?.requires_cloud_key) && !item?.cloudKey?.trim()
      if (line) pending[line.id] = (pending[line.id] ?? 0) + 1
      return { scan: s, item, line, needsKey }
    })
  }, [scans, itemBySerial, lines])

  const failureBySerial = useMemo(() => {
    const map = new Map<string, string>()
    for (const f of result?.failures ?? []) map.set(f.serial.trim().toLowerCase(), f.reason)
    return map
  }, [result])

  function addSerial() {
    const serial = serialInput.trim()
    if (!serial) return
    if (scans.some((s) => s.serial.toLowerCase() === serial.toLowerCase())) {
      toast.error(`${serial} is already in the list.`)
    } else {
      setScans((prev) => [...prev, { serial, cloudKey: "" }])
      setResult(null)
    }
    setSerialInput("")
    inputRef.current?.focus()
  }

  async function onIssue() {
    if (!request || scans.length === 0) return
    const missingKey = scanInfo.find((s) => s.needsKey && !s.scan.cloudKey.trim())
    if (missingKey) {
      toast.error(`${missingKey.scan.serial} needs a cloud key.`)
      return
    }
    setBusy(true)
    try {
      const res = await issueUnits(
        getSupabaseClient(),
        request.id,
        scans.map((s) => ({ serial: s.serial, cloudKey: s.cloudKey.trim() || null }))
      )
      setResult(res)
      if (res.ok) {
        toast.success(`Issued ${res.serials.length} unit${res.serials.length === 1 ? "" : "s"}.`)
        router.push(`/requests/${request.id}`)
        router.refresh()
      } else {
        toast.error(
          res.failures.length === 1
            ? `${res.failures[0].serial || "A scan"}: ${res.failures[0].reason}`
            : `${res.failures.length} scans failed. Nothing was issued.`
        )
      }
    } catch (e) {
      toastFromCaughtError(e, "Could not issue units")
    } finally {
      setBusy(false)
    }
  }

  const crumbs = [
    { label: "Requests", href: "/requests" },
    { label: requestId, href: `/requests/${requestId}` },
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

  const displayStatus = data.displayStatus ?? displayStatusOrReviewState(null, request.review_state)
  const requested = lines.reduce((n, l) => n + l.quantity_requested, 0)
  const issued = lines.reduce((n, l) => n + Math.min(l.quantity_requested, issuedByLine[l.id] ?? 0), 0)
  const outstanding = Math.max(0, requested - issued)
  const allFortinet = lines.length > 0 && lines.every((l) => (l.vendor ?? "").trim().toLowerCase() === "fortinet")

  const blocked =
    request.review_state !== "submitted"
      ? request.review_state === "awaiting_approval"
        ? "This request is waiting for 00000 approval. Units can be issued after an admin approves it."
        : `This request is ${displayStatus.replaceAll("_", " ")}. Units cannot be issued.`
      : outstanding === 0
        ? "Every requested unit is already issued."
        : role !== ADMIN && !allFortinet
          ? "Accounts can only issue Fortinet units."
          : null

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <PageHeader
        title="Issue units"
        description={request.client ? formatClientLabel(request.client) : request.client_id}
      />
      <PageBreadcrumbs items={crumbs} />

      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <RequestStatusPill status={displayStatus} />
        <span>
          {request.type} · issued {issued} of {requested}
        </span>
      </div>

      {blocked ? (
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

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">What is still needed</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Issued</TableHead>
                <TableHead className="text-right">Scanned now</TableHead>
                <TableHead>Needs</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((l) => {
                const got = Math.min(l.quantity_requested, issuedByLine[l.id] ?? 0)
                const pending = scanInfo.filter((s) => s.line?.id === l.id).length
                const over = got + pending > l.quantity_requested
                return (
                  <TableRow key={l.id}>
                    <TableCell className="font-medium">{l.product_name}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {got} of {l.quantity_requested}
                    </TableCell>
                    <TableCell className={`text-right tabular-nums ${over ? "text-destructive" : ""}`}>
                      {pending}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {[l.requires_serial ? "serial" : null, l.requires_cloud_key ? "cloud key" : null]
                        .filter(Boolean)
                        .join(" + ") || "—"}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {!blocked ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Scan serials</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                addSerial()
              }}
            >
              <div className="relative flex-1">
                <ScanLine className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={inputRef}
                  value={serialInput}
                  onChange={(e) => setSerialInput(e.target.value)}
                  placeholder="Scan or type a serial, then Enter"
                  className="pl-9 font-mono bg-card"
                  disabled={busy}
                  autoFocus
                  autoComplete="off"
                  aria-label="Serial number"
                />
              </div>
              <Button type="submit" variant="secondary" disabled={busy || !serialInput.trim()}>
                Add
              </Button>
            </form>

            {scans.length === 0 ? (
              <p className="text-sm text-muted-foreground">No serials scanned yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {scanInfo.map(({ scan, item, line, needsKey }) => {
                  const failure = failureBySerial.get(scan.serial.trim().toLowerCase())
                  return (
                    <li
                      key={scan.serial}
                      className={`flex flex-col gap-2 rounded-lg border px-3 py-2 ${
                        failure ? "border-danger/50 bg-danger-soft" : "border-border bg-muted/20"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-mono text-sm">{scan.serial}</p>
                          <p className="text-xs text-muted-foreground truncate">
                            {line
                              ? line.product_name
                              : item
                                ? `${item.name} — not on this request`
                                : "Not found in inventory"}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="shrink-0 text-muted-foreground"
                          disabled={busy}
                          aria-label={`Remove ${scan.serial}`}
                          onClick={() => {
                            setScans((prev) => prev.filter((s) => s.serial !== scan.serial))
                            setResult(null)
                          }}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                      {needsKey ? (
                        <div className="grid gap-1">
                          <Label htmlFor={`ck-${scan.serial}`} className="text-xs text-muted-foreground">
                            Cloud key (required for this product)
                          </Label>
                          <Input
                            id={`ck-${scan.serial}`}
                            value={scan.cloudKey}
                            onChange={(e) =>
                              setScans((prev) =>
                                prev.map((s) => (s.serial === scan.serial ? { ...s, cloudKey: e.target.value } : s))
                              )
                            }
                            className="font-mono bg-card"
                            disabled={busy}
                          />
                        </div>
                      ) : null}
                      {failure ? <p className="text-sm text-danger">{failure}</p> : null}
                    </li>
                  )
                })}
              </ul>
            )}

            {result && !result.ok && result.failures.length > 0 ? (
              <p className="text-sm text-destructive">
                Nothing was issued. Fix the {result.failures.length === 1 ? "scan" : "scans"} marked above and try
                again.
              </p>
            ) : null}

            <div className="flex flex-wrap gap-2 border-t border-border pt-4">
              <Button disabled={busy || scans.length === 0} onClick={() => void onIssue()} className="gap-1">
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Truck className="size-4" />}
                Issue {scans.length || ""} unit{scans.length === 1 ? "" : "s"}
              </Button>
              <Button variant="ghost" asChild disabled={busy}>
                <Link href={`/requests/${request.id}`}>Cancel</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
