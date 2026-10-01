"use client"

import { useEffect, useState } from "react"
import { useAuth } from "@/lib/auth-context"
import { ALERTS_UPDATED_EVENT } from "@/lib/alerts"
import { fetchAlertFeed, type AlertFeed } from "@/lib/alerts-feed"

export function useAlertFeed() {
  const { user, loading: authLoading } = useAuth()
  const [feed, setFeed] = useState<AlertFeed | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [settledKey, setSettledKey] = useState<string | null>(null)
  const requestKey = authLoading ? "auth" : (user?.id ?? "anon")

  useEffect(() => {
    if (authLoading) return
    let cancelled = false
    const request = user ? fetchAlertFeed() : Promise.resolve(null)
    void request
      .then((next) => {
        if (cancelled) return
        setFeed(next)
        setError(null)
      })
      .catch((caught) => {
        if (cancelled) return
        setFeed(null)
        setError(caught instanceof Error ? caught.message : "Could not load alerts")
      })
      .finally(() => {
        if (!cancelled) setSettledKey(requestKey)
      })
    return () => {
      cancelled = true
    }
  }, [authLoading, requestKey, user])

  useEffect(() => {
    if (!user) return
    const onUpdate = () => {
      void fetchAlertFeed()
        .then((next) => {
          setFeed(next)
          setError(null)
        })
        .catch((caught) => {
          setError(caught instanceof Error ? caught.message : "Could not load alerts")
        })
    }
    window.addEventListener(ALERTS_UPDATED_EVENT, onUpdate)
    return () => window.removeEventListener(ALERTS_UPDATED_EVENT, onUpdate)
  }, [user])

  return { feed, loading: settledKey !== requestKey, error }
}
