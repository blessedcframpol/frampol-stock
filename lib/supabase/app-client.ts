import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "./database.types"

/** Shared typed client for browser + server helpers. */
export type AppSupabaseClient = SupabaseClient<Database>
