"use client"

import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import { AlertCircle, BellRing, Loader2 } from "lucide-react"
import { EmptyState } from "@/components/fs/empty-state"
import { PageHeader } from "@/components/page-nav"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { useInboxNotifications } from "@/hooks/use-inbox-notifications"
import { getSupabaseClient } from "@/lib/supabase/client"
import { fetchAllNotifications, type AppNotificationRow } from "@/lib/supabase/stock-requests-db"
import { cn } from "@/lib/utils"

function notificationHref(n: AppNotificationRow): string {
  const meta = n.metadata as { request_id?: string; href?: string } | null
  if (typeof meta?.href === "string" && meta.href.startsWith("/") && !meta.href.startsWith("//")) {
    return meta.href
  }
  if (meta?.request_id) return `/requests/${meta.request_id}`
  return n.type === "pending_role" ? "/users" : "/requests"
}

function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
}

/** Everything the portal has told this user, newest first. */
export function NotificationsContent() {
  const { markRead } = useInboxNotifications()
  const [rows, setRows] = useState<AppNotificationRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setRows(await fetchAllNotifications(getSupabaseClient(), 50))
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load notifications")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void fetchAllNotifications(getSupabaseClient(), 50)
      .then((data) => {
        if (cancelled) return
        setRows(data)
        setError(null)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load notifications")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const unreadIds = rows.filter((r) => !r.read_at).map((r) => r.id)

  async function markIds(ids: string[]) {
    if (ids.length === 0) return
    try {
      await markRead(ids)
      await load()
    } catch {
      // The list stays as is; the next load shows the true state.
    }
  }

  return (
    <div className="flex max-w-3xl min-w-0 flex-col gap-4 md:gap-6">
      <PageHeader
        title="Notifications"
        description="Messages about your requests and account."
        icon={BellRing}
        actions={
          unreadIds.length > 0 ? (
            <Button type="button" variant="outline" className="min-h-11 sm:min-h-9" onClick={() => void markIds(unreadIds)}>
              Mark all read
            </Button>
          ) : null
        }
      />

      {error ? (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          <AlertCircle className="size-5 shrink-0" />
          <p>{error}</p>
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
          Loading notifications…
        </div>
      ) : rows.length === 0 ? (
        <EmptyState message="No notifications yet." />
      ) : (
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {rows.map((n) => (
                <li key={n.id}>
                  <Link
                    href={notificationHref(n)}
                    onClick={() => {
                      if (!n.read_at) void markRead([n.id])
                    }}
                    className="flex min-h-11 flex-col gap-0.5 px-4 py-3 text-sm hover:bg-muted/60"
                  >
                    <span className="flex items-start justify-between gap-3">
                      <span className={cn("text-foreground", !n.read_at && "font-semibold")}>
                        {!n.read_at ? (
                          <span className="mr-2 inline-block size-2 rounded-full bg-brand align-middle" aria-label="Unread" />
                        ) : null}
                        {n.title}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">{formatWhen(n.created_at)}</span>
                    </span>
                    {n.body ? <span className="text-xs text-muted-foreground">{n.body}</span> : null}
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
