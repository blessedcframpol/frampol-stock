"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useAuth } from "@/lib/auth-context"
import { getSupabaseClient } from "@/lib/supabase/client"
import {
  assignSerialToLine,
  fetchAssignedCountsByLineId,
  fetchInventoryItemsForAssignment,
  fetchStockRequestById,
  markRequestServiced,
  releaseSerialFromLine,
  type StockRequestWithRelations,
} from "@/lib/supabase/stock-requests-db"
import type { InventoryItem } from "@/lib/data"
import { formatDateDDMMYYYY } from "@/lib/utils"
import { toast } from "sonner"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"
import { ArrowLeft, CheckCircle2, Loader2, Unlink } from "lucide-react"

export function StockRequestFulfill({ requestId }: { requestId: string }) {
  const router = useRouter()
  const { profile } = useAuth()
  const [row, setRow] = useState<StockRequestWithRelations | null>(null)
  const [assigned, setAssigned] = useState<Record<string, number>>({})
  const [poolByLine, setPoolByLine] = useState<Record<string, InventoryItem[]>>({})
  const [loading, setLoading] = useState(true)
  const [busyLine, setBusyLine] = useState<string | null>(null)
  const [servicing, setServicing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const sb = getSupabaseClient()
      const r = await fetchStockRequestById(sb, requestId)
      setRow(r)
      if (!r?.stock_request_lines?.length) {
        setAssigned({})
        setPoolByLine({})
        return
      }
      const lineIds = r.stock_request_lines.map((l) => l.id)
      const asg = await fetchAssignedCountsByLineId(sb, lineIds)
      setAssigned(asg)

      const pools: Record<string, InventoryItem[]> = {}
      for (const line of r.stock_request_lines) {
        const items = await fetchInventoryItemsForAssignment(sb, line.product_name)
        pools[line.id] = items.filter(
          (it) =>
            !it.reservedForRequestLineId || it.reservedForRequestLineId === line.id
        )
      }
      setPoolByLine(pools)
    } catch (e) {
      toastFromCaughtError(e, "Could not load request")
      setRow(null)
    } finally {
      setLoading(false)
    }
  }, [requestId])

  useEffect(() => {
    void load()
  }, [load])

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

  async function onAssign(lineId: string, inventoryItemId: string) {
    setBusyLine(lineId)
    try {
      const sb = getSupabaseClient()
      await assignSerialToLine(sb, lineId, inventoryItemId)
      toast.success("Serial assigned.")
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
    if (!row) return
    setServicing(true)
    try {
      const sb = getSupabaseClient()
      await markRequestServiced(sb, row.id, profile?.email ?? null)
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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground gap-2">
        <Loader2 className="size-5 animate-spin" />
        Loading…
      </div>
    )
  }

  if (!row) {
    return (
      <div className="flex flex-col gap-4">
        <Button variant="ghost" size="sm" asChild className="w-fit gap-1">
          <Link href="/requests">
            <ArrowLeft className="size-4" />
            Requests
          </Link>
        </Button>
        <p className="text-sm text-muted-foreground">Request not found or not open for fulfillment.</p>
      </div>
    )
  }

  if (row.status !== "submitted" && row.status !== "in_progress") {
    return (
      <div className="flex flex-col gap-4 max-w-xl">
        <Button variant="ghost" size="sm" asChild className="w-fit gap-1">
          <Link href={`/requests/${row.id}`}>
            <ArrowLeft className="size-4" />
            Request detail
          </Link>
        </Button>
        <p className="text-sm text-muted-foreground">
          This request is not in a fulfillment state (current: {row.status}). Open the request overview for next steps.
        </p>
      </div>
    )
  }

  const canMarkServiced = row.status === "in_progress" || row.status === "submitted"

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" asChild className="shrink-0 -ml-2 gap-1">
          <Link href={`/requests/${row.id}`}>
            <ArrowLeft className="size-4" />
            Back
          </Link>
        </Button>
        <div>
          <h1 className="text-xl font-bold tracking-tight">Fulfill request</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {row.client ? `${row.client.name} — ${row.client.company}` : row.client_id} · {formatDateDDMMYYYY(row.created_at)}
          </p>
        </div>
      </div>

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
                  <Badge variant="secondary" className="text-[10px]">
                    {count >= cap ? "Line full" : "Open"}
                  </Badge>
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

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={!canMarkServiced || servicing}
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
    </div>
  )
}
