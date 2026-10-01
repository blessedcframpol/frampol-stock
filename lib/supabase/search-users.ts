"use client"

import { useEffect, useState } from "react"
import type { AppUser } from "@/lib/data"
import { getSupabaseClient } from "./client"
import { fetchAllPages } from "./postgrest-page"

function profileToUser(row: { id: string; email: string | null; display_name: string | null; role: string | null }): AppUser {
  const email = row.email?.trim() ?? ""
  const name = row.display_name?.trim() || email || "User"
  return {
    id: row.id,
    name,
    email,
    role: row.role ?? undefined,
  }
}

/** Profiles the signed-in user is allowed to read, paged and ordered by email then id. */
export function useSearchUsers(): AppUser[] {
  const [users, setUsers] = useState<AppUser[]>([])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const supabase = getSupabaseClient()
        const rows = await fetchAllPages((from, to) =>
          supabase
            .from("profiles")
            .select("id, email, display_name, role")
            .order("email", { ascending: true })
            .order("id", { ascending: true })
            .range(from, to)
        )
        if (!cancelled) setUsers(rows.map(profileToUser))
      } catch (error) {
        console.error("useSearchUsers:", error)
        if (!cancelled) setUsers([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return users
}
