"use client"

/**
 * RT1: Realtime connection status + debounced catch-up on visibility / online / reconnect.
 */
import { useEffect, useState } from "react"
import { getSupabaseClient } from "@/lib/supabase/client"
import { useAuth } from "@/lib/auth-context"
import {
  announceRealtimeCatchup,
  announceRealtimeConnection,
  markRealtimeTabHidden,
  reportRealtimeTelemetry,
  takeHiddenDurationMs,
  type RealtimeConnectionStatus,
} from "@/lib/realtime-live"

type StateCallbacks = {
  open: Array<() => void>
  close: Array<(event?: unknown) => void>
  error: Array<(error?: unknown) => void>
  message: Array<(msg?: unknown) => void>
}

function getRealtimeStateCallbacks(
  realtime: { stateChangeCallbacks?: StateCallbacks },
): StateCallbacks | null {
  return realtime.stateChangeCallbacks ?? null
}

export function useRealtimeLifecycle(enabled = true): {
  status: RealtimeConnectionStatus
} {
  const { user } = useAuth()
  const [status, setStatus] = useState<RealtimeConnectionStatus>("reconnecting")

  useEffect(() => {
    if (!enabled || !user?.id) return

    let sb: ReturnType<typeof getSupabaseClient>
    try {
      sb = getSupabaseClient()
    } catch {
      return
    }

    let lastConnected = sb.realtime.isConnected()
    setStatus(lastConnected ? "live" : "reconnecting")
    announceRealtimeConnection(lastConnected ? "live" : "reconnecting")

    const setConn = (next: RealtimeConnectionStatus, telem?: "disconnect" | "reconnect") => {
      setStatus(next)
      announceRealtimeConnection(next)
      if (telem) reportRealtimeTelemetry(telem)
      if (telem === "reconnect") announceRealtimeCatchup()
    }

    const onOpen = () => {
      const wasDown = !lastConnected
      lastConnected = true
      setConn("live", wasDown ? "reconnect" : undefined)
    }
    const onClose = () => {
      lastConnected = false
      setConn("reconnecting", "disconnect")
    }

    const callbacks = getRealtimeStateCallbacks(
      sb.realtime as unknown as { stateChangeCallbacks?: StateCallbacks },
    )
    callbacks?.open.push(onOpen)
    callbacks?.close.push(onClose)

    // Keep a cheap presence channel so the socket stays subscribed while signed in.
    const channel = sb
      .channel(`rt1-lifecycle:${user.id}`)
      .subscribe((channelStatus) => {
        if (channelStatus === "SUBSCRIBED") {
          if (!lastConnected) {
            lastConnected = true
            setConn("live", "reconnect")
          } else {
            setConn("live")
          }
        } else if (
          channelStatus === "CHANNEL_ERROR" ||
          channelStatus === "TIMED_OUT" ||
          channelStatus === "CLOSED"
        ) {
          if (lastConnected) {
            lastConnected = false
            setConn("reconnecting", "disconnect")
          } else {
            setConn("reconnecting")
          }
        }
      })

    const poll = window.setInterval(() => {
      const connected = sb.realtime.isConnected()
      if (connected && !lastConnected) {
        lastConnected = true
        setConn("live", "reconnect")
      } else if (!connected && lastConnected) {
        lastConnected = false
        setConn("reconnecting", "disconnect")
      }
    }, 5_000)

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        markRealtimeTabHidden()
        return
      }
      const hiddenMs = takeHiddenDurationMs()
      if (hiddenMs != null) reportRealtimeTelemetry("hidden_return", { hiddenMs })
      announceRealtimeCatchup()
    }
    const onOnline = () => announceRealtimeCatchup()

    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("online", onOnline)

    return () => {
      window.clearInterval(poll)
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("online", onOnline)
      if (callbacks) {
        callbacks.open = callbacks.open.filter((fn) => fn !== onOpen)
        callbacks.close = callbacks.close.filter((fn) => fn !== onClose)
      }
      void sb.removeChannel(channel)
    }
  }, [enabled, user?.id])

  return { status }
}
