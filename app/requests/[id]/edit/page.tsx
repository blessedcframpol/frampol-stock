"use client"

import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import { DashboardShell } from "@/components/dashboard-shell"
import { StockRequestForm } from "@/components/stock-request-form"
import { useAuth } from "@/lib/auth-context"
import { ADMIN, canCreateStockRequest } from "@/lib/permissions"
import { getSupabaseClient } from "@/lib/supabase/client"
import { fetchStockRequestById, type StockRequestWithRelations } from "@/lib/supabase/stock-requests-db"
import { Loader2 } from "lucide-react"
import { PageBackLink } from "@/components/page-nav"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"
import {
  isAuthFailure,
  loadErrorFromCaught,
  notifySessionExpired,
  signedOutLoadError,
} from "@/lib/unauthorized"

export default function EditStockRequestPage() {
  const params = useParams()
  const id = typeof params?.id === "string" ? params.id : ""
  const { user, role } = useAuth()
  const [row, setRow] = useState<StockRequestWithRelations | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadedForId, setLoadedForId] = useState(id)
  if (id !== loadedForId) {
    setLoadedForId(id)
    setLoading(true)
    setLoadError(null)
    setRow(null)
  }

  useEffect(() => {
    if (!id) return
    let cancelled = false
    void (async () => {
      try {
        const sb = getSupabaseClient()
        const r = await fetchStockRequestById(sb, id)
        if (cancelled) return
        if (!r) {
          const sessionErr = await signedOutLoadError(sb)
          if (cancelled) return
          if (sessionErr) {
            setLoadError(sessionErr)
            setRow(null)
            return
          }
        }
        setLoadError(null)
        setRow(r)
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
  }, [id])

  const isOwner = Boolean(user?.id && row?.created_by === user.id)
  const canEdit = row?.status === "draft" && (isOwner || role === ADMIN) && canCreateStockRequest(role)

  if (!id) {
    return (
      <DashboardShell>
        <p className="text-sm text-muted-foreground">Invalid request.</p>
      </DashboardShell>
    )
  }

  if (loading) {
    return (
      <DashboardShell>
        <div className="flex items-center justify-center py-20 text-muted-foreground gap-2">
          <Loader2 className="size-5 animate-spin" />
          Loading…
        </div>
      </DashboardShell>
    )
  }

  if (loadError) {
    return (
      <DashboardShell>
        <div className="flex flex-col gap-4 max-w-lg">
          <PageBackLink href="/requests" />
          <p role="alert" className="text-sm text-destructive">
            {loadError}
          </p>
        </div>
      </DashboardShell>
    )
  }

  if (!row || !canEdit) {
    return (
      <DashboardShell>
        <div className="flex flex-col gap-4 max-w-lg">
          <PageBackLink href={row ? `/requests/${row.id}` : "/requests"} />
          <p className="text-sm text-muted-foreground">
            {!row
              ? "Request not found or you don’t have access."
              : "Only draft requests from the owner can be edited here."}
          </p>
        </div>
      </DashboardShell>
    )
  }

  return (
    <DashboardShell>
      <StockRequestForm
        key={row.id}
        mode="edit"
        initialRequest={row}
        onCancelHref={`/requests/${row.id}`}
      />
    </DashboardShell>
  )
}
