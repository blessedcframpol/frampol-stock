"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { StatusPill } from "@/components/fs/status-pill"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useAuth } from "@/lib/auth-context"
import { getSupabaseClient } from "@/lib/supabase/client"
import { formatClientLabel } from "@/lib/client-label"
import {
  assignSerialToLine,
  fetchAssignedCountsByLineId,
  fetchInventoryItemsForAssignmentByProductIds,
  fetchStockRequestById,
  markRequestServiced,
  releaseSerialFromLine,
  type StockRequestWithRelations,
} from "@/lib/supabase/stock-requests-db"
import {
  linesBlockingServiced,
  servicedBlockedReason,
} from "@/lib/stock-request-rules"
import {
  allowedTransitions,
  isStockRequestStatus,
  type StockRequestStatus,
} from "@/lib/stock-request-statuses"
import type { InventoryItem } from "@/lib/data"
import { formatDateDDMMYYYY } from "@/lib/utils"
import { toast } from "sonner"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"
import {
  isAuthFailure,
  loadErrorFromCaught,
  notifySessionExpired,
  signedOutLoadError,
} from "@/lib/unauthorized"
import { CheckCircle2, Loader2, Unlink } from "lucide-react"
import { PageHeader } from "@/components/page-nav"
import { PageBreadcrumbs } from "@/components/page-breadcrumbs"
import { canFulfillStockRequests } from "@/lib/permissions"

export function StockRequestFulfill({ requestId }: { requestId: string }) {
  const router = useRouter()
  const { user, role, profile } = useAuth()
  const canFulfill = canFulfillStockRequests(role)
  const [row, setRow] = useState<StockRequestWithRelations | null>(null)
  const [assigned, setAssigned] = useState<Record<string, number>>({})
  const [poolByLine, setPoolByLine] = useState<Record<string, InventoryItem[]>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyLine, setBusyLine] = useState<string | null>(null)
  const [servicing, setServicing] = useState(false)
  const [loadedForId, setLoadedForId] = useState(requestId)
  if (requestId !== loadedForId) {
    setLoadedForId(requestId)
    setLoading(true)
    setLoadError(null)
    setRow(null)
    setAssigned({})
    setPoolByLine({})
  }

  const fetchRequestBundle = useCallback(async () => {
    const sb = getSupabaseClient()
    const r = await fetchStockRequestById(sb, requestId)
    if (!r?.stock_request_lines?.length) {
      return {
        r,
        assigned: {} as Record<string, number>,
        poolByLine: {} as Record<string, InventoryItem[]>,
      }
    }
    const lineIds = r.stock_request_lines.map((l) => l.id)
    const asg = await fetchAssignedCountsByLineId(sb, lineIds)
    const productIds = [...new Set(r.stock_request_lines.map((l) => l.product_id).filter(Boolean))]
    const items = await fetchInventoryItemsForAssignmentByProductIds(sb, productIds)
    const byProductId = new Map<string, InventoryItem[]>()
    for (const it of items) {
      if (!it.productId) continue
      const list = byProductId.get(it.productId) ?? []
      list.push(it)
      byProductId.set(it.productId, list)
    }
    const pools: Record<string, InventoryItem[]> = {}
    for (const line of r.stock_request_lines) {
      const forProduct = byProductId.get(line.product_id) ?? []
      pools[line.id] = forProduct.filter(
        (it) => !it.reservedForRequestLineId || it.reservedForRequestLineId === line.id
      )
    }
    return { r, assigned: asg, poolByLine: pools }
  }, [requestId])

  const load = useCallback(async () => {
    try {
      const bundle = await fetchRequestBundle()
      if (!bundle.r) {
        const sessionErr = await signedOutLoadError(getSupabaseClient())
        if (sessionErr) {
          setLoadError(sessionErr)
          setRow(null)
          return
        }
      }
      setLoadError(null)
      setRow(bundle.r)
      setAssigned(bundle.assigned)
      setPoolByLine(bundle.poolByLine)
    } catch (e) {
      if (isAuthFailure(e)) notifySessionExpired()
      else toastFromCaughtError(e, "Could not load request")
      setLoadError(loadErrorFromCaught(e, "Could not load this request."))
      setRow(null)
    } finally {
      setLoading(false)
    }
  }, [fetchRequestBundle])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const bundle = await fetchRequestBundle()
        if (cancelled) return
        if (!bundle.r) {
          const sessionErr = await signedOutLoadError(getSupabaseClient())
          if (cancelled) return
          if (sessionErr) {
            setLoadError(sessionErr)
            setRow(null)
            return
          }
        }
        setLoadError(null)
        setRow(bundle.r)
        setAssigned(bundle.assigned)
        setPoolByLine(bundle.poolByLine)
      } catch (e) {
        if (!cancelled) {
          if (isAuthFailure(e)) notifySessionExpired()
          else toastFromCaughtError(e, "Could not load request")
          setLoadError(loadErrorFromCaught(e, "Could not load this request."))
          setRow(null)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [fetchRequestBundle])

  const assignmentsByLine = useMemo(() => {
    const m: Record<string, InventoryItem[]> = {}
    if (!row) return m
    for (const line of row.stock_request_lines ?? []) {
      m[line.id] = []
    }
    for (const line of row.stock_request_lines ?? []) {
      const items = poolByLine[line.id] ?? []
      for (const it of items) {
        if (it.reservedForRequestLineId === line.id) {
          m[line.id] = [...(m[line.id] ?? []), it]
        }
      }
    }
    return m
  }, [row, poolByLine])

  const status: StockRequestStatus | null =
    row && isStockRequestStatus(row.status) ? row.status : null
  const isOwner = Boolean(user?.id && row?.created_by === user.id)
  const transitions = status ? allowedTransitions(status, role, isOwner) : []
  const canMarkServiced = transitions.includes("serviced")
  const blocking = useMemo(
    () => linesBlockingServiced(row?.stock_request_lines ?? [], assigned),
    [row, assigned]
  )
  const blockedReason = servicedBlockedReason(blocking)
  const servicedDisabled = servicing || blocking.length > 0

  async function onAssign(lineId: string, inventoryItemId: string) {
    setBusyLine(lineId)
    try {
      const sb = getSupabaseClient()
      await assignSerialToLine(sb, lineId, inventoryItemId)
      toast.success("Serial assigned.")
      // load() re-fetches request — picks up auto-promote submitted → in_progress from 049
      await load()
      router.refresh()
    } catch (e) {
      toastFromCaughtError(e, "Could not assign serial")
    } finally {
      setBusyLine(null)
    }
  }

  async function onRelease(inventoryItemId: string) {
    setBusyLine(inventoryItemId)
    try {
      const sb = getSupabaseClient()
      await releaseSerialFromLine(sb, inventoryItemId)
      toast.success("Reservation released.")
      await load()
      router.refresh()
    } catch (e) {
      toastFromCaughtError(e, "Could not release serial")
    } finally {
      setBusyLine(null)
    }
  }

  async function onMarkServiced() {
    if (!row || !status || !canMarkServiced || blocking.length > 0) return
    if (status !== "submitted" && status !== "in_progress") return
    setServicing(true)
    try {
      const sb = getSupabaseClient()
      await markRequestServiced(sb, row.id, profile?.email ?? null, status)
      toast.success("Request marked serviced. Sales has been notified.")
      await load()
      router.push(`/requests/${row.id}`)
      router.refresh()
    } catch (e) {
      toastFromCaughtError(e, "Could not mark serviced")
    } finally {
      setServicing(false)
    }
  }

  if (!canFulfill) {
    return (
      <div className="flex flex-col gap-4">
        <PageBreadcrumbs
          items={[
            { label: "Requests", href: "/requests" },
            { label: requestId, href: `/requests/${requestId}` },
            { label: "Fulfill" },
          ]}
        />
        <p className="text-sm text-muted-foreground">
          Your account has read-only access to stock requests.
        </p>
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
        <PageBreadcrumbs items={[{ label: "Requests", href: "/requests" }, { label: requestId }]} />
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
      </div>
    )
  }

  if (!row) {
    return (
      <div className="flex flex-col gap-4">
        <PageBreadcrumbs items={[{ label: "Requests", href: "/requests" }, { label: requestId }]} />
        <p className="text-sm text-muted-foreground">Request not found or you don’t have access.</p>
      </div>
    )
  }

  if (row.status !== "submitted" && row.status !== "in_progress") {
    return (
      <div className="flex flex-col gap-4 max-w-xl">
        <PageBreadcrumbs
          items={[
            { label: "Requests", href: "/requests" },
            { label: row.id, href: `/requests/${row.id}` },
            { label: "Fulfill" },
          ]}
        />
        <p className="text-sm text-muted-foreground">
          This request is not in a fulfillment state (current: {row.status}). Open the request overview for next steps.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <PageHeader
        title="Fulfill request"
        description={`${row.client ? formatClientLabel(row.client) : row.client_id} · ${formatDateDDMMYYYY(row.created_at)} · ${row.status.replace("_", " ")}`}
      />
      <PageBreadcrumbs
        items={[
          { label: "Requests", href: "/requests" },
          { label: row.id, href: `/requests/${row.id}` },
          { label: "Fulfill" },
        ]}
      />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Assign serials by line</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {(row.stock_request_lines ?? []).map((line) => {
            const count = assigned[line.id] ?? 0
            const cap = line.quantity_requested
            const assignedItems = assignmentsByLine[line.id] ?? []
            const pool = poolByLine[line.id] ?? []
            const pickable = pool.filter((it) => !it.reservedForRequestLineId)
            const selectDisabled = count >= cap || pickable.length === 0 || busyLine === line.id

            return (
              <div key={line.id} className="rounded-lg border border-border p-4 space-y-3 bg-muted/10">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-medium text-sm">{line.product_name}</p>
                    <p className="text-xs text-muted-foreground">Need {cap} · assigned {count}</p>
                  </div>
                  <StatusPill value={count >= cap ? "Line full" : "Open"} />
                </div>

                {assignedItems.length > 0 && (
                  <ul className="text-xs space-y-1">
                    {assignedItems.map((it) => (
                      <li key={it.id} className="flex items-center justify-between gap-2 py-1 border-b border-border/60 last:border-0">
                        <span className="font-mono">{it.serialNumber}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 gap-1 text-xs"
                          disabled={busyLine !== null}
                          onClick={() => void onRelease(it.id)}
                        >
                          <Unlink className="size-3" />
                          Release
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <div className="flex-1 min-w-0">
                    <label className="text-xs text-muted-foreground block mb-1">Add serial from free pool</label>
                    <Select
                      key={`${line.id}-${count}`}
                      disabled={selectDisabled}
                      onValueChange={(id) => {
                        if (id) void onAssign(line.id, id)
                      }}
                    >
                      <SelectTrigger className="bg-card">
                        <SelectValue placeholder={pickable.length === 0 ? "No free units" : "Choose serial…"} />
                      </SelectTrigger>
                      <SelectContent>
                        {pickable.map((it) => (
                          <SelectItem key={it.id} value={it.id}>
                            {it.serialNumber}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            )
          })}
        </CardContent>
      </Card>

      {canMarkServiced ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2 items-center">
            <Button
              type="button"
              disabled={servicedDisabled}
              onClick={() => void onMarkServiced()}
              className="gap-2"
            >
              {servicing ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
              Mark serviced
            </Button>
            <p className="text-xs text-muted-foreground w-full sm:w-auto sm:self-center">
              Notifies the request owner in-app (email stub unless configured).
            </p>
          </div>
          {blocking.length > 0 ? (
            <p className="text-sm text-warning">{blockedReason}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
