"use client"

import { useCallback, useEffect, useState } from "react"
import { useAuth } from "@/lib/auth-context"
import {
  ALERTS_UPDATED_EVENT,
  DASHBOARD_REFRESH_EVENT,
} from "@/lib/alerts"
import { REQUEST_QUEUES_REFRESH_EVENT } from "@/lib/notifications-live"
import {
  fetchDashboardSummary,
  type DashboardSummary,
} from "@/lib/dashboard-summary"

export function useDashboardSummary(): {
  summary: DashboardSummary | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
} {
  const { user, loading: authLoading } = useAuth()
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (opts?: { quiet?: boolean }) => {
    if (!user?.id) {
      setSummary(null)
      setLoading(false)
      setError(null)
      return
    }
    // Keep last summary visible on background refresh (PF1c).
    if (!opts?.quiet) setLoading(true)
    try {
      setSummary(await fetchDashboardSummary())
      setError(null)
    } catch (caught) {
      // Keep prior summary when a quiet refresh fails.
      if (!opts?.quiet) setSummary(null)
      setError(caught instanceof Error ? caught.message : "Could not load dashboard summary")
    } finally {
      setLoading(false)
    }
  }, [user?.id])

  useEffect(() => {
    if (authLoading) return
    if (!user?.id) {
      setSummary(null)
      setLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    void fetchDashboardSummary()
      .then((row) => {
        if (cancelled) return
        setSummary(row)
        setError(null)
      })
      .catch((caught) => {
        if (cancelled) return
        setSummary(null)
        setError(caught instanceof Error ? caught.message : "Could not load dashboard summary")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [authLoading, user?.id])

  useEffect(() => {
    if (!user?.id) return
    const onRefresh = () => void refresh({ quiet: true })
    window.addEventListener(DASHBOARD_REFRESH_EVENT, onRefresh)
    window.addEventListener(ALERTS_UPDATED_EVENT, onRefresh)
    window.addEventListener(REQUEST_QUEUES_REFRESH_EVENT, onRefresh)
    return () => {
      window.removeEventListener(DASHBOARD_REFRESH_EVENT, onRefresh)
      window.removeEventListener(ALERTS_UPDATED_EVENT, onRefresh)
      window.removeEventListener(REQUEST_QUEUES_REFRESH_EVENT, onRefresh)
    }
  }, [user?.id, refresh])

  return {
    summary,
    loading,
    error,
    refresh: () => refresh(),
  }
}
