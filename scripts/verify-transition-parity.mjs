/**
 * Transition-table parity: lib/stock-request-statuses.ts vs migration 049
 * tr_stock_requests_guard_status_transition.
 *
 * Matrix is derived from the six statuses × four roles × owner/non-owner, calling
 * allowedTransitions() (the public API the UI uses). The raw STOCK_REQUEST_TRANSITIONS
 * table is not imported — under tsx/.mjs interop named exports arrive only on `default`.
 *
 * Does not cover serial-requirement or reservation-release (see verify-049).
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SUPABASE_DB_URL (or DATABASE_URL)
 *
 * Safety:
 *   VERIFY_PARITY_I_KNOW_THIS_IS_NOT_PROD=1  — required or the script exits.
 *
 * Usage:
 *   VERIFY_PARITY_I_KNOW_THIS_IS_NOT_PROD=1 npm run verify:parity
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"
import { createClient } from "@supabase/supabase-js"

const require = createRequire(import.meta.url)
const { prepareVerifyEnv } = require("./verify-env.cjs")

const FIXTURE_PASSWORD = "VerifyParity!Transition-Temp"
const ID_PREFIX_INV = "inv-vparity-"
const ID_PREFIX_PL = "pl-vparity-"

const STATUSES = /** @type {const} */ ([
  "draft",
  "submitted",
  "in_progress",
  "serviced",
  "invoiced",
  "cancelled",
])

const ROLES = /** @type {const} */ (["admin", "sales", "accounts", "technicians"])

const EMAIL = {
  admin: "verify-parity-admin@example.com",
  sales: "verify-parity-sales@example.com",
  salesB: "verify-parity-sales-b@example.com",
  accounts: "verify-parity-accounts@example.com",
  tech: "verify-parity-tech@example.com",
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function stamp() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

async function main() {
  prepareVerifyEnv()

  // tsx loads the .ts module as CJS when imported from this .mjs, so the ESM
  // namespace only exposes `default` / `module.exports`. Named bindings like
  // `mod.allowedTransitions` are undefined — real exports live on mod.default.
  // Do not "fix" this back to a named destructure.
  const mod = await import("../lib/stock-request-statuses.ts")
  console.log("stock-request-statuses import keys:", Object.keys(mod))
  const statusesApi = mod.default ?? mod
  const allowedTransitions = statusesApi.allowedTransitions
  assert(
    typeof allowedTransitions === "function",
    `allowedTransitions missing after import (keys=${Object.keys(mod).join(",")})`
  )

  if (process.env.VERIFY_PARITY_I_KNOW_THIS_IS_NOT_PROD !== "1") {
    console.error(
      "Refusing to run against a database without VERIFY_PARITY_I_KNOW_THIS_IS_NOT_PROD=1"
    )
    process.exit(1)
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL

  assert(url, "Missing NEXT_PUBLIC_SUPABASE_URL")
  assert(serviceKey, "Missing SUPABASE_SERVICE_ROLE_KEY")
  assert(dbUrl, "Missing SUPABASE_DB_URL or DATABASE_URL")

  let pg
  try {
    pg = require("pg")
  } catch {
    console.error("Missing dependency `pg`. Install with: npm install -D pg")
    process.exit(1)
  }

  const supabaseAdmin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const admin = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
  await admin.connect()
  console.log("Connected to Postgres")

  /** @type {Array<Record<string, unknown>>} */
  const checks = []
  const fixtureUserIds = []
  const cleanup = {
    requests: /** @type {string[]} */ ([]),
    inventory: /** @type {string[]} */ ([]),
    productLines: /** @type {string[]} */ ([]),
  }

  function recordCheck(entry) {
    checks.push(entry)
    const tag = entry.result === "PASS" ? "PASS" : "FAIL"
    console.log(`${tag}  ${entry.name} — ${entry.reason}`)
  }

  async function setJwt(client, userId) {
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ])
  }

  /** JWT + SET LOCAL ROLE authenticated (RLS on). Fresh client; always ROLLBACKs. */
  async function asUserRollback(userId, fn) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
    await client.connect()
    try {
      await client.query("BEGIN")
      await setJwt(client, userId)
      await client.query(`SET LOCAL ROLE authenticated`)
      try {
        return await fn(client)
      } finally {
        try {
          await client.query("ROLLBACK")
        } catch {
          /* ignore */
        }
      }
    } finally {
      await client.end()
    }
  }

  /**
   * JWT only — stays as table owner so RLS does not block fixture walks.
   * get_my_role() / auth.uid() still resolve from the JWT.
   */
  async function asActor(userId, fn) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
    await client.connect()
    try {
      await client.query("BEGIN")
      await setJwt(client, userId)
      const result = await fn(client)
      await client.query("COMMIT")
      return result
    } catch (e) {
      try {
        await client.query("ROLLBACK")
      } catch {
        /* ignore */
      }
      throw e
    } finally {
      await client.end()
    }
  }

  async function deleteFixtureUsersByEmail() {
    const { rows } = await admin.query(
      `SELECT id::text AS id, email FROM public.profiles WHERE email LIKE 'verify-parity-%'`
    )
    for (const r of rows) {
      const { error } = await supabaseAdmin.auth.admin.deleteUser(r.id)
      if (error) console.warn(`Could not delete fixture ${r.email}: ${error.message}`)
      else console.log(`Deleted leftover fixture ${r.email}`)
    }
  }

  async function createFixtureUser(email, role) {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: FIXTURE_PASSWORD,
      email_confirm: true,
    })
    if (error) throw new Error(`createUser(${email}): ${error.message}`)
    const id = data.user.id
    fixtureUserIds.push(id)
    await admin.query(
      `UPDATE public.profiles SET role = $2::public.app_role, active = true WHERE id = $1`,
      [id, role]
    )
    const { rows } = await admin.query(
      `SELECT id::text AS id, email, role::text AS role, active FROM public.profiles WHERE id = $1`,
      [id]
    )
    assert(rows[0]?.role === role && rows[0]?.active === true, `Fixture ${email} not ${role}/active`)
    return rows[0]
  }

  let clientId
  {
    const { rows } = await admin.query(`SELECT id FROM public.clients LIMIT 1`)
    if (rows[0]) {
      clientId = rows[0].id
    } else {
      const ins = await admin.query(
        `INSERT INTO public.clients (id, name, company, email)
         VALUES (gen_random_uuid()::text, 'VerifyParity', 'VerifyParity Co', 'verify-parity@example.com')
         RETURNING id`
      )
      clientId = ins.rows[0].id
    }
    assert(clientId, "client fixture missing")
  }

  let adminActorId = null

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

  /**
   * Create a request at targetStatus. Line product names never contain "starlink"
   * so the 049 serial gate does not interfere with transition parity.
   */
  async function createRequestAt(ownerId, targetStatus) {
    const tag = stamp()
    const notes = `verify-parity ${tag}`
    const { rows } = await admin.query(
      `INSERT INTO public.stock_requests (client_id, created_by, status, notes)
       VALUES ($1, $2, 'draft', $3) RETURNING id::text AS id`,
      [clientId, ownerId, notes]
    )
    const requestId = rows[0].id
    cleanup.requests.push(requestId)

    await admin.query(
      `INSERT INTO public.stock_request_lines (request_id, product_name, quantity_requested, sort_order)
       VALUES ($1, $2, 1, 0)`,
      [requestId, `ParityWidget-${tag}`]
    )

    assert(adminActorId, "adminActorId not set")

    if (targetStatus === "cancelled") {
      await asActor(ownerId, async (c) => {
        await c.query(`UPDATE public.stock_requests SET status = 'cancelled' WHERE id = $1`, [
          requestId,
        ])
      })
    } else {
      const path = statusPathTo(targetStatus)
      for (const next of path) {
        const actor =
          next === "submitted" || next === "cancelled"
            ? ownerId
            : next === "invoiced"
              ? adminActorId
              : adminActorId
        await asActor(actor, async (c) => {
          await c.query(`UPDATE public.stock_requests SET status = $2 WHERE id = $1`, [
            requestId,
            next,
          ])
        })
      }
    }

    const { rows: st } = await admin.query(
      `SELECT status FROM public.stock_requests WHERE id = $1`,
      [requestId]
    )
    assert(
      st[0]?.status === targetStatus,
      `createRequestAt expected ${targetStatus}, got ${st[0]?.status}`
    )
    return requestId
  }

  /**
   * Attempt status UPDATE as user with RLS on, then always ROLLBACK.
   * Success = one row returned at toStatus (trigger + RLS both allowed).
   */
  async function tryTransition(actorId, requestId, toStatus) {
    try {
      return await asUserRollback(actorId, async (c) => {
        const res = await c.query(
          `UPDATE public.stock_requests SET status = $2 WHERE id = $1 RETURNING status`,
          [requestId, toStatus]
        )
        const ok = res.rowCount === 1 && res.rows[0]?.status === toStatus
        return {
          ok,
          rowCount: res.rowCount ?? 0,
          error: ok ? null : `rowCount=${res.rowCount} status=${res.rows[0]?.status ?? "n/a"}`,
        }
      })
    } catch (e) {
      return { ok: false, rowCount: 0, error: e.message }
    }
  }

  try {
    await deleteFixtureUsersByEmail()

    console.log("\n=== Resolving fixtures ===")
    const adminUser = await createFixtureUser(EMAIL.admin, "admin")
    adminActorId = adminUser.id
    const sales = await createFixtureUser(EMAIL.sales, "sales")
    const salesB = await createFixtureUser(EMAIL.salesB, "sales")
    const accounts = await createFixtureUser(EMAIL.accounts, "accounts")
    const tech = await createFixtureUser(EMAIL.tech, "technicians")

    for (const [k, v] of Object.entries({ adminUser, sales, salesB, accounts, tech })) {
      assert(v?.id && v?.active === true, `Required fixture missing or inactive: ${k}`)
      assert(v.role, `Fixture ${k} missing role`)
    }

    /** @type {Record<string, { id: string, role: string }>} */
    const byRole = {
      admin: adminUser,
      sales: sales,
      accounts: accounts,
      technicians: tech,
    }

    console.log("All fixtures resolved")
    console.log("\n=== Transition parity matrix ===")

    /** Cache requests at fromStatus per owner so rolled-back attempts can reuse them. */
    /** @type {Map<string, string>} */
    const requestCache = new Map()

    async function requestAt(ownerId, fromStatus) {
      const key = `${ownerId}:${fromStatus}`
      if (!requestCache.has(key)) {
        requestCache.set(key, await createRequestAt(ownerId, fromStatus))
      }
      return requestCache.get(key)
    }

    for (const from of STATUSES) {
      for (const to of STATUSES) {
        // Self-transitions are intentional asymmetry, not parity cases:
        // the 049 trigger allows no-op status writes (notes / invoice fields);
        // allowedTransitions omits self-edges so the UI never offers them.
        // Documented once per status below — skip here.
        if (from === to) continue

        for (const role of ROLES) {
          // Full ownership matrix: allowedTransitions() is what the UI calls.
          for (const isOwner of [true, false]) {
            const actor = byRole[role]
            // Owner cases: request created_by = actor. Non-owner: sales owns;
            // when the actor is also sales, use salesB so created_by ≠ actor.
            const actorId = !isOwner && role === "sales" ? salesB.id : actor.id
            const ownerForRequest = isOwner ? actor.id : sales.id

            const tsAllows = allowedTransitions(from, role, isOwner).includes(to)
            const name = `${from}->${to} role=${role} owner=${isOwner}`

            const requestId = await requestAt(ownerForRequest, from)
            const db = await tryTransition(actorId, requestId, to)

            if (tsAllows === db.ok) {
              recordCheck({
                result: "PASS",
                name,
                from,
                to,
                role,
                isOwner,
                tsAllows,
                dbAllows: db.ok,
                reason: tsAllows
                  ? "both allowed"
                  : `both denied${db.error ? ` (${String(db.error).split("\n")[0]})` : ""}`,
              })
            } else if (tsAllows && !db.ok) {
              recordCheck({
                result: "FAIL",
                name,
                from,
                to,
                role,
                isOwner,
                tsAllows,
                dbAllows: db.ok,
                reason: `parity: TypeScript allowed, database denied — ${String(db.error).split("\n")[0]}`,
              })
            } else {
              recordCheck({
                result: "FAIL",
                name,
                from,
                to,
                role,
                isOwner,
                tsAllows,
                dbAllows: db.ok,
                reason: "parity: database allowed, TypeScript denied",
              })
            }
          }
        }
      }
    }

    // Documented asymmetry: DB permits no-op status writes; TS does not list self-edges.
    // Use admin so RLS does not mask the trigger's IS NOT DISTINCT FROM short-circuit.
    console.log("\n=== Documented self-transition asymmetry (not parity failures) ===")
    for (const status of STATUSES) {
      const requestId = await requestAt(adminUser.id, status)
      const db = await tryTransition(adminUser.id, requestId, status)
      const tsListsSelf = allowedTransitions(status, "admin", true).includes(status)
      const name = `self-noop ${status}->${status} (DB allows, TS omits)`
      if (db.ok && !tsListsSelf) {
        recordCheck({
          result: "PASS",
          name,
          from: status,
          to: status,
          role: "admin",
          isOwner: true,
          tsAllows: false,
          dbAllows: true,
          reason:
            "documented asymmetry: trigger allows no-op status write; allowedTransitions omits self-edge",
        })
      } else {
        recordCheck({
          result: "FAIL",
          name,
          from: status,
          to: status,
          role: "admin",
          isOwner: true,
          tsAllows: tsListsSelf,
          dbAllows: db.ok,
          reason: `expected DB allow + TS omit; got db.ok=${db.ok} tsListsSelf=${tsListsSelf}${
            db.error ? ` (${String(db.error).split("\n")[0]})` : ""
          }`,
        })
      }
    }

    console.log(`Parity checks recorded: ${checks.length}`)
  } finally {
    console.log("\n=== Cleanup ===")
    try {
      for (const id of cleanup.inventory) {
        await admin
          .query(
            `UPDATE public.inventory_items SET reserved_for_request_line_id = NULL WHERE id = $1`,
            [id]
          )
          .catch(() => {})
      }
      for (const id of cleanup.requests) {
        await admin
          .query(`DELETE FROM public.stock_request_events WHERE request_id = $1`, [id])
          .catch(() => {})
        await admin
          .query(`DELETE FROM public.notifications WHERE metadata->>'request_id' = $1`, [id])
          .catch(() => {})
        await admin.query(`DELETE FROM public.stock_requests WHERE id = $1`, [id]).catch(() => {})
      }
      // Prefix sweeps — FK order: inventory_items before product_lines.
      // Catches rows missed by the in-memory cleanup lists (the 049 gap).
      await admin
        .query(`UPDATE public.inventory_items SET reserved_for_request_line_id = NULL WHERE id LIKE $1`, [
          `${ID_PREFIX_INV}%`,
        ])
        .catch(() => {})
      for (const id of cleanup.inventory) {
        await admin.query(`DELETE FROM public.inventory_items WHERE id = $1`, [id]).catch(() => {})
      }
      await admin
        .query(`DELETE FROM public.inventory_items WHERE id LIKE $1`, [`${ID_PREFIX_INV}%`])
        .catch(() => {})
      for (const id of cleanup.productLines) {
        await admin.query(`DELETE FROM public.product_lines WHERE id = $1`, [id]).catch(() => {})
      }
      await admin
        .query(`DELETE FROM public.product_lines WHERE id LIKE $1`, [`${ID_PREFIX_PL}%`])
        .catch(() => {})

      for (const id of [...new Set(fixtureUserIds)]) {
        const { error } = await supabaseAdmin.auth.admin.deleteUser(id)
        if (error) console.warn(`deleteUser(${id}): ${error.message}`)
      }
      await deleteFixtureUsersByEmail()
    } catch (e) {
      console.warn("Cleanup error:", e.message)
    }
    await admin.end().catch(() => {})
  }

  const passed = checks.filter((c) => c.result === "PASS").length
  const failed = checks.filter((c) => c.result === "FAIL")
  const summary = {
    script: "verify-transition-parity",
    total: checks.length,
    passed,
    failed: failed.length,
    failures: failed.map((f) => ({
      name: f.name,
      from: f.from,
      to: f.to,
      role: f.role,
      isOwner: f.isOwner,
      tsAllows: f.tsAllows,
      dbAllows: f.dbAllows,
      reason: f.reason,
    })),
    importApproach:
      "dynamic import under tsx; CJS interop puts named exports on mod.default — matrix uses allowedTransitions only",
  }

  console.log("\n========== VERIFY TRANSITION PARITY SUMMARY ==========")
  console.log(JSON.stringify(summary, null, 2))
  console.log("=====================================================")

  if (failed.length > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
