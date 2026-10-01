"use client"

import { Suspense, useState, useEffect } from "react"
import { useIsClient } from "@/hooks/use-is-client"
import Image from "next/image"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useTheme } from "next-themes"
import { Building2, Moon, Sun } from "lucide-react"
import { createBrowserSupabaseClient } from "@/lib/supabase/browser"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import {
  getAuthCallbackUrl,
  MICROSOFT_OAUTH_SCOPES,
  MICROSOFT_PROVIDER,
} from "@/lib/auth/microsoft-oauth"
import { useAuth, hasAppAccess } from "@/lib/auth-context"

/** Hero / brand panel artwork */
const LOGIN_VISUAL = "/pexels-daniel-dan-47825192-7598913.jpg"

const microsoftButtonClass =
  "flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-input bg-card text-[15px] font-semibold text-card-foreground shadow-none transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"

const loginFormErrorClass =
  "rounded-xl border border-danger/40 bg-danger-soft px-3 py-2.5 text-sm leading-snug text-danger"

function MicrosoftLogo() {
  return (
    <svg width="21" height="21" viewBox="0 0 21 21" aria-hidden className="shrink-0">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  )
}

function LoginThemeToggle() {
  const { setTheme, theme } = useTheme()
  const isClient = useIsClient()

  if (!isClient) {
    return <div className="size-9 shrink-0" aria-hidden />
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Theme"
          className="relative shrink-0 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Sun className="h-[18px] w-[18px] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute h-[18px] w-[18px] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[9rem]">
        <DropdownMenuItem onClick={() => setTheme("light")} className={cn(theme === "light" && "bg-accent")}>
          <Sun className="mr-2 h-4 w-4" />
          Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("dark")} className={cn(theme === "dark" && "bg-accent")}>
          <Moon className="mr-2 h-4 w-4" />
          Dark
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function LoginPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const redirectTo = searchParams.get("redirectTo") ?? "/"
  const { user, profile, loading: authLoading } = useAuth()

  const urlError = searchParams.get("error")
  const [dismissedUrlError, setDismissedUrlError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const error = formError ?? (urlError && urlError !== dismissedUrlError ? urlError : null)
  const [oauthLoading, setOauthLoading] = useState(false)

  useEffect(() => {
    if (authLoading) return
    if (!user) return
    const safeRedirect = redirectTo.startsWith("/login") ? "/" : redirectTo
    if (hasAppAccess(profile)) {
      router.replace(safeRedirect)
      router.refresh()
      return
    }
    if (profile && !profile.active) {
      router.replace("/pending-role?reason=inactive")
      return
    }
    if (profile?.active && profile.role === null) {
      router.replace("/pending-role?reason=no-role")
    }
  }, [authLoading, user, profile, redirectTo, router])

  function clearMessages() {
    if (urlError) setDismissedUrlError(urlError)
    setFormError(null)
  }

  async function handleMicrosoftAuth() {
    clearMessages()
    setOauthLoading(true)
    try {
      const supabase = createBrowserSupabaseClient()
      const origin = window.location.origin
      const { data, error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: MICROSOFT_PROVIDER,
        options: {
          redirectTo: getAuthCallbackUrl(origin, redirectTo),
          scopes: MICROSOFT_OAUTH_SCOPES,
          queryParams: {
            prompt: "select_account",
          },
        },
      })
      if (oauthError) {
        setFormError(oauthError.message)
        setOauthLoading(false)
        return
      }
      if (data.url) {
        window.location.assign(data.url)
        return
      }
      setFormError("Could not start Microsoft sign-in. Check that Azure is enabled in Supabase Auth.")
      setOauthLoading(false)
    } catch {
      setFormError("Something went wrong. Please try again.")
      setOauthLoading(false)
    }
  }

  const visualPanel = (
    <div className="relative min-h-[220px] w-full lg:min-h-full">
      <Image
        src={LOGIN_VISUAL}
        alt=""
        fill
        priority
        className="object-cover object-[center_30%]"
        sizes="(min-width: 1024px) 50vw, 100vw"
      />
      <div
        className="absolute inset-0 bg-gradient-to-t from-background/25 to-transparent dark:from-background/55 dark:via-background/20 dark:to-transparent"
        aria-hidden
      />
      <div className="absolute bottom-8 left-8 right-8 z-10 hidden lg:block">
        <div className="max-w-md rounded-2xl border border-border/80 bg-card/90 p-6 shadow-lg shadow-foreground/5 backdrop-blur-md dark:shadow-black/40">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Fram-Stock</p>
          <p className="mt-3 text-xl font-semibold leading-snug tracking-tight text-card-foreground">
            Inventory control built for field teams and the back office.
          </p>
        </div>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-background transition-colors lg:grid lg:grid-cols-2">
      <div className="order-2 flex flex-col justify-center px-6 py-10 sm:px-10 lg:order-1 lg:px-16 xl:px-24">
        <div className="mx-auto w-full max-w-md">
          <div className="mb-10 flex items-start justify-between gap-4">
            <Link
              href="/"
              className="inline-flex items-center gap-2 text-foreground transition-opacity hover:opacity-80"
            >
              <span className="flex size-10 items-center justify-center rounded-xl bg-muted">
                <Building2 className="size-5 text-muted-foreground" strokeWidth={1.5} aria-hidden />
              </span>
              <span className="text-lg font-semibold tracking-tight">Fram-Stock</span>
            </Link>
            <LoginThemeToggle />
          </div>

          <h1 className="text-3xl font-bold tracking-tight text-foreground">Welcome back</h1>
          <p className="mt-2 text-[15px] text-muted-foreground">
            Sign in with your Fram Microsoft account.
          </p>

          <div className="mt-10 space-y-5">
            <button
              type="button"
              onClick={handleMicrosoftAuth}
              disabled={oauthLoading}
              className={microsoftButtonClass}
            >
              <MicrosoftLogo />
              {oauthLoading ? "Redirecting…" : "Sign in with Microsoft"}
            </button>
            {error && (
              <div className={loginFormErrorClass} role="alert">
                {error}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="relative order-1 min-h-[220px] lg:order-2 lg:min-h-screen">{visualPanel}</div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-background" />}>
      <LoginPageContent />
    </Suspense>
  )
}
