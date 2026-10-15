import { REJECT_REASON_LABELS } from "@/lib/stock-request-statuses"

export type RequestEventLike = {
  event_type: string
  payload: unknown
}

export type RequestEventView = {
  title: string
  detail: string | null
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`
}

/** Plain-language title and detail for one row of stock_request_events. */
export function describeRequestEvent(event: RequestEventLike): RequestEventView {
  const p = asRecord(event.payload)
  switch (event.event_type) {
    case "submitted": {
      const lines = count(p.line_count)
      return {
        title: "Submitted",
        detail: lines != null ? plural(lines, "line") : null,
      }
    }
    case "resubmitted":
      return { title: "Resubmitted", detail: null }
    case "rejected": {
      const code = text(p.reason_code)
      const label = code ? (REJECT_REASON_LABELS[code] ?? code) : null
      const note = text(p.note)
      return { title: "Rejected", detail: [label, note].filter(Boolean).join(" — ") || null }
    }
    case "cancelled":
      return { title: "Cancelled", detail: text(p.reason) }
    case "closed_outstanding": {
      const out = count(p.outstanding_count)
      const reason = text(p.reason)
      return {
        title: "Outstanding units closed",
        detail: [out != null ? `${plural(out, "unit")} not issued` : null, reason].filter(Boolean).join(" — ") || null,
      }
    }
    case "units_issued": {
      const n = count(p.count)
      const serials = Array.isArray(p.serials) ? p.serials.filter((s): s is string => typeof s === "string") : []
      const outstanding = count(p.outstanding_after)
      const parts = [
        serials.length ? serials.join(", ") : null,
        outstanding != null ? (outstanding === 0 ? "Fully issued" : `${outstanding} still outstanding`) : null,
      ].filter(Boolean)
      return {
        title: n != null ? `${plural(n, "unit")} issued` : "Units issued",
        detail: parts.join(" · ") || null,
      }
    }
    case "invoice_set": {
      const status = text(p.new_status)
      const number = text(p.new_invoice_number)
      const reason = text(p.reason)
      const what =
        status === "invoiced"
          ? `Invoice ${number ?? ""}`.trim()
          : status === "not_invoiced"
            ? `00000 — ${text(p.not_invoiced_kind) ?? "not invoiced"}`
            : "Invoice pending"
      return { title: "Invoice updated", detail: [what, reason].filter(Boolean).join(" — ") }
    }
    case "not_invoiced_approved": {
      const kind = text(p.not_invoiced_kind)
      return { title: "00000 approved", detail: kind }
    }
    case "issue_lock_takeover": {
      return { title: "Issue screen taken over", detail: null }
    }
    case "atlas_link_set": {
      const url = text(p.atlas_task_url)
      return { title: "Atlas task link added", detail: url }
    }
    default:
      return { title: event.event_type.replaceAll("_", " "), detail: null }
  }
}
