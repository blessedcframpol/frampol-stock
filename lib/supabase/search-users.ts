"use client"

import { useEffect, useState } from "react"
import type { AppUser } from "@/lib/data"
import { getSupabaseClient } from "./client"
import { fetchAllPages } from "./postgrest-page"

function profileToUser(row: {
  id: string
  email: string | null
  display_name: string | null
  role: string | null
}): AppUser {
  const email = row.email?.trim() ?? ""
  const name = row.display_name?.trim() || email || "User"
  return {
    id: row.id,
    name,
    email,
    role: row.role ?? undefined,
  }
}

type SearchUsersOptions = {
  /** When true, only active profiles with role admin (Dispose authorisation). */
  activeAdminsOnly?: boolean
}

/** Profiles the signed-in user is allowed to read, paged and ordered by email then id. */
export function useSearchUsers(options: SearchUsersOptions = {}): AppUser[] {
  const { activeAdminsOnly = false } = options
  const [users, setUsers] = useState<AppUser[]>([])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const supabase = getSupabaseClient()
        const rows = await fetchAllPages((from, to) => {
          let q = supabase
            .from("profiles")
            .select("id, email, display_name, role, active")
            .order("email", { ascending: true })
            .order("id", { ascending: true })
            .range(from, to)
          if (activeAdminsOnly) {
            q = q.eq("role", "admin").eq("active", true)
          }
          return q
        })
        if (!cancelled) setUsers(rows.map(profileToUser))
      } catch (error) {
        console.error("useSearchUsers:", error)
        if (!cancelled) setUsers([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeAdminsOnly])

  return users
}
