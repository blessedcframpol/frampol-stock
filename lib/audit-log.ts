import { getSupabaseClient } from "@/lib/supabase/client"

export type AuditChange = [unknown, unknown]

export type AuditLogRow = {
  id: number
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
}

export type AuditLogFilters = {
  table: string
  row: string
  user: string
  from: string
  to: string
}

export function fetchAuditLog(filters: AuditLogFilters): Promise<AuditLogRow[]> {
  return getSupabaseClient()
    .rpc("audit_log_read", {
      p_table: filters.table || null,
      p_row: filters.row || null,
      p_user: filters.user || null,
      p_from: filters.from || null,
      p_to: filters.to || null,
    })
    .then(({ data, error }: { data: AuditLogRow[] | null; error: { message: string } | null }) => {
      if (error) throw new Error(error.message)
      return data ?? []
    })
}

export function formatAuditValue(value: unknown): string {
  if (value == null) return ""
  if (typeof value === "string") return value
  return JSON.stringify(value)
}
