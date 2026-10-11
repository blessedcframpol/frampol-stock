import { getSupabaseClient } from "@/lib/supabase/client"

export type AuditChange = [unknown, unknown]

export type AuditLogRow = {
  id: number
  seq?: number
  table_name: string
  row_id: string
  action: string
  changed: Record<string, AuditChange>
  actor: string
  actor_name: string | null
  source: string
  reason: string | null
  at: string
  transaction_id: number
  row_hash?: string
}

export type AuditLogFilters = {
  table: string
  row: string
  user: string
  action: string
  from: string
  to: string
}

export type AuthSignInRow = {
  id: string
  at: string
  ip_address: string | null
  action: string | null
  actor_id: string | null
  actor_email: string | null
  actor_name: string | null
}

export type AuditExceptionRow = {
  id: number
  seq?: number
  at: string
  table_name: string
  row_id: string
  action: string
  source: string
  actor: string
  actor_name: string | null
  reason: string | null
  category: string
  changed: Record<string, AuditChange>
}

export async function fetchAuditLog(filters: AuditLogFilters): Promise<AuditLogRow[]> {
  const { data, error } = await getSupabaseClient().rpc("audit_log_read", {
    p_table: filters.table || null,
    p_row: filters.row || null,
    p_user: filters.user || null,
    p_from: filters.from || null,
    p_to: filters.to || null,
    p_action: filters.action || null,
  })
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as AuditLogRow[]
}

export async function fetchAuthSignIns(filters: {
  user: string
  from: string
  to: string
}): Promise<AuthSignInRow[]> {
  const { data, error } = await getSupabaseClient().rpc("auth_sign_ins_read", {
    p_user: filters.user || null,
    p_from: filters.from || null,
    p_to: filters.to || null,
  })
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as AuthSignInRow[]
}

export async function fetchAuditExceptions(from: string, to: string): Promise<AuditExceptionRow[]> {
  const { data, error } = await getSupabaseClient().rpc("audit_exceptions_read", {
    p_from: from || null,
    p_to: to || null,
  })
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as AuditExceptionRow[]
}

export function formatAuditValue(value: unknown): string {
  if (value == null) return ""
  if (typeof value === "string") return value
  return JSON.stringify(value)
}

export function weekRangeInTz(timeZone: string, now = new Date()): { from: string; to: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  const to = fmt.format(now)
  const start = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000)
  const from = fmt.format(start)
  return { from, to }
}
