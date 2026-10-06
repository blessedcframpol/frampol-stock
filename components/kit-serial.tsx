"use client"

import { useEffect, useState } from "react"
import { KitHistoryPanel } from "@/components/kit-history-panel"
import { fetchKitHistory, fetchKitHistoryBySerial } from "@/lib/kit-history"
import { cn } from "@/lib/utils"

const tagTone: Record<string, string> = {
  Rental: "bg-info-soft text-info",
  Demo: "bg-warning-soft text-warning",
  Decommissioned: "bg-muted text-muted-foreground",
  Resold: "bg-success-soft text-success",
}

export function KitSerial({
  serial,
  itemId,
  className,
}: {
  serial: string
  itemId?: string | null
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [tags, setTags] = useState<string[]>([])
  const [resolvedId, setResolvedId] = useState<string | null>(itemId ?? null)

  useEffect(() => {
    let cancelled = false
    const request = itemId ? fetchKitHistory(itemId) : fetchKitHistoryBySerial(serial)
    void request
      .then((history) => {
        if (cancelled || !history?.found) return
        setTags(history.tags ?? [])
        if (history.item_id) setResolvedId(history.item_id)
      })
      .catch(() => {
        if (!cancelled) setTags([])
      })
    return () => {
      cancelled = true
    }
  }, [itemId, serial])

  if (!serial.trim()) return <span className="text-muted-foreground">—</span>

  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)} onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        className="font-mono text-brand hover:underline"
        aria-label={`Kit history for ${serial}`}
        onClick={() => setOpen(true)}
      >
        {serial}
      </button>
      {tags.map((tag) => (
        <button
          key={tag}
          type="button"
          className={cn(
            "inline-flex shrink-0 items-center rounded-md px-1.5 py-0 text-xs font-medium",
            tagTone[tag] ?? "bg-muted text-muted-foreground",
          )}
          aria-label={`${tag} history for ${serial}`}
          onClick={() => setOpen(true)}
        >
          {tag}
        </button>
      ))}
      {open ? (
        <KitHistoryPanel
          open={open}
          onOpenChange={setOpen}
          itemId={resolvedId ?? itemId}
          serial={serial}
        />
      ) : null}
    </span>
  )
}

export function KitSerialList({ serials }: { serials: string | null | undefined }) {
  const parts = (serials ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return <span className="text-muted-foreground">—</span>
  return (
    <span className="flex flex-col items-start gap-1">
      {parts.map((serial) => (
        <KitSerial key={serial} serial={serial} />
      ))}
    </span>
  )
}
