"use client"

import { PageHeader } from "@/components/page-nav"
import {
  MovementForm,
  type StockMovementEmbedMode,
} from "@/components/movement-form"
import { useAuth } from "@/lib/auth-context"
import { canRecordStockMovement } from "@/lib/permissions"

export type { StockMovementEmbedMode }

export function StockMovementContent({
  embedMode,
  prefillType,
  prefillSerials,
}: {
  embedMode?: StockMovementEmbedMode
  /** Query-param prefill from Alerts. Does not skip movement validation. */
  prefillType?: string
  prefillSerials?: string
}) {
  const isEmbed = Boolean(embedMode)
  const { role, loading: authLoading } = useAuth()
  const canMove = canRecordStockMovement(role)

  if (authLoading) {
    return (
      <div className="flex flex-col gap-4 md:gap-6 min-w-0">
        {!isEmbed && (
          <PageHeader
            title="Inventory Movement"
            description="Record inbound and outbound (sale, POC, rental, transfer) stock transactions."
          />
        )}
        <p className="text-sm text-muted-foreground">Checking access…</p>
      </div>
    )
  }

  if (!canMove) {
    return (
      <div className="flex flex-col gap-4 md:gap-6 min-w-0">
        {!isEmbed && (
          <PageHeader
            title="Inventory Movement"
            description="Record inbound and outbound (sale, POC, rental, transfer) stock transactions."
          />
        )}
        <p className="text-sm text-muted-foreground">
          You do not have permission to record stock movements. Only admins and technicians can use this
          page.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 md:gap-6 min-w-0">
      {!isEmbed && (
        <PageHeader
          title="Inventory Movement"
          description="Record inbound and outbound (sale, POC, rental, transfer) stock transactions."
        />
      )}
      <MovementForm
        layout="full"
        source="movement_page"
        embedMode={embedMode}
        prefillType={prefillType}
        prefillSerials={prefillSerials}
      />
    </div>
  )
}
