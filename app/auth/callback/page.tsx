"use client"

import { Suspense, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Loader2 } from "lucide-react"
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
    if (oauthError) {
      const msg = oauthDesc?.replace(/\+/g, " ") || oauthError || "Sign-in was cancelled or failed."
      router.replace(`/login?error=${encodeURIComponent(msg)}`)
      return
    }

    const code = searchParams.get("code")
    const next = safeNextPath(searchParams.get("next") ?? "/")

    async function run() {
      try {
        const supabase = createAuthReturnBrowserClient()

        if (code) {
          const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)
          if (exchangeError) {
            const { data: { session: existing } } = await supabase.auth.getSession()
            if (!existing) {
              if (!cancelled) {
                router.replace(`/login?error=${encodeURIComponent(exchangeError.message)}`)
              }
              return
            }
          }
        } else {
          for (let i = 0; i < 48; i++) {
            if (cancelled) return
            const { data: { session } } = await supabase.auth.getSession()
            if (session) break
            await new Promise((r) => setTimeout(r, 250))
          }
          const { data: { session } } = await supabase.auth.getSession()
          if (!session) {
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
          className="text-sm font-medium text-primary underline"
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
