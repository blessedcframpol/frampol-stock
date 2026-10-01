import { describe, expect, it, beforeEach } from "vitest"
import {
  exchangeAuthCodeOnce,
  resetAuthCodeExchangeGuardForTests,
  type AuthCodeClient,
  type AuthSession,
} from "@/lib/auth/exchange-auth-code"

function client(opts: {
  exchange: () => Promise<{ error: { message: string } | null }>
  session: () => AuthSession | null
}): AuthCodeClient {
  return {
    auth: {
      exchangeCodeForSession: opts.exchange,
      getSession: async () => ({ data: { session: opts.session() } }),
    },
  }
}

describe("exchangeAuthCodeOnce", () => {
  beforeEach(() => {
    resetAuthCodeExchangeGuardForTests()
  })

  it("exchanges a code once when invoked twice, and redirects if a session already exists after the exchange fails", async () => {
    let calls = 0
    let session: AuthSession | null = null
    let release!: (result: { error: { message: string } | null }) => void
    const gate = new Promise<{ error: { message: string } | null }>((resolve) => {
      release = resolve
    })

    const auth = client({
      exchange: () => {
        calls += 1
        return gate
      },
      session: () => session,
    })

    const first = exchangeAuthCodeOnce(auth, "code-1")
    const second = exchangeAuthCodeOnce(auth, "code-1")
    await Promise.resolve()
    expect(calls).toBe(1)

    session = { access_token: "stored-by-first-exchange" }
    release({ error: { message: "Unable to exchange external code: 1.AS" } })

    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual({ ok: true })
    expect(b).toEqual({ ok: true })
    expect(calls).toBe(1)
  })

  it("returns the exchange error when no session was stored", async () => {
    const auth = client({
      exchange: async () => ({ error: { message: "Unable to exchange external code: 1.AS" } }),
      session: () => null,
    })
    await expect(exchangeAuthCodeOnce(auth, "code-2")).resolves.toEqual({
      ok: false,
      message: "Unable to exchange external code: 1.AS",
    })
  })
})
