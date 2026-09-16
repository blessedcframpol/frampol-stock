"use client"

import { usePathname } from "next/navigation"
import { useCallback, useEffect, useState } from "react"
import {
  fetchUnreadNotifications,
  markNotificationsRead,
  type AppNotificationRow,
} from "@/lib/supabase/stock-requests-db"
import { getSupabaseClient } from "@/lib/supabase/client"

export type { AppNotificationRow }

function getSb() {
  try {
    return getSupabaseClient()
  } catch {
    return null
  }
}

export function useInboxNotifications(): {
  unread: AppNotificationRow[]
  count: number
  loading: boolean
  refetch: () => Promise<void>
  markRead: (ids: string[]) => Promise<void>
} {
  const pathname = usePathname()
  const [unread, setUnread] = useState<AppNotificationRow[]>([])
  const [loading, setLoading] = useState(true)

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

  const markRead = useCallback(async (ids: string[]) => {
    const sb = getSb()
    if (!sb || ids.length === 0) return
    await markNotificationsRead(sb, ids)
    await refetch()
  }, [refetch])

  return { unread, count: unread.length, loading, refetch, markRead }
}
