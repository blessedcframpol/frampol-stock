import { createClient } from "@supabase/supabase-js"
import type { Database } from "./database.types"
import { createBrowserSupabaseClient } from "./browser"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

/** Use in client components only; returns session-aware browser client so RLS sees auth.uid(). */
export function getSupabaseClient() {
  if (typeof window !== "undefined") {
    return createBrowserSupabaseClient()
  }
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY")
  }
  return createClient<Database>(supabaseUrl, supabaseAnonKey)
}
