/**
 * NT2/NT2c alert presets — Web Audio oscillators plus optional file sounds.
 * File buffers load lazily on first play for that id (never on page load).
 * Plays for new-request (issuers) and reminder pings only.
 */

export const ALERT_SOUND_IDS = [
  "chime",
  "soft_ping",
  "bright_ping",
  "attention",
  "alarm",
  "faaah",
] as const

export type AlertSoundId = (typeof ALERT_SOUND_IDS)[number]

export const ALERT_SOUND_LABELS: Record<AlertSoundId, string> = {
  chime: "Chime",
  soft_ping: "Soft ping",
  bright_ping: "Bright ping",
  attention: "Attention (loud)",
  alarm: "Alarm (loud)",
  faaah: "Faaah",
}

/** File-backed sounds (path under public/). Fetched only when played. */
const FILE_ALERT_SOUNDS = {
  faaah: "/sounds/faaah.mp3",
} as const satisfies Partial<Record<AlertSoundId, string>>

type FileAlertSoundId = keyof typeof FILE_ALERT_SOUNDS
type OscillatorSoundId = Exclude<AlertSoundId, FileAlertSoundId>

export function isAlertSoundId(value: string): value is AlertSoundId {
  return (ALERT_SOUND_IDS as readonly string[]).includes(value)
}

/** Map legacy NT2b stored id `josh` to `faaah`; otherwise validate. */
export function normalizeAlertSoundId(value: string | null | undefined): AlertSoundId | null {
  if (!value) return null
  if (value === "josh") return "faaah"
  return isAlertSoundId(value) ? value : null
}

type Tone = { freq: number; start: number; dur: number; type?: OscillatorType; gain?: number }

const PRESETS: Record<OscillatorSoundId, Tone[]> = {
  chime: [
    { freq: 880, start: 0, dur: 0.18 },
    { freq: 1175, start: 0.14, dur: 0.22 },
  ],
  soft_ping: [{ freq: 660, start: 0, dur: 0.28, type: "triangle", gain: 0.7 }],
  bright_ping: [
    { freq: 1320, start: 0, dur: 0.12 },
    { freq: 1760, start: 0.1, dur: 0.2 },
  ],
  attention: [
    { freq: 740, start: 0, dur: 0.16, gain: 1.2 },
    { freq: 990, start: 0.14, dur: 0.16, gain: 1.2 },
    { freq: 740, start: 0.3, dur: 0.22, gain: 1.3 },
  ],
  alarm: [
    { freq: 880, start: 0, dur: 0.12, gain: 1.4 },
    { freq: 1175, start: 0.12, dur: 0.12, gain: 1.4 },
    { freq: 880, start: 0.24, dur: 0.12, gain: 1.4 },
    { freq: 1175, start: 0.36, dur: 0.18, gain: 1.5 },
  ],
}

let sharedCtx: AudioContext | null = null
const fileBufferCache = new Map<string, AudioBuffer>()
const fileLoadInflight = new Map<string, Promise<AudioBuffer>>()

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null
  const Ctx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctx) return null
  if (!sharedCtx || sharedCtx.state === "closed") {
    sharedCtx = new Ctx()
  }
  return sharedCtx
}

/** True when the browser still needs a user gesture before audio can play. */
export function alertSoundNeedsGesture(): boolean {
  const ctx = getCtx()
  return !ctx || ctx.state === "suspended"
}

export async function resumeAlertAudio(): Promise<boolean> {
  const ctx = getCtx()
  if (!ctx) return false
  if (ctx.state === "suspended") {
    try {
      await ctx.resume()
    } catch {
      return false
    }
  }
  return ctx.state === "running"
}

async function ensureRunningCtx(): Promise<
  AudioContext | "needs_gesture" | "unsupported"
> {
  const ctx = getCtx()
  if (!ctx) return "unsupported"
  if (ctx.state === "suspended") {
    try {
      await ctx.resume()
    } catch {
      return "needs_gesture"
    }
  }
  if (ctx.state !== "running") return "needs_gesture"
  return ctx
}

async function loadFileBuffer(ctx: AudioContext, url: string): Promise<AudioBuffer> {
  const cached = fileBufferCache.get(url)
  if (cached) return cached
  let pending = fileLoadInflight.get(url)
  if (!pending) {
    pending = (async () => {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`alert sound fetch failed: ${res.status}`)
      const raw = await res.arrayBuffer()
      const buf = await ctx.decodeAudioData(raw.slice(0))
      fileBufferCache.set(url, buf)
      fileLoadInflight.delete(url)
      return buf
    })().catch((err) => {
      fileLoadInflight.delete(url)
      throw err
    })
    fileLoadInflight.set(url, pending)
  }
  return pending
}

async function playFileAlertSound(
  ctx: AudioContext,
  url: string,
  volume: number,
): Promise<"ok" | "unsupported"> {
  let buffer: AudioBuffer
  try {
    buffer = await loadFileBuffer(ctx, url)
  } catch {
    return "unsupported"
  }
  const master = Math.max(0, Math.min(1, volume))
  const source = ctx.createBufferSource()
  const gain = ctx.createGain()
  source.buffer = buffer
  gain.gain.value = master
  source.connect(gain)
  gain.connect(ctx.destination)
  source.start(0)
  return "ok"
}

function playOscillatorAlertSound(
  ctx: AudioContext,
  soundId: OscillatorSoundId,
  volume: number,
): "ok" {
  const tones = PRESETS[soundId] ?? PRESETS.chime
  const master = Math.max(0, Math.min(1, volume))
  const now = ctx.currentTime
  const gain = ctx.createGain()
  gain.connect(ctx.destination)
  gain.gain.setValueAtTime(0.0001, now)

  for (const tone of tones) {
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = tone.type ?? "sine"
    osc.frequency.value = tone.freq
    const peak = master * (tone.gain ?? 1) * 0.22
    const t0 = now + tone.start
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + tone.dur)
    osc.connect(g)
    g.connect(gain)
    osc.start(t0)
    osc.stop(t0 + tone.dur + 0.02)
  }

  return "ok"
}

export async function playAlertSound(
  soundId: AlertSoundId,
  volume = 0.55,
): Promise<"ok" | "needs_gesture" | "unsupported"> {
  const ctxOrStatus = await ensureRunningCtx()
  if (ctxOrStatus === "unsupported" || ctxOrStatus === "needs_gesture") {
    return ctxOrStatus
  }
  const ctx = ctxOrStatus
  const resolved = normalizeAlertSoundId(soundId) ?? "chime"

  if (resolved in FILE_ALERT_SOUNDS) {
    return playFileAlertSound(ctx, FILE_ALERT_SOUNDS[resolved as FileAlertSoundId], volume)
  }

  return playOscillatorAlertSound(ctx, resolved as OscillatorSoundId, volume)
}

/** Notification types that should trigger the opted-in alert sound. */
export function notificationShouldAlert(type: string, metadata?: Record<string, unknown> | null): boolean {
  if (type === "request_submitted" || type === "request_resubmitted") return true
  if (type === "request_unclaimed_reminder") return true
  if (metadata?.reminder === true) return true
  return false
}
