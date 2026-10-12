"use client"

import { Suspense, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useTheme } from "next-themes"
import { Building2, Loader2, Moon, RefreshCw, Sun } from "lucide-react"
import { useAuth, hasAppAccess } from "@/lib/auth-context"
import { roleLandingPath } from "@/lib/role-pages"
import { Button } from "@/components/ui/button"

const POLL_MS = 7000

function PendingThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const dark = resolvedTheme === "dark"
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-10 rounded-xl"
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => setTheme(dark ? "light" : "dark")}
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  )
}

function PendingRoleContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const reason = searchParams.get("reason")
  const preview =
    process.env.NODE_ENV === "development" && searchParams.get("preview") === "1"
  const { user, profile, loading, refetch, signOut } = useAuth()
  const [polling, setPolling] = useState(false)
  const redirected = useRef(false)

  const resolvedReason = useMemo(() => {
    if (reason === "inactive") return "inactive" as const
    if (reason === "no-role") return "no-role" as const
    if (profile && !profile.active) return "inactive" as const
    if (profile?.active && profile.role === null) return "no-role" as const
    return null
  }, [reason, profile])

  useEffect(() => {
    if (loading || preview) return
    if (!user) {
      router.replace("/login")
      return
    }
    if (hasAppAccess(profile)) {
      if (!redirected.current) {
        redirected.current = true
        router.replace(roleLandingPath(profile?.role))
        router.refresh()
      }
    }
  }, [loading, user, profile, router, preview])

  useEffect(() => {
    if (loading || preview || !user || hasAppAccess(profile)) return

    const tick = () => {
      setPolling(true)
      void refetch().finally(() => setPolling(false))
    }

    const id = window.setInterval(tick, POLL_MS)
    const onVis = () => {
      if (document.visibilityState === "visible") tick()
    }
    const onFocus = () => tick()
    document.addEventListener("visibilitychange", onVis)
    window.addEventListener("focus", onFocus)

    return () => {
      window.clearInterval(id)
      document.removeEventListener("visibilitychange", onVis)
      window.removeEventListener("focus", onFocus)
    }
  }, [loading, user, profile, refetch])

  if (!preview && (loading || !user)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-8 animate-spin text-muted-foreground" aria-hidden />
        <span className="sr-only">Loading…</span>
      </div>
    )
  }

  if (!preview && hasAppAccess(profile)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-8 animate-spin text-muted-foreground" aria-hidden />
        <span className="sr-only">Redirecting…</span>
      </div>
    )
  }

  const inactiveCopy = resolvedReason === "inactive"

  return (
    <div className="min-h-screen bg-background px-6 py-16">
      <div className="mx-auto flex w-full max-w-lg flex-col items-center px-1 text-center">
        <div className="mb-10 flex w-full items-start justify-between gap-4">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-foreground transition-opacity hover:opacity-80"
          >
            <span className="flex size-10 items-center justify-center rounded-xl bg-muted">
              <Building2 className="size-5 text-muted-foreground" strokeWidth={1.5} aria-hidden />
            </span>
            <span className="text-lg font-semibold tracking-tight">Fram-Stock</span>
          </Link>
          <PendingThemeToggle />
        </div>

        <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          {inactiveCopy ? "Account inactive" : "Waiting for a role"}
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground">
          {inactiveCopy ? (
            <>
              Your account has been deactivated. If you think this is a mistake, contact your Fram-Stock administrator.
            </>
          ) : (
            <>Your account is waiting for a role. Josh or another admin will set it up.</>
          )}
        </p>
        <p className="mt-3 text-xs text-muted-foreground">
          This page checks for updates automatically; when your role is ready you&apos;ll be sent to your home page.
        </p>

        <div className="mt-10 flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:justify-center">
          {!inactiveCopy && (
            <Button
              type="button"
              variant="secondary"
              className="min-h-11 w-full rounded-xl sm:w-auto"
              disabled={polling}
              onClick={() => {
                setPolling(true)
                void refetch().finally(() => setPolling(false))
              }}
            >
              {polling ? (
                <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="mr-2 size-4" aria-hidden />
              )}
              Check again
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full rounded-xl sm:w-auto"
            onClick={async () => {
              await signOut()
              router.replace("/login")
              router.refresh()
            }}
          >
            Sign out
          </Button>
        </div>
      </div>
    </div>
  )
}

export default function PendingRolePage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-background">
          <Loader2 className="size-8 animate-spin text-muted-foreground" aria-hidden />
        </div>
      }
    >
      <PendingRoleContent />
    </Suspense>
  )
}
