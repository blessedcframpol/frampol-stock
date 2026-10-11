/** Pure scan-queue helpers for the admin issue screen (RQ3). */

export type IssueScanMode = "serial" | "cloud_key"

export type IssueScanSlot = {
  id: string
  lineId: string
  productId?: string
  productName: string
  serial: string | null
  cloudKey: string | null
  status: "empty" | "ok" | "error" | "awaiting_cloud_key"
  reason: string | null
  flash?: "success" | "error" | null
}

export type PreviewIssueScanResult =
  | {
      ok: true
      serial: string
      line_id: string
      product_id: string
      product_name: string
      needs_cloud_key: boolean
      cloud_key?: string | null
      cloud_key_prompt?: string
    }
  | {
      ok: false
      serial: string
      reason: string
    }

/** Split wedge input on Enter or Tab; keep incomplete trailing chunk. */
export function consumeScanBuffer(buffer: string): { complete: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "\n")
  const parts = normalized.split("\n")
  if (parts.length === 1) return { complete: [], rest: parts[0] ?? "" }
  const complete = parts.slice(0, -1).map((p) => p.trim()).filter(Boolean)
  return { complete, rest: parts[parts.length - 1] ?? "" }
}

export function enqueueScans(queue: string[], incoming: string[]): string[] {
  return [...queue, ...incoming]
}

export function takeNextScan(queue: string[]): { next: string | null; rest: string[] } {
  if (queue.length === 0) return { next: null, rest: queue }
  const [next, ...rest] = queue
  return { next, rest }
}

export function alreadyScannedSerials(slots: IssueScanSlot[]): string[] {
  return slots.map((s) => s.serial).filter((s): s is string => Boolean(s))
}

/** Fill the first empty slot on the matching line, or return null if none. */
export function applySuccessfulSerial(
  slots: IssueScanSlot[],
  preview: Extract<PreviewIssueScanResult, { ok: true }>,
): { slots: IssueScanSlot[]; mode: IssueScanMode; cloudKeyPrompt: string | null } | null {
  let idx = slots.findIndex((s) => s.lineId === preview.line_id && s.status === "empty")
  if (idx < 0 && preview.product_id) {
    idx = slots.findIndex((s) => s.productId === preview.product_id && s.status === "empty")
  }
  if (idx < 0) return null
  const next = slots.map((s, i) => {
    if (i !== idx) return { ...s, flash: null }
    if (preview.needs_cloud_key) {
      return {
        ...s,
        serial: preview.serial,
        cloudKey: null,
        status: "awaiting_cloud_key" as const,
        reason: null,
        flash: "success" as const,
      }
    }
    return {
      ...s,
      serial: preview.serial,
      cloudKey: preview.cloud_key ?? null,
      status: "ok" as const,
      reason: null,
      flash: "success" as const,
    }
  })
  return {
    slots: next,
    mode: preview.needs_cloud_key ? "cloud_key" : "serial",
    cloudKeyPrompt: preview.needs_cloud_key ? (preview.cloud_key_prompt ?? `Scan the cloud key for ${preview.serial}`) : null,
  }
}

export function applyFailedSerial(
  slots: IssueScanSlot[],
  serial: string,
  reason: string,
): IssueScanSlot[] {
  // Errors stay out of slots — flash is handled by the caller via a toast/banner row.
  return slots.map((s) => ({ ...s, flash: null }))
}

export function applyCloudKeyToAwaiting(
  slots: IssueScanSlot[],
  cloudKey: string,
): { slots: IssueScanSlot[]; ok: boolean; reason?: string } {
  const key = cloudKey.trim()
  if (!key) return { slots, ok: false, reason: "Cloud key is blank" }
  const idx = slots.findIndex((s) => s.status === "awaiting_cloud_key")
  if (idx < 0) return { slots, ok: false, reason: "No unit is waiting for a cloud key" }
  const next = slots.map((s, i) =>
    i === idx
      ? { ...s, cloudKey: key, status: "ok" as const, reason: null, flash: "success" as const }
      : { ...s, flash: null },
  )
  return { slots: next, ok: true }
}

export function removeSlotSerial(slots: IssueScanSlot[], slotId: string): IssueScanSlot[] {
  return slots.map((s) =>
    s.id === slotId
      ? {
          ...s,
          serial: null,
          cloudKey: null,
          status: "empty" as const,
          reason: null,
          flash: null,
        }
      : s,
  )
}

export function buildEmptySlots(
  lines: { id: string; product_id?: string; product_name: string; quantity_requested: number }[],
  issuedByLine: Record<string, number>,
): IssueScanSlot[] {
  const slots: IssueScanSlot[] = []
  for (const line of lines) {
    const issued = Math.min(line.quantity_requested, issuedByLine[line.id] ?? 0)
    const outstanding = Math.max(0, line.quantity_requested - issued)
    for (let i = 0; i < outstanding; i++) {
      slots.push({
        id: `${line.id}-${i}`,
        lineId: line.id,
        productId: line.product_id,
        productName: line.product_name,
        serial: null,
        cloudKey: null,
        status: "empty",
        reason: null,
        flash: null,
      })
    }
  }
  return slots
}

export function filledScansForIssue(slots: IssueScanSlot[]): { serial: string; lineId: string; cloudKey: string | null }[] {
  return slots
    .filter((s) => s.status === "ok" && s.serial)
    .map((s) => ({ serial: s.serial!, lineId: s.lineId, cloudKey: s.cloudKey }))
}

export function issueButtonLabel(filled: number, outstanding: number): {
  label: string
  needsConfirm: boolean
  confirmMessage: string | null
} {
  if (filled <= 0) return { label: "Issue units", needsConfirm: false, confirmMessage: null }
  if (filled < outstanding) {
    const left = outstanding - filled
    return {
      label: `Issue ${filled} of ${outstanding}`,
      needsConfirm: true,
      confirmMessage: `Issue ${filled} of ${outstanding}? The request stays open for ${left}.`,
    }
  }
  return {
    label: `Issue ${filled} unit${filled === 1 ? "" : "s"}`,
    needsConfirm: false,
    confirmMessage: null,
  }
}
