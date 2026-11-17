"use client"

import { useEffect, useState } from "react"
import { getSupabaseClient } from "@/lib/supabase/client"
import {
  fetchClientIdsMatchingContacts,
  type ContactSearchMatch,
} from "@/lib/supabase/client-contacts-db"

/** On-demand contact→client matches for search (PF1a: no load when query empty). */
export function useContactSearchMatches(
  query: string,
  enabled = true
): ContactSearchMatch[] {
  const [matches, setMatches] = useState<ContactSearchMatch[]>([])
  const q = query.trim()

  useEffect(() => {
    if (!enabled || !q) {
      setMatches([])
      return
    }
    let cancelled = false
    const handle = window.setTimeout(() => {
      try {
        const sb = getSupabaseClient()
        void fetchClientIdsMatchingContacts(sb, q)
          .then((next) => {
            if (!cancelled) setMatches(next)
          })
          .catch(() => {
            if (!cancelled) setMatches([])
          })
      } catch {
        if (!cancelled) setMatches([])
      }
    }, 150)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [q, enabled])

  return matches
}

/** @deprecated Prefer useContactSearchMatches for via-contact labels. */
export function useContactSearchClientIds(query: string, enabled = true): string[] {
  return useContactSearchMatches(query, enabled).map((m) => m.clientId)
}
