import { createClient } from "@supabase/supabase-js"
import type { Database } from "./database.types"

/** True when the service role key is set (admin API routes can run). */
export function isAdminApiConfigured(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  return Boolean(url && key)
}

/**
 * Server-only. Uses the service role key to bypass RLS.
 * Use only in API routes or server actions after verifying the current user is admin.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url?.trim() || !serviceRoleKey?.trim()) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY (and NEXT_PUBLIC_SUPABASE_URL) required for admin operations")
  }
  return createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
