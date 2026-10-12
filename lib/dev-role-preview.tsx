"use client"

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { useAuth } from "@/lib/auth-context"
import { isValidRole, type AppRole } from "@/lib/permissions"

/** sessionStorage key for the development-only role preview. */
export const DEV_ROLE_PREVIEW_KEY = "fram-dev-role-preview"

/** Development only. Production builds never honor a stored preview role. */
export function devRolePreviewAllowed(): boolean {
  if (process.env.NODE_ENV === "production") return false
  return process.env.NODE_ENV === "development"
}

function readStoredPreview(): AppRole | null {
  if (!devRolePreviewAllowed() || typeof window === "undefined") return null
  try {
    const raw = window.sessionStorage.getItem(DEV_ROLE_PREVIEW_KEY)
    return raw && isValidRole(raw) ? raw : null
  } catch {
    return null
  }
}

type DevRolePreviewState = {
  previewRole: AppRole | null
  setPreviewRole: (role: AppRole | null) => void
}

const DevRolePreviewContext = createContext<DevRolePreviewState | null>(null)

export function DevRolePreviewProvider({ children }: { children: React.ReactNode }) {
  const [previewRole, setPreviewState] = useState<AppRole | null>(null)

  // Read after mount so server and first client render agree.
  useEffect(() => {
    if (!devRolePreviewAllowed()) return
    const sync = () => setPreviewState(readStoredPreview())
    sync()
    window.addEventListener("storage", sync)
    return () => window.removeEventListener("storage", sync)
  }, [])

  const setPreviewRole = useCallback((role: AppRole | null) => {
    if (!devRolePreviewAllowed()) return
    try {
      if (role) window.sessionStorage.setItem(DEV_ROLE_PREVIEW_KEY, role)
      else window.sessionStorage.removeItem(DEV_ROLE_PREVIEW_KEY)
    } catch {
      // Storage unavailable: the preview simply does not persist.
    }
    setPreviewState(role)
  }, [])

  const value = useMemo(() => ({ previewRole, setPreviewRole }), [previewRole, setPreviewRole])
  return <DevRolePreviewContext.Provider value={value}>{children}</DevRolePreviewContext.Provider>
}

export function useDevRolePreview(): DevRolePreviewState {
  const ctx = useContext(DevRolePreviewContext)
  if (ctx) return ctx
  return {
    previewRole: null,
    setPreviewRole: (role) => {
      if (!devRolePreviewAllowed()) return
      try {
        if (role) window.sessionStorage.setItem(DEV_ROLE_PREVIEW_KEY, role)
        else window.sessionStorage.removeItem(DEV_ROLE_PREVIEW_KEY)
      } catch {
        // ignore
      }
    },
  }
}

/**
 * The signed-in role, or the dev preview role when one is set in development.
 * Only changes what the UI shows; the database still enforces the real role.
 */
export function useEffectiveRole(): AppRole | null {
  const { role } = useAuth()
  const { previewRole } = useDevRolePreview()
  if (!devRolePreviewAllowed()) return role
  // Preview needs a real signed-in role so signed-out and pending users are unaffected.
  return role && previewRole ? previewRole : role
}
