"use client"

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { Client } from "@/lib/data"
import { useAuth } from "@/lib/auth-context"
import { fetchClients } from "@/lib/supabase/clients-db"

const STALE_MS = 5 * 60 * 1000

type ClientsStoreValue = {
  clients: Client[]
  isLoading: boolean
  error: Error | null
  /** Load if idle / stale; shares one in-flight request. */
  ensureLoaded: () => Promise<void>
  /** Force network refresh (still deduped if already in flight). */
  refetch: () => Promise<void>
  /** Insert or replace one row in the shared list (after create/edit). */
  upsertClient: (client: Client) => void
}

const ClientsStoreContext = createContext<ClientsStoreValue | null>(null)

/** Module-level in-flight so Strict Mode / overlapping callers share one round-trip. */
let clientsInflight: Promise<Client[]> | null = null

async function loadClientsOnce(): Promise<Client[]> {
  if (clientsInflight) return clientsInflight
  clientsInflight = fetchClients().finally(() => {
    clientsInflight = null
  })
  return clientsInflight
}

function sortClients(list: Client[]): Client[] {
  return [...list].sort((a, b) => {
    const ac = (a.company || a.name || "").localeCompare(b.company || b.name || "", undefined, {
      sensitivity: "base",
    })
    if (ac !== 0) return ac
    return a.id.localeCompare(b.id)
  })
}

export function ClientsStoreProvider({ children }: { children: React.ReactNode }) {
  const { user, loading: authLoading } = useAuth()
  const [clients, setClients] = useState<Client[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [hasLoaded, setHasLoaded] = useState(false)
  const lastFetchedAt = useRef(0)
  const wantedRef = useRef(false)

  // Sign-out / user switch: drop cache before paint (shared office machines).
  const sessionUserId = user?.id
  const [cacheUserId, setCacheUserId] = useState<string | undefined>(sessionUserId)
  if (sessionUserId !== cacheUserId) {
    setCacheUserId(sessionUserId)
    setClients([])
    setError(null)
    setHasLoaded(false)
    setIsLoading(false)
    lastFetchedAt.current = 0
    wantedRef.current = false
  }

  const runFetch = useCallback(async (force: boolean) => {
    // Signed out (auth settled, no user): drop cache. While auth is still
    // resolving, start the directory load anyway — main's per-page useClients
    // did not wait on AuthProvider, and delaying here put clients ~250–350ms
    // later on the cold waterfall.
    if (!authLoading && !user?.id) {
      setClients([])
      setIsLoading(false)
      return
    }
    const freshEnough =
      hasLoaded && !force && Date.now() - lastFetchedAt.current < STALE_MS
    if (freshEnough) return

    setIsLoading(true)
    setError(null)
    try {
      const rows = await loadClientsOnce()
      setClients(rows)
      setHasLoaded(true)
      lastFetchedAt.current = Date.now()
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
      if (!hasLoaded) setClients([])
    } finally {
      setIsLoading(false)
    }
  }, [authLoading, user?.id, hasLoaded])

  const ensureLoaded = useCallback(async () => {
    wantedRef.current = true
    await runFetch(false)
  }, [runFetch])

  const refetch = useCallback(async () => {
    wantedRef.current = true
    await runFetch(true)
  }, [runFetch])

  const upsertClient = useCallback((client: Client) => {
    setClients((prev) => {
      const without = prev.filter((c) => c.id !== client.id)
      return sortClients([...without, client])
    })
    setHasLoaded(true)
    // Keep TTL; local mutation is authoritative until next background refresh.
  }, [])

  // Background refresh: at most every 5 minutes, on focus / visibility.
  useEffect(() => {
    if (!user?.id) return
    const maybeRefresh = () => {
      if (!wantedRef.current) return
      if (document.visibilityState !== "visible") return
      if (Date.now() - lastFetchedAt.current < STALE_MS) return
      void runFetch(true)
    }
    window.addEventListener("focus", maybeRefresh)
    document.addEventListener("visibilitychange", maybeRefresh)
    const id = window.setInterval(maybeRefresh, STALE_MS)
    return () => {
      window.removeEventListener("focus", maybeRefresh)
      document.removeEventListener("visibilitychange", maybeRefresh)
      window.clearInterval(id)
    }
  }, [user?.id, runFetch])

  const value = useMemo<ClientsStoreValue>(
    () => ({
      clients,
      isLoading,
      error,
      ensureLoaded,
      refetch,
      upsertClient,
    }),
    [clients, isLoading, error, ensureLoaded, refetch, upsertClient],
  )

  return <ClientsStoreContext.Provider value={value}>{children}</ClientsStoreContext.Provider>
}

function useClientsStore(): ClientsStoreValue {
  const ctx = useContext(ClientsStoreContext)
  if (!ctx) throw new Error("useClients must be used within ClientsStoreProvider")
  return ctx
}

/**
 * Shared client directory. Loads once when first enabled consumer mounts;
 * does not reload on navigation. Pass `enabled: false` to subscribe without
 * triggering a fetch (e.g. header search when the role cannot search clients).
 */
export function useClients(options?: { enabled?: boolean }): {
  clients: Client[]
  isLoading: boolean
  error: Error | null
  refetch: () => Promise<void>
  upsertClient: (client: Client) => void
  ensureLoaded: () => Promise<void>
} {
  const store = useClientsStore()
  const enabled = options?.enabled !== false

  useEffect(() => {
    if (!enabled) return
    void store.ensureLoaded()
  }, [enabled, store.ensureLoaded])

  return {
    clients: store.clients,
    isLoading: store.isLoading,
    error: store.error,
    refetch: store.refetch,
    upsertClient: store.upsertClient,
    ensureLoaded: store.ensureLoaded,
  }
}
