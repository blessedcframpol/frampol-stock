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
