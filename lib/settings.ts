/**
 * Settings persisted to localStorage (client-only).
 * Used for low-stock email recipients and reorder levels until a DB is connected.
 */

const PREFIX = "fram-stock-settings"
const KEY_EMAILS_ENABLED = `${PREFIX}-low-stock-emails-enabled`
const KEY_EMAIL_RECIPIENTS = `${PREFIX}-low-stock-email-recipients`
const KEY_REORDER_DEFAULT = `${PREFIX}-reorder-level-default`
const KEY_REORDER_OVERRIDES = `${PREFIX}-reorder-level-overrides`

const DEFAULT_REORDER_LEVEL = 2

function getItem<T>(key: string, defaultValue: T, parse: (s: string) => T): T {
  if (typeof window === "undefined") return defaultValue
  try {
    const raw = localStorage.getItem(key)
    if (raw == null) return defaultValue
    return parse(raw)
  } catch {
    return defaultValue
  }
}

function setItem(key: string, value: string): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(key, value)
  } catch {
    // ignore
  }
}

export function getLowStockEmailsEnabled(): boolean {
  return getItem(KEY_EMAILS_ENABLED, true, (s) => s === "true")
}

export function setLowStockEmailsEnabled(enabled: boolean): void {
  setItem(KEY_EMAILS_ENABLED, String(enabled))
}

export function getLowStockEmailRecipients(): string[] {
  return getItem(KEY_EMAIL_RECIPIENTS, [], (s) => {
    try {
      const arr = JSON.parse(s) as unknown
      return Array.isArray(arr) && arr.every((x) => typeof x === "string") ? arr : []
    } catch {
      return []
    }
  })
}

export function setLowStockEmailRecipients(emails: string[]): void {
  setItem(KEY_EMAIL_RECIPIENTS, JSON.stringify(emails))
}

export function getReorderLevelDefault(): number {
  const n = getItem(KEY_REORDER_DEFAULT, DEFAULT_REORDER_LEVEL, (s) => parseInt(s, 10))
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_REORDER_LEVEL
}

export function setReorderLevelDefault(value: number): void {
  const n = Number.isFinite(value) && value >= 0 ? value : DEFAULT_REORDER_LEVEL
  setItem(KEY_REORDER_DEFAULT, String(n))
}

export function getReorderLevelOverrides(): Record<string, number> {
  return getItem(KEY_REORDER_OVERRIDES, {}, (s) => {
    try {
      const obj = JSON.parse(s) as unknown
      if (obj == null || typeof obj !== "object") return {}
      const out: Record<string, number> = {}
      for (const [k, v] of Object.entries(obj)) {
        if (typeof k === "string" && typeof v === "number" && Number.isFinite(v) && v >= 0) {
          out[k] = v
        }
      }
      return out
    } catch {
      return {}
    }
  })
}

export function setReorderLevelOverrides(overrides: Record<string, number>): void {
  setItem(KEY_REORDER_OVERRIDES, JSON.stringify(overrides))
}

export type ClientSettingsSnapshot = {
  emailsEnabled: boolean
  emailRecipients: string[]
  reorderDefault: number
  overrides: Record<string, number>
}

const SERVER_SETTINGS: ClientSettingsSnapshot = {
  emailsEnabled: true,
  emailRecipients: [],
  reorderDefault: DEFAULT_REORDER_LEVEL,
  overrides: {},
}

let settingsSnapshot: ClientSettingsSnapshot = SERVER_SETTINGS
let settingsSnapshotKey = ""

function settingsStorageKey(): string {
  if (typeof window === "undefined") return ""
  return [
    localStorage.getItem(KEY_EMAILS_ENABLED),
    localStorage.getItem(KEY_EMAIL_RECIPIENTS),
    localStorage.getItem(KEY_REORDER_DEFAULT),
    localStorage.getItem(KEY_REORDER_OVERRIDES),
  ].join("\0")
}

export function subscribeClientSettings(onStoreChange: () => void): () => void {
  window.addEventListener("storage", onStoreChange)
  return () => window.removeEventListener("storage", onStoreChange)
}

export function getClientSettingsSnapshot(): ClientSettingsSnapshot {
  const key = settingsStorageKey()
  if (key === settingsSnapshotKey) return settingsSnapshot
  settingsSnapshotKey = key
  settingsSnapshot = {
    emailsEnabled: getLowStockEmailsEnabled(),
    emailRecipients: getLowStockEmailRecipients(),
    reorderDefault: getReorderLevelDefault(),
    overrides: getReorderLevelOverrides(),
  }
  return settingsSnapshot
}

export function getClientSettingsServerSnapshot(): ClientSettingsSnapshot {
  return SERVER_SETTINGS
}

/** Threshold for a product: override if set, otherwise default. */
export function getReorderLevelForProduct(productName: string): number {
  const overrides = getReorderLevelOverrides()
  if (productName in overrides) return overrides[productName]
  return getReorderLevelDefault()
}
