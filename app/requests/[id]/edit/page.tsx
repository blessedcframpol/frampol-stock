"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { DashboardShell } from "@/components/dashboard-shell"
import { StockRequestForm } from "@/components/stock-request-form"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/lib/auth-context"
import { ADMIN, canCreateStockRequest } from "@/lib/permissions"
import { getSupabaseClient } from "@/lib/supabase/client"
import { fetchStockRequestById, type StockRequestWithRelations } from "@/lib/supabase/stock-requests-db"
import { ArrowLeft, Loader2 } from "lucide-react"
import { toastFromCaughtError } from "@/lib/toast-reportable-error"

export default function EditStockRequestPage() {
  const params = useParams()
  const id = typeof params?.id === "string" ? params.id : ""
  const { user, role } = useAuth()
  const [row, setRow] = useState<StockRequestWithRelations | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    try {
      const sb = getSupabaseClient()
      const r = await fetchStockRequestById(sb, id)
      setRow(r)
    } catch (e) {
      toastFromCaughtError(e, "Could not load request")
      setRow(null)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

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

  if (!row || !canEdit) {
    return (
      <DashboardShell>
        <div className="flex flex-col gap-4 max-w-lg">
          <Button variant="ghost" size="sm" asChild className="w-fit gap-1">
            <Link href={row ? `/requests/${row.id}` : "/requests"}>
              <ArrowLeft className="size-4" />
              Back
            </Link>
          </Button>
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
      <StockRequestForm mode="edit" initialRequest={row} onCancelHref={`/requests/${row.id}`} />
    </DashboardShell>
  )
}
