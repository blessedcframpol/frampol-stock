"use client"

import { Suspense, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Loader2 } from "lucide-react"
import { exchangeAuthCodeOnce } from "@/lib/auth/exchange-auth-code"
import { createAuthReturnBrowserClient } from "@/lib/supabase/browser"

function safeNextPath(next: string): string {
  if (!next.startsWith("/") || next.startsWith("//")) return "/"
  return next
}

function AuthCallbackContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const oauthError = searchParams.get("error")
    const oauthDesc = searchParams.get("error_description")
    const code = searchParams.get("code")
    const next = safeNextPath(searchParams.get("next") ?? "/")

    async function waitForSession(supabase: ReturnType<typeof createAuthReturnBrowserClient>, maxAttempts = 60) {
      for (let i = 0; i < maxAttempts; i++) {
        if (cancelled) return false
        const {
          data: { session },
        } = await supabase.auth.getSession()
        if (session) return true
        await new Promise((r) => setTimeout(r, 100))
      }
      return false
    }

    async function run() {
      try {
        const supabase = createAuthReturnBrowserClient()

        const {
          data: { session: already },
        } = await supabase.auth.getSession()
        if (already) {
          if (!cancelled) {
            router.replace(next)
            router.refresh()
          }
          return
        }

        if (oauthError) {
          const msg = oauthDesc?.replace(/\+/g, " ") || oauthError || "Sign-in was cancelled or failed."
          if (!cancelled) {
            router.replace(`/login?error=${encodeURIComponent(msg)}`)
          }
          return
        }

        if (code) {
          const result = await exchangeAuthCodeOnce(supabase, code, { sessionPollAttempts: 40 })
          if (!result.ok) {
            if (!cancelled) {
              router.replace(`/login?error=${encodeURIComponent(result.message)}`)
            }
            return
          }
        } else {
          const ok = await waitForSession(supabase, 48)
          if (!ok) {
            if (!cancelled) {
              router.replace(
                `/login?error=${encodeURIComponent("Missing authorization code. Try signing in again.")}`
              )
            }
            return
          }
        }

        if (!cancelled) {
          router.replace(next)
          router.refresh()
        }
      } catch {
        if (!cancelled) {
          setErrorMessage("Could not complete sign-in.")
        }
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [router, searchParams])

  if (errorMessage) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-4">
        <p className="text-center text-sm text-muted-foreground">{errorMessage}</p>
        <button
          type="button"
          className="text-sm font-medium text-brand underline"
          onClick={() => router.replace("/login")}
        >
          Back to sign in
        </button>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-4">
      <Loader2 className="size-8 animate-spin text-muted-foreground" aria-hidden />
      <p className="text-sm text-muted-foreground">Completing sign-in…</p>
      <span className="sr-only">Completing sign-in</span>
    </div>
  )
}

export default function AuthCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-background">
          <Loader2 className="size-8 animate-spin text-muted-foreground" aria-hidden />
        </div>
      }
    >
      <AuthCallbackContent />
    </Suspense>
  )
}
