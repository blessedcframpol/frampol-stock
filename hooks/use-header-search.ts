"use client"

import { useEffect, useState } from "react"
import { getSupabaseClient } from "@/lib/supabase/client"
import type { SearchEntity } from "@/lib/search"
import {
  HEADER_SEARCH_DEBOUNCE_MS,
  HEADER_SEARCH_MIN_CHARS,
  emptyHeaderSearchResults,
  fetchHeaderSearch,
  type HeaderSearchResults,
} from "@/lib/header-search"
import { loadErrorFromCaught } from "@/lib/unauthorized"

export function useHeaderSearch(
  query: string,
  entities: readonly SearchEntity[],
  enabled: boolean,
): {
  results: HeaderSearchResults
  loading: boolean
  error: string | null
} {
  const [results, setResults] = useState<HeaderSearchResults>(emptyHeaderSearchResults)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const q = query.trim()
  const entitiesKey = entities.join(",")

  useEffect(() => {
    if (!enabled || q.length < HEADER_SEARCH_MIN_CHARS || entities.length === 0) {
      setResults(emptyHeaderSearchResults())
      setLoading(false)
      setError(null)
      return
    }

    let cancelled = false
    setLoading(true)
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const next = await fetchHeaderSearch(getSupabaseClient(), q, entities)
          if (cancelled) return
          setResults(next)
          setError(null)
        } catch (caught) {
          if (cancelled) return
          setResults(emptyHeaderSearchResults())
          setError(loadErrorFromCaught(caught, "Search failed"))
        } finally {
          if (!cancelled) setLoading(false)
        }
      })()
    }, HEADER_SEARCH_DEBOUNCE_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [q, entitiesKey, enabled, entities])

  return { results, loading, error }
}
