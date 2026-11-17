/**
 * RT1 — shared Realtime catch-up / live-stock / connection signals.
 * No personal data in telemetry metadata.
 */

import { announceDashboardRefresh } from "@/lib/alerts"
import {
  announceNotificationsInbox,
  announceRequestQueuesRefresh,
} from "@/lib/notifications-live"
import { reportAppEvent } from "@/lib/report-app-event"

/** Debounced keep-alive catch-up (visibility / online / reconnect). */
export const REALTIME_CATCHUP_EVENT = "fram-stock:realtime-catchup"

/** Live stock batch ids that should merge into a loaded ledger. */
export const LIVE_STOCK_BATCH_EVENT = "fram-stock:live-stock-batch"

/** Header indicator: live vs reconnecting. */
export const REALTIME_CONNECTION_EVENT = "fram-stock:realtime-connection"

export type RealtimeConnectionStatus = "live" | "reconnecting"

export type LiveStockBatchDetail = {
  batchIds: string[]
  /** Max live_stock_events.created_at among the batched rows (ISO). */
  maxCreatedAt?: string
}

export type RealtimeConnectionDetail = { status: RealtimeConnectionStatus }

const CATCHUP_DEBOUNCE_MS = 600
const TELEMETRY_MIN_INTERVAL_MS = 60_000
/** Events older than this may have been pruned — fall back to a full ledger reload. */
export const LIVE_STOCK_CATCHUP_MAX_GAP_MS = 23 * 60 * 60 * 1000

let catchupTimer: number | undefined
let lastTelemetryAt = 0
let hiddenAtMs: number | null = null
/** Last live_stock_events.created_at this tab has applied (ISO). Tab-local. */
let lastLiveStockEventAt: string | null = null

export function getLastLiveStockEventAt(): string | null {
  return lastLiveStockEventAt
}

/** Advance the watermark when this tab applies live_stock_events (monotonic). */
export function noteLiveStockEventsApplied(createdAt: string | null | undefined): void {
  if (!createdAt) return
  const next = Date.parse(createdAt)
  if (!Number.isFinite(next)) return
  if (!lastLiveStockEventAt || next > Date.parse(lastLiveStockEventAt)) {
    lastLiveStockEventAt = createdAt
  }
}

/** Seed watermark after a full ledger load (or when none exists yet). */
export function seedLiveStockEventWatermark(createdAt?: string | null): void {
  if (createdAt && Number.isFinite(Date.parse(createdAt))) {
    lastLiveStockEventAt = createdAt
    return
  }
  if (!lastLiveStockEventAt) lastLiveStockEventAt = new Date().toISOString()
}

export function clearLiveStockEventWatermark(): void {
  lastLiveStockEventAt = null
}

export function announceRealtimeCatchup(): void {
  if (typeof window === "undefined") return
  if (catchupTimer) window.clearTimeout(catchupTimer)
  catchupTimer = window.setTimeout(() => {
    catchupTimer = undefined
    window.dispatchEvent(new Event(REALTIME_CATCHUP_EVENT))
    announceNotificationsInbox()
    announceRequestQueuesRefresh()
    announceDashboardRefresh()
  }, CATCHUP_DEBOUNCE_MS)
}

export function announceLiveStockBatches(
  batchIds: string[],
  maxCreatedAt?: string | null,
): void {
  if (typeof window === "undefined") return
  const unique = [...new Set(batchIds.map((id) => id.trim()).filter(Boolean))]
  if (unique.length === 0) return
  window.dispatchEvent(
    new CustomEvent<LiveStockBatchDetail>(LIVE_STOCK_BATCH_EVENT, {
      detail: {
        batchIds: unique,
        ...(maxCreatedAt ? { maxCreatedAt } : {}),
      },
    }),
  )
  announceDashboardRefresh()
}

export function announceRealtimeConnection(status: RealtimeConnectionStatus): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent<RealtimeConnectionDetail>(REALTIME_CONNECTION_EVENT, {
      detail: { status },
    }),
  )
}

/** Track tab hidden start so return telemetry can include duration. */
export function markRealtimeTabHidden(): void {
  if (hiddenAtMs == null) hiddenAtMs = Date.now()
}

export function takeHiddenDurationMs(): number | null {
  if (hiddenAtMs == null) return null
  const ms = Math.max(0, Date.now() - hiddenAtMs)
  hiddenAtMs = null
  return ms
}

type TelemetryKind = "disconnect" | "reconnect" | "hidden_return"

/**
 * Rate-limited Realtime lifecycle log → app_event_logs (≤1/min/user client-side).
 * Metadata is non-personal (kind + optional hiddenMs).
 */
export function reportRealtimeTelemetry(
  kind: TelemetryKind,
  extra?: { hiddenMs?: number },
): void {
  const now = Date.now()
  if (now - lastTelemetryAt < TELEMETRY_MIN_INTERVAL_MS) return
  lastTelemetryAt = now
  const message =
    kind === "disconnect"
      ? "Realtime disconnected"
      : kind === "reconnect"
        ? "Realtime reconnected"
        : "Tab visible after hidden"
  void reportAppEvent({
    severity: "info",
    source: "client",
    context: "realtime_lifecycle",
    message,
    metadata: {
      kind,
      ...(typeof extra?.hiddenMs === "number" ? { hiddenMs: Math.round(extra.hiddenMs) } : {}),
    },
  })
}
