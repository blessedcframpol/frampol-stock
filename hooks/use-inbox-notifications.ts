"use client"

import { usePathname } from "next/navigation"
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import {
  fetchUnreadNotifications,
  markNotificationsRead,
  type AppNotificationRow,
} from "@/lib/supabase/stock-requests-db"
import { getSupabaseClient } from "@/lib/supabase/client"

export type { AppNotificationRow }

export const NOTIFICATIONS_MUTE_KEY = "fram-stock.notifications.mute"
const MUTE_EVENT = "fram-stock:notifications-mute"
const POLL_MS = 60_000

function getSb() {
  try {
    return getSupabaseClient()
  } catch {
    return null
  }
}

function readMuted(): boolean {
  try {
    return window.localStorage.getItem(NOTIFICATIONS_MUTE_KEY) === "1"
  } catch {
    return false
  }
}

function subscribeMuted(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === NOTIFICATIONS_MUTE_KEY) onChange()
  }
  window.addEventListener("storage", onStorage)
  window.addEventListener(MUTE_EVENT, onChange)
  return () => {
    window.removeEventListener("storage", onStorage)
    window.removeEventListener(MUTE_EVENT, onChange)
  }
}

/** One short two-tone beep. Browsers may refuse before the first user gesture; that is fine. */
export function playNotificationBeep(): void {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const gain = ctx.createGain()
    gain.connect(ctx.destination)
    const now = ctx.currentTime
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.15, now + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32)
    for (const [offset, freq] of [
      [0, 880],
      [0.15, 1175],
    ] as const) {
      const osc = ctx.createOscillator()
      osc.type = "sine"
      osc.frequency.value = freq
      osc.connect(gain)
      osc.start(now + offset)
      osc.stop(now + offset + 0.16)
    }
    window.setTimeout(() => void ctx.close().catch(() => undefined), 600)
  } catch {
    // No audio available.
  }
}

export function useNotificationsMuted(): { muted: boolean; setMuted: (muted: boolean) => void } {
  const muted = useSyncExternalStore(subscribeMuted, readMuted, () => false)
  const setMuted = useCallback((next: boolean) => {
    try {
      if (next) window.localStorage.setItem(NOTIFICATIONS_MUTE_KEY, "1")
      else window.localStorage.removeItem(NOTIFICATIONS_MUTE_KEY)
    } catch {
      // Storage unavailable: the toggle simply does not persist.
    }
    window.dispatchEvent(new Event(MUTE_EVENT))
  }, [])
  return { muted, setMuted }
}

export function useInboxNotifications(): {
  unread: AppNotificationRow[]
  count: number
  loading: boolean
  muted: boolean
  setMuted: (muted: boolean) => void
  refetch: () => Promise<void>
  markRead: (ids: string[]) => Promise<void>
} {
  const pathname = usePathname()
  const [unread, setUnread] = useState<AppNotificationRow[]>([])
  const [loading, setLoading] = useState(true)
  const { muted, setMuted } = useNotificationsMuted()
  const previousCount = useRef<number | null>(null)

  const refetch = useCallback(async () => {
    const sb = getSb()
    if (!sb) {
      await Promise.resolve()
      setUnread([])
      setLoading(false)
      return
    }
    try {
      const rows = await fetchUnreadNotifications(sb)
      setUnread(rows)
    } catch {
      setUnread([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const sb = getSb()
      if (!sb) {
        await Promise.resolve()
        if (!cancelled) {
          setUnread([])
          setLoading(false)
        }
        return
      }
      try {
        const rows = await fetchUnreadNotifications(sb)
        if (!cancelled) setUnread(rows)
      } catch {
        if (!cancelled) setUnread([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pathname])

  // New messages arrive while the page is open, so keep checking.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void refetch()
    }, POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === "visible") void refetch()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      window.clearInterval(id)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [refetch])

  // Beep once per increase. The first load only records the baseline.
  const count = unread.length
  useEffect(() => {
    if (loading) return
    const previous = previousCount.current
    previousCount.current = count
    if (previous !== null && count > previous && !muted) playNotificationBeep()
  }, [count, loading, muted])

  const markRead = useCallback(async (ids: string[]) => {
    const sb = getSb()
    if (!sb || ids.length === 0) return
    await markNotificationsRead(sb, ids)
    await refetch()
  }, [refetch])

  return { unread, count, loading, muted, setMuted, refetch, markRead }
}
