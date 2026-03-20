"use client"

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { createBrowserSupabaseClient } from "@/lib/supabase/browser"
import type { AppRole } from "@/lib/permissions"
import { isValidRole } from "@/lib/permissions"
import type { User } from "@supabase/supabase-js"

export type Profile = {
  id: string
  email: string
  display_name: string | null
  /** Set by an admin; null until assigned (self-service users). */
  role: AppRole | null
  active: boolean
}

/** User can use the app (RLS + UI) once they have an active profile with a role. */
export function hasAppAccess(profile: Profile | null | undefined): boolean {
  return Boolean(profile?.active && profile.role != null)
}

type AuthState = {
  user: User | null
  profile: Profile | null
  role: AppRole | null
  loading: boolean
  signOut: () => Promise<void>
  refetch: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  const supabase = useMemo(() => createBrowserSupabaseClient(), [])

  const fetchProfile = useCallback(
    async (userId: string) => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, email, display_name, role, active")
        .eq("id", userId)
        .single()
      if (error || !data) return null
      const rawRole = data.role
      return {
        id: data.id,
        email: data.email,
        display_name: data.display_name ?? null,
        role: rawRole != null && isValidRole(rawRole) ? rawRole : null,
        active: data.active,
      }
    },
    [supabase]
  )

  const refetch = useCallback(async () => {
    const {
      data: { user: u },
    } = await supabase.auth.getUser()
    setUser(u ?? null)
    if (u) {
      const p = await fetchProfile(u.id)
      setProfile(p)
    } else {
      setProfile(null)
    }
  }, [supabase, fetchProfile])

  useEffect(() => {
    let cancelled = false
    async function init() {
      const {
        data: { user: u },
      } = await supabase.auth.getUser()
      if (cancelled) return
      setUser(u ?? null)
      if (u) {
        const p = await fetchProfile(u.id)
        if (!cancelled) setProfile(p)
      } else {
        setProfile(null)
      }
      setLoading(false)
    }
    init()
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(() => {
      if (!cancelled) refetch()
    })
    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [supabase, fetchProfile, refetch])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    setUser(null)
    setProfile(null)
  }, [supabase])

  const value = useMemo<AuthState>(
    () => ({
      user,
      profile,
      role: profile?.active ? profile.role : null,
      loading,
      signOut,
      refetch,
    }),
    [user, profile, loading, signOut, refetch]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider")
  }
  return ctx
}

export function useAuthOptional(): AuthState | null {
  return useContext(AuthContext)
}
