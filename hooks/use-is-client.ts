"use client"

import { useSyncExternalStore } from "react"

function subscribe() {
  return () => {}
}

function getSnapshot() {
  return true
}

function getServerSnapshot() {
  return false
}

/**
 * False on the server and during hydration, true after. Avoids a mounted-flag
 * effect when the only job is to hide a client-only value from the first paint.
 */
export function useIsClient() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
