import { createServerClient } from "@supabase/ssr"
import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

function loginRedirect(origin: string, message: string) {
  const params = new URLSearchParams()
  params.set("error", message)
  return NextResponse.redirect(`${origin}/login?${params.toString()}`)
}

function safeNextPath(next: string): string {
  if (!next.startsWith("/") || next.startsWith("//")) return "/"
  return next
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const oauthError = searchParams.get("error")
  const oauthDesc = searchParams.get("error_description")

  if (oauthError) {
    const msg =
      oauthDesc?.replace(/\+/g, " ") ||
      oauthError ||
      "Sign-in was cancelled or failed."
    return loginRedirect(origin, msg)
  }

  const code = searchParams.get("code")
  const nextParam = searchParams.get("next") ?? "/"

  if (code) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

    if (!supabaseUrl || !supabaseAnonKey) {
      return NextResponse.redirect(`${origin}/login?error=Configuration`)
    }

    const nextPath = safeNextPath(nextParam)
    const redirectTo = `${origin}${nextPath}`

    // Build the redirect first so PKCE exchange can attach Set-Cookie headers to it.
    let response = NextResponse.redirect(redirectTo)

    const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
          } catch {
            /* ignore */
          }
        },
      },
    })

    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (error) {
      console.error("auth callback exchangeCodeForSession:", error.message)
      return loginRedirect(origin, error.message || "Could not complete sign-in.")
    }

    return response
  }

  return loginRedirect(origin, "Missing authorization code. Try signing in again.")
}
