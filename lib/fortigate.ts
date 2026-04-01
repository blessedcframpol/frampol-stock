/**
 * FortiGate products need cloud keys when moving out (Sale, POC, rental, transfer, dispose).
 * Inbound only requires serial numbers.
 */
export function isFortigateProductName(name: string): boolean {
  return name.trim().toLowerCase().includes("fortigate")
}

/** Split comma/newline-separated values (same rules as serial lists). */
export function splitDelimitedValues(input: string): string[] {
  return input
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function cloudKeysMapForSerials(serials: string[], keys: string[]): Record<string, string> | null {
  if (serials.length !== keys.length) return null
  const out: Record<string, string> = {}
  for (let i = 0; i < serials.length; i++) {
    const s = serials[i]!.trim()
    const k = keys[i]!.trim()
    if (!s || !k) return null
    out[s] = k
  }
  return out
}
