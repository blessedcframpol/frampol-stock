"use client"

import { usePathname } from "next/navigation"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import {
  fetchInboxNotifications,
  markNotificationsRead,
  type AppNotificationRow,
} from "@/lib/supabase/stock-requests-db"
import { getSupabaseClient } from "@/lib/supabase/client"
import { useAuth } from "@/lib/auth-context"
import {
  announceNotificationsInbox,
  announceRequestQueuesRefresh,
  notificationHref,
  showBrowserNotification,
} from "@/lib/notifications-live"
import {
  alertSoundNeedsGesture,
  isAlertSoundId,
  notificationShouldAlert,
  playAlertSound,
  resumeAlertAudio,
  type AlertSoundId,
} from "@/lib/alert-sounds"
import {
  matchesNotificationChip,
  type NotificationChip,
} from "@/lib/notification-categories"

export type { AppNotificationRow }

const POLL_MS = 60_000
const INBOX_OPENED_KEY = "fram-stock.inbox.last-opened-at"

function getSb() {
  try {
    return getSupabaseClient()
  } catch {
    return null
  }
}

function readOpenedAt(): string | null {
  try {
    return window.localStorage.getItem(INBOX_OPENED_KEY)
  } catch {
    return null
  }
}

function writeOpenedAt(iso: string) {
  try {
    window.localStorage.setItem(INBOX_OPENED_KEY, iso)
  } catch {
    // ignore
  }
}

export type AlertSoundPrefs = {
  enabled: boolean
  soundId: AlertSoundId
  volume: number
}

const DEFAULT_ALERT: AlertSoundPrefs = {
  enabled: false,
  soundId: "chime",
  volume: 0.55,
}

export function useInboxNotifications(): {
  items: AppNotificationRow[]
  unread: AppNotificationRow[]
  count: number
  loading: boolean
  chip: NotificationChip
  setChip: (chip: NotificationChip) => void
  chipCounts: Record<NotificationChip, number>
  filteredItems: AppNotificationRow[]
  inboxOpenedAt: string | null
  markInboxOpened: () => void
  isNewSinceOpen: (row: AppNotificationRow) => boolean
  needsSoundGesture: boolean
  enableSoundGesture: () => Promise<void>
  alertPrefs: AlertSoundPrefs
  refetch: () => Promise<void>
  markRead: (ids: string[]) => Promise<void>
  /** @deprecated local mute — kept for issue-scan feedback until callers migrate */
  muted: boolean
  setMuted: (muted: boolean) => void
} {
  const pathname = usePathname()
  const { user } = useAuth()
  const [items, setItems] = useState<AppNotificationRow[]>([])
  const [loading, setLoading] = useState(true)
  const [chip, setChip] = useState<NotificationChip>("all")
  const [inboxOpenedAt, setInboxOpenedAt] = useState<string | null>(null)
  const [needsSoundGesture, setNeedsSoundGesture] = useState(false)
  const [alertPrefs, setAlertPrefs] = useState<AlertSoundPrefs>(DEFAULT_ALERT)
  const previousIds = useRef<Set<string> | null>(null)

  useEffect(() => {
    setInboxOpenedAt(readOpenedAt())
  }, [])

  const loadAlertPrefs = useCallback(async () => {
    const sb = getSb()
    if (!sb || !user?.id) {
      setAlertPrefs(DEFAULT_ALERT)
      return
    }
    const { data, error } = await sb
      .from("profiles")
      .select("alert_sound_enabled, alert_sound_id, alert_sound_volume")
      .eq("id", user.id)
      .maybeSingle()
    if (error || !data) {
      setAlertPrefs(DEFAULT_ALERT)
      return
    }
    const rawSoundId = data.alert_sound_id ?? ""
    const soundId = isAlertSoundId(rawSoundId) ? rawSoundId : DEFAULT_ALERT.soundId
    setAlertPrefs({
      enabled: data.alert_sound_enabled === true,
      soundId,
      volume: Number(data.alert_sound_volume ?? DEFAULT_ALERT.volume),
    })
  }, [user?.id])

  const refetch = useCallback(async () => {
    const sb = getSb()
    if (!sb || !user?.id) {
      setItems([])
      setLoading(false)
      return
    }
    try {
      const rows = await fetchInboxNotifications(sb, 40)
      setItems(rows)
    } catch {
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [user?.id])

  useEffect(() => {
    void refetch()
    void loadAlertPrefs()
  }, [pathname, refetch, loadAlertPrefs])

  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void refetch()
    }, POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === "visible") void refetch()
    }
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("focus", onVisible)
    return () => {
      window.clearInterval(id)
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("focus", onVisible)
    }
  }, [refetch])

  useEffect(() => {
    const sb = getSb()
    const uid = user?.id
    if (!sb || !uid) return

    const channel = sb
      .channel(`notifications:${uid}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${uid}`,
        },
        () => {
          void refetch()
          announceRequestQueuesRefresh()
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${uid}`,
        },
        () => {
          void refetch()
        },
      )
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          void refetch()
        }
      })

    return () => {
      void sb.removeChannel(channel)
    }
  }, [user?.id, refetch])

  const unread = useMemo(() => items.filter((r) => !r.read_at), [items])
  const count = unread.length

  const chipCounts = useMemo(() => {
    const base: Record<NotificationChip, number> = {
      all: items.length,
      requests: 0,
      fulfilment: 0,
      other: 0,
    }
    for (const row of items) {
      if (matchesNotificationChip(row.type, "requests")) base.requests += 1
      else if (matchesNotificationChip(row.type, "fulfilment")) base.fulfilment += 1
      else base.other += 1
    }
    return base
  }, [items])

  const filteredItems = useMemo(
    () => items.filter((row) => matchesNotificationChip(row.type, chip)),
    [items, chip],
  )

  const isNewSinceOpen = useCallback(
    (row: AppNotificationRow) => {
      if (!inboxOpenedAt) return !row.read_at
      return new Date(row.created_at).getTime() > new Date(inboxOpenedAt).getTime()
    },
    [inboxOpenedAt],
  )

  const markInboxOpened = useCallback(() => {
    const iso = new Date().toISOString()
    writeOpenedAt(iso)
    setInboxOpenedAt(iso)
  }, [])

  const enableSoundGesture = useCallback(async () => {
    const ok = await resumeAlertAudio()
    setNeedsSoundGesture(!ok)
  }, [])

  // Toast + optional alert sound + browser notif on newly seen unread rows.
  useEffect(() => {
    if (loading) return
    const unreadIds = new Set(unread.map((r) => r.id))
    const prev = previousIds.current
    previousIds.current = unreadIds
    if (prev === null) return
    const added = unread.filter((r) => !prev.has(r.id))
    if (added.length === 0) return

    const alertRows = added.filter((r) =>
      notificationShouldAlert(
        r.type,
        (r.metadata as Record<string, unknown> | null) ?? null,
      ),
    )

    void (async () => {
      if (alertPrefs.enabled && alertRows.length > 0) {
        if (alertSoundNeedsGesture()) {
          setNeedsSoundGesture(true)
        } else {
          const result = await playAlertSound(alertPrefs.soundId, alertPrefs.volume)
          if (result === "needs_gesture") setNeedsSoundGesture(true)
        }
      }
    })()

    for (const row of added.slice(0, 3)) {
      toast.message(row.title, { description: row.body ?? undefined })
      showBrowserNotification(row.title, row.body ?? undefined, notificationHref(row))
    }
    announceNotificationsInbox()
    announceRequestQueuesRefresh()
  }, [unread, loading, alertPrefs])

  const markRead = useCallback(
    async (ids: string[]) => {
      const sb = getSb()
      if (!sb || ids.length === 0) return
      await markNotificationsRead(sb, ids)
      await refetch()
    },
    [refetch],
  )

  // Legacy mute shim for issue-scan (local only).
  const [muted, setMuted] = useState(false)

  return {
    items,
    unread,
    count,
    loading,
    chip,
    setChip,
    chipCounts,
    filteredItems,
    inboxOpenedAt,
    markInboxOpened,
    isNewSinceOpen,
    needsSoundGesture,
    enableSoundGesture,
    alertPrefs,
    refetch,
    markRead,
    muted,
    setMuted,
  }
}

/** @deprecated Prefer profile alert prefs; kept for issue-scan feedback. */
export function useNotificationsMuted(): {
  muted: boolean
  setMuted: (muted: boolean) => void
} {
  const [muted, setMuted] = useState(false)
  return { muted, setMuted }
}
