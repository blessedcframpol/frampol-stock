import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/supabase/database.types"

export const DIRECT_NO_REQUEST = "Direct — no request"

export type BatchRequestContext = {
  batchId: string
  requestId: string
  requestNumber: string
  requesterName: string
  atlasTaskUrl: string | null
}

/** Raw `batch_id` / txn id used by `batch_request_context`, from a UI `b:` / `l:` / `u:` key. */
export function requestLookupBatchId(batchKey: string | null | undefined, fallbackId?: string | null): string | null {
  const key = (batchKey ?? "").trim()
  if (key.startsWith("b:") && key.length > 2) return key.slice(2)
  if (key.startsWith("u:") && key.length > 2) return key.slice(2)
  const fallback = (fallbackId ?? "").trim()
  return fallback || null
}

type CtxClient = Pick<SupabaseClient<Database>, "rpc">

/** Load request context for movement batches via `batch_request_context_for` (RLS-safe). */
export async function loadBatchRequestContext(
  supabase: CtxClient,
  batchIds: Iterable<string | null | undefined>,
): Promise<Map<string, BatchRequestContext>> {
  const ids = [...new Set([...batchIds].map((id) => (id ?? "").trim()).filter(Boolean))]
  const out = new Map<string, BatchRequestContext>()
  if (ids.length === 0) return out

  const chunk = 80
  for (let index = 0; index < ids.length; index += chunk) {
    const slice = ids.slice(index, index + chunk)
    const { data, error } = await supabase.rpc("batch_request_context_for", { p_batch_ids: slice })
    if (error) throw new Error(error.message)
    for (const row of data ?? []) {
      if (!row.batch_id || !row.request_id || !row.request_number) continue
      out.set(row.batch_id, {
        batchId: row.batch_id,
        requestId: row.request_id,
        requestNumber: row.request_number,
        requesterName: row.requester_name?.trim() || "—",
        atlasTaskUrl: row.atlas_task_url?.trim() || null,
      })
    }
  }
  return out
}

export function requestHref(requestId: string): string {
  return `/requests/${requestId}`
}
