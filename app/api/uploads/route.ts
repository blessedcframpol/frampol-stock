import { NextResponse } from "next/server"
import {
  ALLOWED_PROBLEM_SCREENSHOT_MIME_TYPES,
  ALLOWED_UPLOAD_MIME_TYPES,
  isAllowedUploadMimeType,
  MAX_PROBLEM_REPORT_BYTES,
  MAX_UPLOAD_BYTES,
  UPLOAD_BUCKET,
  type UploadDocumentKind,
} from "@/lib/upload-documents"
import {
  ACCOUNTS,
  ADMIN,
  SALES,
  TECHNICIANS,
  VIEWER,
  type AppRole,
} from "@/lib/permissions"
import { requireWriteAccess } from "@/lib/require-write-access"

const ALLOWED_ROLES: Record<UploadDocumentKind, readonly AppRole[]> = {
  quotation: [ADMIN, SALES, TECHNICIANS],
  "delivery-note": [ADMIN, TECHNICIANS],
  "decommission-document": [ADMIN, TECHNICIANS],
  invoice: [ADMIN, ACCOUNTS],
  "problem-report": [ADMIN, SALES, ACCOUNTS, TECHNICIANS, VIEWER],
}

const PREFIX: Record<UploadDocumentKind, string> = {
  quotation: "quotations",
  "delivery-note": "delivery-notes",
  "decommission-document": "delivery-notes",
  invoice: "invoices",
  "problem-report": "problem-reports",
}

const EXTENSION: Record<(typeof ALLOWED_UPLOAD_MIME_TYPES)[number], string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
}

function isUploadKind(value: string): value is UploadDocumentKind {
  return Object.prototype.hasOwnProperty.call(ALLOWED_ROLES, value)
}

function safeScope(value: string): string | null {
  const trimmed = value.trim()
  return /^[A-Za-z0-9_-]{1,128}$/.test(trimmed) ? trimmed : null
}

export async function POST(request: Request) {
  // Viewers may attach problem-report screenshots only; per-kind ALLOWED_ROLES enforces the rest.
  const auth = await requireWriteAccess("uploads POST", [
    ADMIN,
    SALES,
    ACCOUNTS,
    TECHNICIANS,
    VIEWER,
  ])
  if (!auth.ok) return auth.response
  const { role, supabase, user } = auth

  const form = await request.formData()
  const kindValue = form.get("kind")
  const scopeValue = form.get("scopeId")
  const fileValue = form.get("file")
  if (
    typeof kindValue !== "string" ||
    !isUploadKind(kindValue) ||
    typeof scopeValue !== "string" ||
    !(fileValue instanceof File)
  ) {
    return NextResponse.json({ error: "Invalid upload request" }, { status: 400 })
  }
  if (!role || !ALLOWED_ROLES[kindValue].includes(role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const scopeId = safeScope(scopeValue)
  if (!scopeId) {
    return NextResponse.json({ error: "Invalid upload scope" }, { status: 400 })
  }
  if (kindValue === "problem-report" && scopeId !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  const maxBytes = kindValue === "problem-report" ? MAX_PROBLEM_REPORT_BYTES : MAX_UPLOAD_BYTES
  if (fileValue.size <= 0 || fileValue.size > maxBytes) {
    return NextResponse.json(
      {
        error:
          kindValue === "problem-report"
            ? "Screenshot must be between 1 byte and 5 MB"
            : "File must be between 1 byte and 10 MB",
      },
      { status: 413 }
    )
  }
  if (kindValue === "problem-report") {
    if (!(ALLOWED_PROBLEM_SCREENSHOT_MIME_TYPES as readonly string[]).includes(fileValue.type)) {
      return NextResponse.json(
        {
          error: `Unsupported file type. Allowed: ${ALLOWED_PROBLEM_SCREENSHOT_MIME_TYPES.join(", ")}`,
        },
        { status: 415 }
      )
    }
  } else if (!isAllowedUploadMimeType(fileValue.type)) {
    return NextResponse.json(
      {
        error: `Unsupported file type. Allowed: ${ALLOWED_UPLOAD_MIME_TYPES.join(", ")}`,
      },
      { status: 415 }
    )
  }

  const category = kindValue === "decommission-document" ? "decommissioned" : scopeId
  const objectPath = `${PREFIX[kindValue]}/${category}/${crypto.randomUUID()}.${
    EXTENSION[fileValue.type as keyof typeof EXTENSION]
  }`
  const { error } = await supabase.storage.from(UPLOAD_BUCKET).upload(objectPath, fileValue, {
    contentType: fileValue.type,
    upsert: false,
  })
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  return NextResponse.json({ path: objectPath }, { status: 201 })
}
