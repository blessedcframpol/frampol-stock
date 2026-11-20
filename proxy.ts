import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"
import { decideAuthGate } from "@/lib/auth-gate"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export async function proxy(request: NextRequest) {
  if (!supabaseUrl || !supabaseAnonKey) {
    return NextResponse.next()
  }

  // OAuth PKCE: verifier cookies must reach the Route Handler untouched. Running the
  // Supabase client here (e.g. getUser) can rewrite auth cookies before exchangeCodeForSession.
  const pathname = request.nextUrl.pathname
  if (pathname === "/auth/callback" || pathname.startsWith("/auth/callback/")) {
    return NextResponse.next({ request: { headers: request.headers } })
  }

  let response = NextResponse.next({ request: { headers: request.headers } })

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      // SSR contract: setAll must update request + response so chunk deletes
      // (HTTP 431 history) are visible to later getAll in the same request.
      setAll(cookiesToSet: { name: string; value: string; options?: Parameters<typeof response.cookies.set>[2] }[]) {
        cookiesToSet.forEach(({ name, value }) => {
          request.cookies.set(name, value)
        })
        response = NextResponse.next({ request: { headers: request.headers } })
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options)
        })
      },
    },
  })

  // One getUser() for both cookie refresh (incl. public paths) and the auth gate.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const decision = decideAuthGate(pathname, Boolean(user))
  if (decision.kind === "api_unauthorized") {
    return NextResponse.json(
      { error: "Unauthorized", requestId: crypto.randomUUID() },
      { status: 401 },
    )
  }
  if (decision.kind === "redirect_login") {
    const url = request.nextUrl.clone()
    url.pathname = "/login"
    url.searchParams.set("redirectTo", decision.redirectTo)
    return NextResponse.redirect(url)
  }

  return response
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
}
