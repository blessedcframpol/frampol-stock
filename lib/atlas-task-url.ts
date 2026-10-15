/**
 * Shared Atlas task-link rules (mirrored in public.atlas_task_id_from_url).
 * Accept when host is ai.frampolafrica.com, port is 10801 or absent, and
 * query param `task` is a UUID. Any path; extra query params OK.
 */

const ATLAS_HOST = "ai.frampolafrica.com"
const ATLAS_PORT = "10801"
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const ATLAS_TASK_LINK_HINT =
  "That doesn't look like an Atlas task link. Open the task in Atlas and copy the address from the browser."

export const ATLAS_TASK_URL_EXAMPLE =
  "https://ai.frampolafrica.com:10801/my-tasks?view=all&task=<task-id>"

export type ParsedAtlasTaskUrl = {
  /** Trimmed input as stored after a successful parse. */
  url: string
  taskId: string
}

/** Parse a pasted Atlas link. Null when invalid (never throws). */
export function parseAtlasTaskUrl(value: string | null | undefined): ParsedAtlasTaskUrl | null {
  const trimmed = (value ?? "").trim()
  if (!trimmed) return null

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
  if (parsed.hostname.toLowerCase() !== ATLAS_HOST) return null
  if (parsed.port && parsed.port !== ATLAS_PORT) return null

  const task = parsed.searchParams.get("task")?.trim() ?? ""
  if (!UUID_RE.test(task)) return null

  return { url: trimmed, taskId: task.toLowerCase() }
}

/** Null when acceptable. Empty → required; bad shape → fixed user-facing copy. */
export function atlasTaskUrlProblem(value: string): string | null {
  return atlasTaskUrlProblemWhenRequired(value, true)
}

/** When Atlas link is optional (outage mode), empty is OK; invalid shape is still rejected. */
export function atlasTaskUrlProblemWhenRequired(value: string, required: boolean): string | null {
  const trimmed = value.trim()
  if (!trimmed) return required ? "Atlas task link is required" : null
  if (!parseAtlasTaskUrl(trimmed)) return ATLAS_TASK_LINK_HINT
  return null
}
