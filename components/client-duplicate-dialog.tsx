"use client"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { formatClientLabel } from "@/lib/client-label"
import type { ClientDuplicateMatch } from "@/lib/client-complete"

type Props = {
  open: boolean
  matches: ClientDuplicateMatch[]
  isAdmin: boolean
  forceReason: string
  onForceReason: (value: string) => void
  onUseExisting: (id: string) => void
  onCreateAnyway: () => void
  onCancel: () => void
  busy?: boolean
}

export function ClientDuplicateDialog({
  open,
  matches,
  isAdmin,
  forceReason,
  onForceReason,
  onUseExisting,
  onCreateAnyway,
  onCancel,
  busy,
}: Props) {
  const canForce = isAdmin && forceReason.trim().length >= 10

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent
        className="z-[60] sm:max-w-lg max-h-[85vh] flex flex-col gap-4"
        overlayClassName="z-[60] bg-black/60"
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>Similar client already exists</DialogTitle>
          <DialogDescription>
            Check whether this is the same customer before creating another record.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-2 text-sm min-h-0 max-h-48 overflow-y-auto">
          {matches.map((m) => (
            <li key={m.id} className="rounded-lg border border-border px-3 py-2">
              <p className="font-medium">{formatClientLabel({ name: m.name, company: m.company ?? "" })}</p>
              <p className="text-muted-foreground text-xs mt-0.5">
                Matched on {m.match_on.join(", ")} · {m.email}
                {m.phone ? ` · ${m.phone}` : ""}
              </p>
              <Button
                type="button"
                size="sm"
                className="mt-2"
                disabled={busy}
                onClick={() => onUseExisting(m.id)}
              >
                Use this client
              </Button>
            </li>
          ))}
        </ul>
        {isAdmin ? (
          <div className="flex flex-col gap-1.5 shrink-0">
            <Label htmlFor="client-force-reason">Why is this a different client?</Label>
            <Textarea
              id="client-force-reason"
              value={forceReason}
              onChange={(e) => onForceReason(e.target.value)}
              rows={2}
              placeholder="Why this is a separate client despite the match"
            />
            <p className="text-xs text-muted-foreground">At least 10 characters.</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground shrink-0">
            If this is a different customer, ask an admin to add them.
          </p>
        )}
        <DialogFooter className="flex-col sm:flex-row gap-2 shrink-0">
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          {isAdmin ? (
            <Button type="button" onClick={onCreateAnyway} disabled={busy || !canForce}>
              Create anyway
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
