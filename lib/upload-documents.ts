export const UPLOAD_BUCKET = "uploads"
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
export const ALLOWED_UPLOAD_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const

export type UploadDocumentKind =
  | "quotation"
  | "delivery-note"
  | "decommission-document"
  | "invoice"

export function isAllowedUploadMimeType(
  value: string
): value is (typeof ALLOWED_UPLOAD_MIME_TYPES)[number] {
  return ALLOWED_UPLOAD_MIME_TYPES.includes(
    value as (typeof ALLOWED_UPLOAD_MIME_TYPES)[number]
  )
}

export async function uploadDocument(
  kind: UploadDocumentKind,
  scopeId: string,
  file: File
): Promise<string> {
  const body = new FormData()
  body.set("kind", kind)
  body.set("scopeId", scopeId)
  body.set("file", file)

  const response = await fetch("/api/uploads", {
    method: "POST",
    body,
  })
  const payload = (await response.json().catch(() => null)) as
    | { path?: string; error?: string }
    | null
  if (!response.ok || !payload?.path) {
    throw new Error(payload?.error || "Upload failed")
  }
  return payload.path
}
