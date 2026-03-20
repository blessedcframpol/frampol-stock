"use client"

import { Suspense, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Building2, Loader2, RefreshCw } from "lucide-react"
import { useAuth, hasAppAccess } from "@/lib/auth-context"
import { Button } from "@/components/ui/button"

const POLL_MS = 7000

function PendingRoleContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const reason = searchParams.get("reason")
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
    if (loading) return
    if (!user) {
      router.replace("/login")
      return
    }
    if (hasAppAccess(profile)) {
      if (!redirected.current) {
        redirected.current = true
        router.replace("/")
        router.refresh()
      }
    }
  }, [loading, user, profile, router])

  useEffect(() => {
    if (loading || !user || hasAppAccess(profile)) return

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

  if (loading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-8 animate-spin text-muted-foreground" aria-hidden />
        <span className="sr-only">Loading…</span>
      </div>
    )
  }

  if (hasAppAccess(profile)) {
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
      <div className="mx-auto flex w-full max-w-lg flex-col items-center text-center">
        <Link
          href="/"
          className="mb-10 inline-flex items-center gap-2 text-foreground transition-opacity hover:opacity-80"
        >
          <span className="flex size-10 items-center justify-center rounded-xl bg-muted">
            <Building2 className="size-5 text-muted-foreground" strokeWidth={1.5} aria-hidden />
          </span>
          <span className="text-lg font-semibold tracking-tight">Fram-Stock</span>
        </Link>

        <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          {inactiveCopy ? "Account inactive" : "Almost there"}
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground">
          {inactiveCopy ? (
            <>
              Your account has been deactivated. If you think this is a mistake, contact your Fram-Stock administrator.
            </>
          ) : (
            <>
              Your sign-in worked, but an administrator still needs to assign a role to your account before you can use
              the app. Ask your Fram-Stock admin to open <strong className="font-medium text-foreground">Settings</strong>{" "}
              → <strong className="font-medium text-foreground">Users</strong> and set your role.
            </>
          )}
        </p>
        <p className="mt-3 text-xs text-muted-foreground">
          This page checks for updates automatically; when your role is ready you&apos;ll be sent to the dashboard.
        </p>

        <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:justify-center">
          {!inactiveCopy && (
            <Button
              type="button"
              variant="secondary"
              className="rounded-xl"
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
            className="rounded-xl"
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
