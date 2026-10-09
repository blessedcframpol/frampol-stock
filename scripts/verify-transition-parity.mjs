/**
 * Transition-table parity: lib/stock-request-statuses.ts vs migration 049
 * tr_stock_requests_guard_status_transition.
 *
 * Matrix probes allowedTransitions() (UI API) against the DB guard. Ownership is
 * only varied for sales/technicians (roles that can own requests); admin/accounts
 * use a single owner=true pass to keep runtime under production statement_timeout.
 *
 * Each chunk runs in its own harness transaction capped at 60s (BEGIN…ROLLBACK).
 *
 * Does not cover serial-requirement or reservation-release (see verify-049).
 *
 * Usage:
 *   npm run verify:parity
 */
import { createRequire } from "module"
import { withHarness } from "./verify-harness.mjs"
import { setJwt } from "./verify-harness-fixtures.mjs"

const require = createRequire(import.meta.url)

const NOTES_PREFIX = "harness-parity"
const EMAIL_PREFIX = "harness-parity-"
const CHUNK_TIMEOUT_MS = 60_000

const STATUSES = /** @type {const} */ ([
  "draft",
  "submitted",
  "in_progress",
  "serviced",
  "invoiced",
  "cancelled",
])

/** Roles that exercise distinct transition edges in 049 / allowedTransitions. */
const ROLES = /** @type {const} */ (["admin", "sales", "accounts", "technicians"])

export const MARKERS = [
  {
    label: "stock_requests",
    sql: `SELECT count(*)::int AS n FROM public.stock_requests WHERE notes LIKE $1`,
    params: [`${NOTES_PREFIX}%`],
  },
  {
    label: "clients",
    sql: `SELECT count(*)::int AS n FROM public.clients WHERE id LIKE $1 OR email LIKE $2`,
    params: [`CLT-${NOTES_PREFIX}%`, `${EMAIL_PREFIX}%`],
  },
  {
    label: "users",
    sql: `SELECT count(*)::int AS n FROM auth.users WHERE email LIKE $1`,
    params: [`${EMAIL_PREFIX}%`],
  },
]

function stamp() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** Build the flat probe list (parity edges + documented self-noops). */
function buildProbes() {
  /** @type {{ kind: 'edge' | 'self', from: string, to: string, role: string, isOwner: boolean }[]} */
  const probes = []
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      if (from === to) continue
      for (const role of ROLES) {
        const ownerCases =
          role === "sales" || role === "technicians" ? [true, false] : [true]
        for (const isOwner of ownerCases) {
          probes.push({ kind: "edge", from, to, role, isOwner })
        }
      }
    }
  }
  for (const status of STATUSES) {
    probes.push({ kind: "self", from: status, to: status, role: "admin", isOwner: true })
  }
  return probes
}

/** Chunk so each harness transaction stays under the 60s budget on production. */
function chunkProbes(probes, size = 8) {
  const chunks = []
  for (let i = 0; i < probes.length; i += size) {
    chunks.push(probes.slice(i, i + size))
  }
  return chunks
}

/**
 * @param {import('./verify-harness.mjs').HarnessContext} ctx
 * @param {{ kind: string, from: string, to: string, role: string, isOwner: boolean }[]} chunk
 * @param {number} chunkIndex
 */
export async function runChecks(ctx, chunk, chunkIndex = 0) {
  const { db, pass, fail } = ctx

  require("tsx/cjs/api").register()
  const statusesApi = require("../lib/stock-request-statuses.ts")
  const allowedTransitions = statusesApi.allowedTransitions ?? statusesApi.default?.allowedTransitions
  if (typeof allowedTransitions !== "function") {
    throw new Error(
      `allowedTransitions missing after require (keys=${Object.keys(statusesApi).join(",")})`,
    )
  }

  await db.query(`SET LOCAL statement_timeout = '45s'`)

  const product = await db.query(
    `SELECT id, product_name FROM public.product_lines
     WHERE is_active
       AND coalesce(requires_serial, false) = false
       AND product_name NOT ILIKE '%starlink%'
     ORDER BY id
     LIMIT 1`,
  )
  if (!product.rows[0]) {
    throw new Error("no active non-serial product_lines row for stock_request_lines.product_id")
  }
  const productId = product.rows[0].id
  const productName = product.rows[0].product_name

  let clientId
  {
    const existing = await db.query(`SELECT id FROM public.clients LIMIT 1`)
    if (existing.rows[0]) {
      clientId = existing.rows[0].id
    } else {
      const ins = await db.query(
        `INSERT INTO public.clients (id, name, company, email)
         VALUES ($1, 'HarnessParity', 'HarnessParity Co', $2)
         RETURNING id`,
        [`CLT-${NOTES_PREFIX}-client`, `${EMAIL_PREFIX}client@test.local`],
      )
      clientId = ins.rows[0].id
    }
  }

  const tag = `c${chunkIndex}`
  const adminId = await ctx.createFixtureUser("admin", `${EMAIL_PREFIX}${tag}-admin@test.local`)
  const salesId = await ctx.createFixtureUser("sales", `${EMAIL_PREFIX}${tag}-sales@test.local`)
  const salesBId = await ctx.createFixtureUser("sales", `${EMAIL_PREFIX}${tag}-sales-b@test.local`)
  const accountsId = await ctx.createFixtureUser(
    "accounts",
    `${EMAIL_PREFIX}${tag}-accounts@test.local`,
  )
  const techId = await ctx.createFixtureUser(
    "technicians",
    `${EMAIL_PREFIX}${tag}-tech@test.local`,
  )

  /** @type {Record<string, { id: string, role: string }>} */
  const byRole = {
    admin: { id: adminId, role: "admin" },
    sales: { id: salesId, role: "sales" },
    accounts: { id: accountsId, role: "accounts" },
    technicians: { id: techId, role: "technicians" },
  }

  function statusPathTo(target) {
    switch (target) {
      case "draft":
        return []
      case "submitted":
        return ["submitted"]
      case "in_progress":
        return ["submitted", "in_progress"]
      case "serviced":
        return ["submitted", "in_progress", "serviced"]
      case "invoiced":
        return ["submitted", "in_progress", "serviced", "invoiced"]
      case "cancelled":
        return ["cancelled"]
      default:
        throw new Error(`Unknown target status ${target}`)
    }
  }

  async function asActor(userId, fn) {
    await setJwt(db, userId)
    try {
      return await fn()
    } finally {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '', true)`)
      await db.query(`SELECT set_config('request.jwt.claims', '', true)`)
    }
  }

  async function createRequestAt(ownerId, targetStatus) {
    const noteTag = stamp()
    const notes = `${NOTES_PREFIX} ${noteTag}`
    const { rows } = await db.query(
      `INSERT INTO public.stock_requests (client_id, created_by, status, notes)
       VALUES ($1, $2, 'draft', $3) RETURNING id::text AS id`,
      [clientId, ownerId, notes],
    )
    const requestId = rows[0].id

    await db.query(
      `INSERT INTO public.stock_request_lines
         (request_id, product_name, quantity_requested, sort_order, product_id)
       VALUES ($1, $2, 1, 0, $3)`,
      [requestId, `ParityWidget-${noteTag}`, productId],
    )

    if (targetStatus === "cancelled") {
      await asActor(ownerId, async () => {
        await db.query(`UPDATE public.stock_requests SET status = 'cancelled' WHERE id = $1`, [
          requestId,
        ])
      })
    } else {
      const path = statusPathTo(targetStatus)
      for (const next of path) {
        const actor = next === "submitted" || next === "cancelled" ? ownerId : adminId
        await asActor(actor, async () => {
          await db.query(`UPDATE public.stock_requests SET status = $2 WHERE id = $1`, [
            requestId,
            next,
          ])
        })
      }
    }

    const { rows: st } = await db.query(`SELECT status FROM public.stock_requests WHERE id = $1`, [
      requestId,
    ])
    if (st[0]?.status !== targetStatus) {
      throw new Error(`createRequestAt expected ${targetStatus}, got ${st[0]?.status}`)
    }
    return requestId
  }

  async function tryTransition(actorId, requestId, toStatus) {
    const sp = `sp_${Math.random().toString(36).slice(2, 10)}`
    await db.query(`SAVEPOINT ${sp}`)
    try {
      const outcome = await ctx.asUser(actorId, async () => {
        const res = await db.query(
          `UPDATE public.stock_requests SET status = $2 WHERE id = $1 RETURNING status`,
          [requestId, toStatus],
        )
        const ok = res.rowCount === 1 && res.rows[0]?.status === toStatus
        return {
          ok,
          rowCount: res.rowCount ?? 0,
          error: ok ? null : `rowCount=${res.rowCount} status=${res.rows[0]?.status ?? "n/a"}`,
        }
      })
      await db.query(`ROLLBACK TO SAVEPOINT ${sp}`)
      return outcome
    } catch (e) {
      await db.query(`ROLLBACK TO SAVEPOINT ${sp}`)
      return { ok: false, rowCount: 0, error: e instanceof Error ? e.message : String(e) }
    }
  }

  console.log(`\n=== Transition parity chunk ${chunkIndex + 1} (${chunk.length} probes) ===`)
  console.log(`Using product_id=${productId} (${productName})`)

  /** @type {Map<string, string>} */
  const requestCache = new Map()

  async function requestAt(ownerId, fromStatus) {
    const key = `${ownerId}:${fromStatus}`
    if (!requestCache.has(key)) {
      requestCache.set(key, await createRequestAt(ownerId, fromStatus))
    }
    return requestCache.get(key)
  }

  for (const probe of chunk) {
    if (probe.kind === "self") {
      const requestId = await requestAt(adminId, probe.from)
      const dbResult = await tryTransition(adminId, requestId, probe.to)
      const tsListsSelf = allowedTransitions(probe.from, "admin", true).includes(probe.to)
      const name = `self-noop ${probe.from}->${probe.to} (DB allows, TS omits)`
      if (dbResult.ok && !tsListsSelf) {
        pass(
          name,
          "documented asymmetry: trigger allows no-op status write; allowedTransitions omits self-edge",
        )
      } else {
        fail(
          name,
          `expected DB allow + TS omit; got db.ok=${dbResult.ok} tsListsSelf=${tsListsSelf}${
            dbResult.error ? ` (${String(dbResult.error).split("\n")[0]})` : ""
          }`,
        )
      }
      continue
    }

    const actor = byRole[probe.role]
    const actorId = !probe.isOwner && probe.role === "sales" ? salesBId : actor.id
    const ownerForRequest = probe.isOwner ? actor.id : salesId
    const tsAllows = allowedTransitions(probe.from, probe.role, probe.isOwner).includes(probe.to)
    const name = `${probe.from}->${probe.to} role=${probe.role} owner=${probe.isOwner}`

    const requestId = await requestAt(ownerForRequest, probe.from)
    const dbResult = await tryTransition(actorId, requestId, probe.to)

    if (tsAllows === dbResult.ok) {
      pass(
        name,
        tsAllows
          ? "both allowed"
          : `both denied${dbResult.error ? ` (${String(dbResult.error).split("\n")[0]})` : ""}`,
      )
    } else if (tsAllows && !dbResult.ok) {
      fail(name, `parity: TypeScript allowed, database denied — ${String(dbResult.error).split("\n")[0]}`)
    } else {
      fail(name, "parity: database allowed, TypeScript denied")
    }
  }
}

async function main() {
  const probes = buildProbes()
  const chunks = chunkProbes(probes, 8)
  let passed = 0
  let failed = 0

  console.log(
    `verify-parity — ${probes.length} probes in ${chunks.length} harness transactions (≤${CHUNK_TIMEOUT_MS / 1000}s each)`,
  )

  for (let i = 0; i < chunks.length; i += 1) {
    const { ok, failed: f, passed: p } = await withHarness(
      {
        markers: MARKERS,
        timeoutMs: CHUNK_TIMEOUT_MS,
        label: `verify-parity-${i + 1}/${chunks.length}`,
      },
      (ctx) => runChecks(ctx, chunks[i], i),
    )
    passed += p
    failed += f
    if (!ok) {
      console.error(`parity chunk ${i + 1}/${chunks.length} failed`)
    }
  }

  console.log(failed === 0 ? `\n${passed} passed` : `\n${failed} failed across chunks (${passed} passed)`)
  process.exitCode = failed === 0 ? 0 : 1
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-transition-parity.mjs")
if (isMain) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
