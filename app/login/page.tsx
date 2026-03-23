"use client"

import { Suspense, useState, useEffect } from "react"
import Image from "next/image"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useTheme } from "next-themes"
import { Building2, Moon, Sun, Monitor } from "lucide-react"
import { createBrowserSupabaseClient } from "@/lib/supabase/browser"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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

const inputClass =
  "h-12 rounded-xl border border-input bg-muted/70 text-foreground shadow-none placeholder:text-muted-foreground transition-colors focus-visible:border-ring focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring/35"

const primaryButtonClass =
  "h-12 w-full rounded-xl bg-primary text-[15px] font-semibold text-primary-foreground shadow-none transition-colors hover:bg-primary/90"

const microsoftButtonClass =
  "flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-input bg-card text-[15px] font-semibold text-card-foreground shadow-none transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"

/** Contrast-safe on dark backgrounds (WCAG); avoids `text-destructive` token tuned for buttons. */
const loginFormErrorClass =
  "rounded-xl border border-red-600/40 bg-red-50 px-3 py-2.5 text-sm leading-snug text-red-950 dark:border-red-400/45 dark:bg-red-950/50 dark:text-red-100"

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

function AuthDivider() {
  return (
    <div className="relative py-1">
      <div className="absolute inset-0 flex items-center" aria-hidden>
        <span className="w-full border-t border-border" />
      </div>
      <div className="relative flex justify-center text-xs">
        <span className="bg-background px-3 font-medium uppercase tracking-wide text-muted-foreground">
          or
        </span>
      </div>
    </div>
  )
}

function LoginThemeToggle() {
  const { setTheme, theme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  if (!mounted) {
    return <div className="size-9 shrink-0" aria-hidden />
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative shrink-0 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <Sun className="h-[18px] w-[18px] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute h-[18px] w-[18px] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
          <span className="sr-only">Theme</span>
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
        <DropdownMenuItem onClick={() => setTheme("system")} className={cn(theme === "system" && "bg-accent")}>
          <Monitor className="mr-2 h-4 w-4" />
          System
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

  const [mode, setMode] = useState<"signin" | "signup">("signin")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [forgotLoading, setForgotLoading] = useState(false)
  const [oauthLoading, setOauthLoading] = useState(false)

  useEffect(() => {
    const q = searchParams.get("error")
    if (q) setError(q)
  }, [searchParams])

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
    setError(null)
    setInfo(null)
  }

  async function handleForgotPassword() {
    clearMessages()
    if (!email.trim()) {
      setError("Enter your email in the field above, then try again.")
      return
    }
    setForgotLoading(true)
    try {
      const supabase = createBrowserSupabaseClient()
      const origin = window.location.origin
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: getAuthCallbackUrl(origin, redirectTo),
      })
      if (resetError) {
        setError(resetError.message)
        setForgotLoading(false)
        return
      }
      setInfo("If an account exists for that email, you will receive a reset link shortly.")
      setForgotLoading(false)
    } catch {
      setError("Something went wrong. Please try again.")
      setForgotLoading(false)
    }
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
        setError(oauthError.message)
        setOauthLoading(false)
        return
      }
      if (data.url) {
        window.location.assign(data.url)
        return
      }
      setError("Could not start Microsoft sign-in. Check that Azure is enabled in Supabase Auth.")
      setOauthLoading(false)
    } catch {
      setError("Something went wrong. Please try again.")
      setOauthLoading(false)
    }
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault()
    clearMessages()
    setLoading(true)
    try {
      const supabase = createBrowserSupabaseClient()
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
      if (signInError) {
        setError(signInError.message)
        setLoading(false)
        return
      }
      router.push(redirectTo)
      router.refresh()
    } catch {
      setError("Something went wrong. Please try again.")
      setLoading(false)
    }
  }

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault()
    clearMessages()
    if (password !== confirmPassword) {
      setError("Passwords do not match.")
      return
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters.")
      return
    }
    setLoading(true)
    try {
      const supabase = createBrowserSupabaseClient()
      const origin = window.location.origin
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          emailRedirectTo: getAuthCallbackUrl(origin, redirectTo),
          data: {
            display_name: displayName.trim() || undefined,
          },
        },
      })
      if (signUpError) {
        setError(signUpError.message)
        setLoading(false)
        return
      }
      if (data.session) {
        router.push(redirectTo)
        router.refresh()
        return
      }
      setInfo(
        "Account created. If email confirmation is enabled for your project, check your inbox to finish signing in."
      )
      setPassword("")
      setConfirmPassword("")
      setLoading(false)
    } catch {
      setError("Something went wrong. Please try again.")
      setLoading(false)
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

          {mode === "signin" ? (
            <>
              <h1 className="text-3xl font-bold tracking-tight text-foreground">Welcome back</h1>
              <p className="mt-2 text-[15px] text-muted-foreground">
                Sign in to continue to your dashboard.
              </p>

              <div className="mt-10 space-y-5">
                <button
                  type="button"
                  onClick={handleMicrosoftAuth}
                  disabled={loading || oauthLoading || forgotLoading}
                  className={microsoftButtonClass}
                >
                  <MicrosoftLogo />
                  {oauthLoading ? "Redirecting…" : "Sign in with Microsoft"}
                </button>
                <AuthDivider />
                <form onSubmit={handleSignIn} className="space-y-5">
                  <div className="space-y-2">
                    <Label htmlFor="email" className="text-sm font-medium text-foreground">
                      Email
                    </Label>
                    <Input
                      id="email"
                      type="email"
                      placeholder="name@company.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      autoComplete="email"
                      className={inputClass}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="password" className="text-sm font-medium text-foreground">
                      Password
                    </Label>
                    <Input
                      id="password"
                      type="password"
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      autoComplete="current-password"
                      className={inputClass}
                    />
                  </div>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={handleForgotPassword}
                      disabled={forgotLoading || oauthLoading}
                      className="text-sm font-medium text-foreground underline-offset-4 hover:underline disabled:opacity-50"
                    >
                      {forgotLoading ? "Sending…" : "Forgot password?"}
                    </button>
                  </div>
                  {error && (
                    <p className="text-sm text-destructive" role="alert">
                      {error}
                    </p>
                  )}
                  {info && (
                    <p className="text-sm text-muted-foreground" role="status">
                      {info}
                    </p>
                  )}
                  <Button type="submit" className={primaryButtonClass} disabled={loading || oauthLoading}>
                    {loading ? "Signing in…" : "Sign in"}
                  </Button>
                </form>
              </div>
            </>
          ) : (
            <>
              <h1 className="text-3xl font-bold tracking-tight text-foreground">Create an account</h1>
              <p className="mt-2 text-[15px] text-muted-foreground">
                Get started — an administrator will assign your role after sign-up.
              </p>

              <div className="mt-10 space-y-5">
                <button
                  type="button"
                  onClick={handleMicrosoftAuth}
                  disabled={loading || oauthLoading}
                  className={microsoftButtonClass}
                >
                  <MicrosoftLogo />
                  {oauthLoading ? "Redirecting…" : "Sign up with Microsoft"}
                </button>
                <AuthDivider />
                <form onSubmit={handleSignUp} className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="display-name" className="text-sm font-medium text-foreground">
                    Display name <span className="font-normal text-muted-foreground">(optional)</span>
                  </Label>
                  <Input
                    id="display-name"
                    type="text"
                    placeholder="Jane Smith"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    autoComplete="name"
                    className={inputClass}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="signup-email" className="text-sm font-medium text-foreground">
                    Email
                  </Label>
                  <Input
                    id="signup-email"
                    type="email"
                    placeholder="name@company.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                    className={inputClass}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="signup-password" className="text-sm font-medium text-foreground">
                    Password
                  </Label>
                  <Input
                    id="signup-password"
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                    minLength={6}
                    className={inputClass}
                  />
                </div>
                <div className="space-y-2">
                  <Label
                    htmlFor="confirm-password"
                    className="text-sm font-medium text-foreground"
                  >
                    Confirm password
                  </Label>
                  <Input
                    id="confirm-password"
                    type="password"
                    placeholder="••••••••"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                    minLength={6}
                    className={inputClass}
                  />
                </div>
                {error && (
                  <div className={loginFormErrorClass} role="alert">
                    {error}
                  </div>
                )}
                {info && (
                  <p className="text-sm text-muted-foreground" role="status">
                    {info}
                  </p>
                )}
                <Button type="submit" className={primaryButtonClass} disabled={loading || oauthLoading}>
                  {loading ? "Creating account…" : "Create account"}
                </Button>
                </form>
              </div>
            </>
          )}

          <p className="mt-10 text-center text-[15px] text-muted-foreground">
            {mode === "signin" ? (
              <>
                Don&apos;t have an account?{" "}
                <button
                  type="button"
                  onClick={() => {
                    setMode("signup")
                    clearMessages()
                  }}
                  className="font-semibold text-foreground underline-offset-4 hover:underline"
                >
                  Sign up
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button
                  type="button"
                  onClick={() => {
                    setMode("signin")
                    clearMessages()
                  }}
                  className="font-semibold text-foreground underline-offset-4 hover:underline"
                >
                  Sign in
                </button>
              </>
            )}
          </p>
          <p className="mt-4 text-center text-sm text-muted-foreground">
            <Link href="/" className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              ← Back to app
            </Link>
          </p>
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
