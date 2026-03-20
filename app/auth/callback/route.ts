import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

function loginRedirect(origin: string, message: string) {
  const params = new URLSearchParams()
  params.set("error", message)
  return NextResponse.redirect(`${origin}/login?${params.toString()}`)
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
  const next = searchParams.get("next") ?? "/"

  if (code) {
    const cookieStore = await cookies()
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

    if (!supabaseUrl || !supabaseAnonKey) {
      return NextResponse.redirect(`${origin}/login?error=Configuration`)
    }

    const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Ignore in Route Handler
          }
        },
      },
    })

    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`)
    }
    console.error("auth callback exchangeCodeForSession:", error.message)
    return loginRedirect(origin, error.message || "Could not complete sign-in.")
  }

  return loginRedirect(origin, "Missing authorization code. Try signing in again.")
}
