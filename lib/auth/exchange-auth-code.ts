export type AuthSession = { access_token?: string }

export type AuthCodeClient = {
  auth: {
    exchangeCodeForSession: (code: string) => Promise<{ error: { message: string } | null }>
    getSession: () => Promise<{ data: { session: AuthSession | null } }>
  }
}

export type AuthCodeResult = { ok: true } | { ok: false; message: string }

/**
 * One in-flight exchange per authorization code for the life of the page load.
 * React Strict Mode runs the callback effect twice; a second
 * `exchangeCodeForSession` burns the code and returns
 * "Unable to exchange external code" even when the first call stored a session.
 */
const exchangeInFlight = new Map<string, Promise<AuthCodeResult>>()

export function resetAuthCodeExchangeGuardForTests(): void {
  exchangeInFlight.clear()
}

async function hasSession(client: AuthCodeClient, attempts: number): Promise<boolean> {
  const tries = Math.max(1, attempts)
  for (let i = 0; i < tries; i++) {
    const {
      data: { session },
    } = await client.auth.getSession()
    if (session) return true
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

async function exchangeOnce(
  client: AuthCodeClient,
  code: string,
  polls: number
): Promise<AuthCodeResult> {
  const { error } = await client.auth.exchangeCodeForSession(code)
  if (!error) return { ok: true }
  if (await hasSession(client, polls)) return { ok: true }
  return { ok: false, message: error.message }
}

export async function exchangeAuthCodeOnce(
  client: AuthCodeClient,
  code: string,
  options?: { sessionPollAttempts?: number }
): Promise<AuthCodeResult> {
  const polls = options?.sessionPollAttempts ?? 1
  const existing = exchangeInFlight.get(code)
  if (existing) {
    const result = await existing
    if (result.ok) return result
    if (await hasSession(client, polls)) return { ok: true }
    return result
  }

  const pending = exchangeOnce(client, code, polls)
  exchangeInFlight.set(code, pending)
  return pending
}
