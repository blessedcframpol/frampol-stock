export type ParsedApiError = {
  error: string
  requestId?: string
  detail?: string
}

export function parseApiErrorBody(data: unknown): ParsedApiError | null {
  if (!data || typeof data !== "object") return null
  const o = data as Record<string, unknown>
  if (typeof o.error !== "string" || !o.error.trim()) return null
  const requestId = typeof o.requestId === "string" ? o.requestId : undefined
  const detail = typeof o.detail === "string" && o.detail.trim() ? o.detail.trim() : undefined
  return { error: o.error.trim(), requestId, detail }
}

type DbErrorLike = {
  code?: string
  message?: string
} | null | undefined

export function asDbErrorLike(caught: unknown): DbErrorLike {
  if (!caught || typeof caught !== "object") {
    if (typeof caught === "string") return { message: caught }
    return null
  }
  const o = caught as { code?: unknown; message?: unknown }
  const message =
    typeof o.message === "string"
      ? o.message
      : caught instanceof Error
        ? caught.message
        : undefined
  const code = typeof o.code === "string" ? o.code : undefined
  if (!message && !code) return null
  return { code, message }
}

/**
 * Map Postgres/PostgREST RLS failures (42501) to actionable copy for stock writes.
 * Returns null when the error is not an RLS violation we recognize.
 */
export function humanizeStockWriteRlsError(error: DbErrorLike): string | null {
  if (!error?.message?.trim()) return null
  const message = error.message
  const isRls =
    error.code === "42501" || /row-level security policy/i.test(message)
  if (!isRls) return null

  if (/transactions/i.test(message)) {
    return "Could not record movement — your session could not be verified. Sign out and back in, then retry."
  }
  if (/inventory_items/i.test(message)) {
    return "You do not have permission to change inventory."
  }
  return "You do not have permission to perform this action."
}

/**
 * Map stock-related DB errors (049 lifecycle P0001, 048 date CHECK, RLS) for UI.
 */
export function humanizeStockDbError(error: DbErrorLike): string | null {
  if (!error?.message?.trim() && !error?.code) return null
  const message = error?.message ?? ""

  if (/Invalid stock request transition/i.test(message) || /already moved on/i.test(message)) {
    return "This request has already moved to a different status. Refresh and try again."
  }
  if (/Cannot mark serviced/i.test(message)) {
    return "Assign all required serial numbers before marking this request serviced."
  }
  if (/ensure_product_line:\s*product .* already exists under vendor/i.test(message)) {
    return "That product name already exists in the catalog. Choose it from the list instead of adding it as new."
  }
  if (error?.code === "23514" || /transactions_date_iso_utc/i.test(message)) {
    return "Sale date must be a valid calendar date (YYYY-MM-DD) between 2020 and 2100."
  }

  return humanizeStockWriteRlsError(error)
}
