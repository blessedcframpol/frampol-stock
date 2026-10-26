"use client"

import { useEffect, useRef } from "react"
import { REQUEST_QUEUES_REFRESH_EVENT } from "@/lib/notifications-live"

const FALLBACK_MS = 60_000

/**
 * Re-run `onRefresh` on request-queue events, window focus, and 60s fallback.
 * Does not listen to the notifications inbox event — NT1 poll/focus must not
 * soft-refetch page lists.
 */
export function useRequestQueuesRefresh(onRefresh: () => void | Promise<void>, enabled = true) {
  const handlerRef = useRef(onRefresh)
  handlerRef.current = onRefresh

  useEffect(() => {
    if (!enabled) return
    let timer: number | undefined

    const run = () => {
      void handlerRef.current()
    }

    const schedule = () => {
      if (timer) window.clearInterval(timer)
      timer = window.setInterval(run, FALLBACK_MS)
    }

    run()
    schedule()

    const onQueues = () => run()
    const onFocus = () => {
      if (document.visibilityState === "visible") run()
    }

    window.addEventListener(REQUEST_QUEUES_REFRESH_EVENT, onQueues)
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onFocus)

    return () => {
      if (timer) window.clearInterval(timer)
      window.removeEventListener(REQUEST_QUEUES_REFRESH_EVENT, onQueues)
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onFocus)
    }
  }, [enabled])
}
