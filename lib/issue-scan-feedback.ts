/** Short success / error tones for the issue scan box. Respects notifications mute. */

export function playIssueScanSuccess(): void {
  playTone([
    [0, 880],
    [0.08, 1175],
  ])
}

export function playIssueScanError(): void {
  playTone([
    [0, 220],
    [0.12, 165],
  ])
}

function playTone(notes: readonly (readonly [number, number])[]): void {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const gain = ctx.createGain()
    gain.connect(ctx.destination)
    const now = ctx.currentTime
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28)
    for (const [offset, freq] of notes) {
      const osc = ctx.createOscillator()
      osc.type = "sine"
      osc.frequency.value = freq
      osc.connect(gain)
      osc.start(now + offset)
      osc.stop(now + offset + 0.14)
    }
    window.setTimeout(() => void ctx.close().catch(() => undefined), 500)
  } catch {
    // No audio available.
  }
}

export function requestIsAllFortinet(
  lines: { vendor?: string | null }[]
): boolean {
  return lines.length > 0 && lines.every((l) => (l.vendor ?? "").trim().toLowerCase() === "fortinet")
}
