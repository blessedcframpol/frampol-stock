import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { createStorageFromOptions } from "@supabase/ssr/dist/module/cookies.js"
import type { Database } from "./database.types"

function getCookieOptionsForCurrentOrigin(): { secure: boolean } | undefined {
  if (typeof window === "undefined") return undefined
  return { secure: window.location.protocol === "https:" }
}

function getBrowserAuthStorage() {
  const cookieOptions = getCookieOptionsForCurrentOrigin()
  const { storage } = createStorageFromOptions(
    {
      cookieEncoding: "base64url",
      ...(cookieOptions ? { cookieOptions } : {}),
    },
    false
  )
  return storage
}

/**
 * Supabase + PKCE: @supabase/ssr's createBrowserClient forces `detectSessionInUrl: true`.
 * That parses `?code=` as soon as the client is constructed — including inside `AuthProvider`
 * on `/auth/callback`, which races manual `exchangeCodeForSession` and yields
 * "PKCE code verifier not found". We use cookie storage from ssr + `createClient` with
 * `detectSessionInUrl: false`; OAuth and email links are completed on `/auth/callback` explicitly.
 */
function createPkceBrowserClient(): SupabaseClient<Database> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY")
  }

  return createClient<Database>(supabaseUrl, supabaseAnonKey, {
    auth: {
      flowType: "pkce",
      persistSession: true,
      autoRefreshToken: typeof window !== "undefined",
      detectSessionInUrl: false,
      storage: getBrowserAuthStorage(),
    },
  })
}

let cachedBrowserClient: SupabaseClient<Database> | null = null

export function createBrowserSupabaseClient(): SupabaseClient<Database> {
  if (typeof window !== "undefined" && cachedBrowserClient) {
    return cachedBrowserClient
  }
  const client = createPkceBrowserClient()
  if (typeof window !== "undefined") {
    cachedBrowserClient = client
  }
  return client
}

/** Fresh client for `/auth/callback` so exchange logic isn’t tied to the global singleton. */
export function createAuthReturnBrowserClient(): SupabaseClient<Database> {
  return createPkceBrowserClient()
}
