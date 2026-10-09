/**
 * Rollback harness for verify scripts.
 *
 * Opens DATABASE_URL / SUPABASE_DB_URL, runs the test inside BEGIN … ROLLBACK,
 * always rolls back (including on error or timeout), and never commits.
 * After the run, asserts marker rows are gone, live totals match the pre-run
 * snapshot (with a printed concurrent-traffic tolerance on production), and
 * audit_log gained no rows since run start that reference marker ids.
 *
 * Usage from a verify script:
 *   import { withHarness } from "./verify-harness.mjs"
 *   await withHarness({ markers: [...], timeoutMs: 120_000 }, async (ctx) => { ... })
 *
 * HTTP / Supabase-client verify scripts must still call prepareVerifyEnv() with
 * no harness flag — production stays blocked for them.
 */
import { createRequire } from "module"
import { pathToFileURL } from "url"

const require = createRequire(import.meta.url)
const { Client } = require("pg")
const {
  loadEnvLocal,
  assertNotProduction,
  prepareVerifyEnv: prepareVerifyEnvStrict,
  PRODUCTION_SUPABASE_REF,
  projectRefFromUrl,
} = require("./verify-env.cjs")

const DEFAULT_TIMEOUT_MS = 180_000

/**
 * @param {{ harness?: boolean, extraUrls?: string[] }} [options]
 * harness: true → allow production (caller must use withHarness / rehearse).
 * harness omitted/false → refuse production (HTTP / client scripts).
 */
export function prepareVerifyEnv(options = {}) {
  loadEnvLocal()
  if (options.harness === true) {
    const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
    if (!dbUrl) {
      throw new Error("verify-harness: Missing SUPABASE_DB_URL or DATABASE_URL")
    }
    return { dbUrl, production: projectRefFromUrl(dbUrl) === PRODUCTION_SUPABASE_REF }
  }
  prepareVerifyEnvStrict(options.extraUrls || [])
}

export function pass(results, name, reason) {
  results[name] = { result: "PASS", reason }
  console.log(`PASS  ${name} — ${reason}`)
}

export function fail(results, name, reason) {
  results[name] = { result: "FAIL", reason }
  console.log(`FAIL  ${name} — ${reason}`)
}

async function liveTotals(db) {
  const csdc = await db.query(
    `SELECT count(*)::int AS clients,
            coalesce(sum(orders), 0)::int AS orders,
            coalesce(sum(units), 0)::int AS units
     FROM public.client_sale_dispatch_counts()`,
  )
  const kits = await db.query(
    `SELECT status, count(*)::int AS n
     FROM public.inventory_items
     WHERE deleted_at IS NULL
     GROUP BY status
     ORDER BY status`,
  )
  const clients = await db.query(`SELECT count(*)::int AS n FROM public.clients`)
  return {
    csdc: csdc.rows[0],
    kits: Object.fromEntries(kits.rows.map((r) => [r.status, r.n])),
    clients: clients.rows[0].n,
  }
}

/** LIKE needles drawn from marker params (prefixes, emails, ids). */
function markerNeedles(markers) {
  const out = []
  for (const marker of markers) {
    for (const value of marker.params || []) {
      if (typeof value === "string" && value.length >= 3) out.push(value)
    }
  }
  return [...new Set(out)]
}

function formatTotalsDiff(before, after) {
  const parts = []
  const b = before.csdc
  const a = after.csdc
  if (b.clients !== a.clients) parts.push(`csdc.clients ${b.clients}→${a.clients}`)
  if (b.orders !== a.orders) parts.push(`csdc.orders ${b.orders}→${a.orders}`)
  if (b.units !== a.units) parts.push(`csdc.units ${b.units}→${a.units}`)
  if (before.clients !== after.clients) parts.push(`clients ${before.clients}→${after.clients}`)
  const statuses = new Set([...Object.keys(before.kits), ...Object.keys(after.kits)])
  for (const status of [...statuses].sort()) {
    const from = before.kits[status] ?? 0
    const to = after.kits[status] ?? 0
    if (from !== to) parts.push(`kits[${status}] ${from}→${to}`)
  }
  return parts.join(", ") || "unknown delta"
}

/**
 * @typedef {{
 *   sql: string,
 *   params?: unknown[],
 *   label: string,
 * }} MarkerCheck
 */

/**
 * @param {{
 *   markers: MarkerCheck[],
 *   timeoutMs?: number,
 *   label?: string,
 * }} options
 * @param {(ctx: HarnessContext) => Promise<void>} fn
 */
export async function withHarness(options, fn) {
  const { markers, timeoutMs = DEFAULT_TIMEOUT_MS, label = "harness" } = options
  if (!Array.isArray(markers) || markers.length === 0) {
    throw new Error("withHarness: markers[] is required (post-rollback absence checks)")
  }

  const { dbUrl, production } = prepareVerifyEnv({ harness: true })
  const db = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
  await db.connect()

  const results = {}
  const fixtureUsers = new Map()
  let beforeTotals
  let runStartedAt
  let timedOut = false
  let runError = null

  async function createFixtureUser(role, email) {
    const address =
      email ||
      `verify-harness-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`
    const instance = await db.query(`SELECT id FROM auth.instances LIMIT 1`)
    // Supabase projects often have an empty auth.instances; the GoTrue default id works.
    const instanceId = instance.rows[0]?.id || "00000000-0000-0000-0000-000000000000"

    const inserted = await db.query(
      `INSERT INTO auth.users (
         instance_id, id, aud, role, email, encrypted_password,
         email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
         created_at, updated_at
       ) VALUES (
         $1::uuid, gen_random_uuid(), 'authenticated', 'authenticated', $2,
         crypt($3, gen_salt('bf')),
         now(),
         '{"provider":"email","providers":["email"]}'::jsonb,
         '{}'::jsonb,
         now(), now()
       )
       RETURNING id::text AS id`,
      [instanceId, address, `Harness-${role}-Temp!`],
    )
    const userId = inserted.rows[0].id

    await db.query(
      `INSERT INTO auth.identities (
         id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at
       ) VALUES (
         gen_random_uuid(), $1::uuid,
         jsonb_build_object('sub', $1::text, 'email', $2::text),
         'email', $1::text, now(), now(), now()
       )
       ON CONFLICT DO NOTHING`,
      [userId, address],
    )

    const profile = await db.query(`SELECT id FROM public.profiles WHERE id = $1::uuid`, [userId])
    if (profile.rowCount === 0) {
      await db.query(
        `INSERT INTO public.profiles (id, email, role, active)
         VALUES ($1::uuid, $2, $3::public.app_role, true)`,
        [userId, address, role],
      )
    } else {
      const updated = await db.query(
        `UPDATE public.profiles
         SET role = $2::public.app_role, active = true, email = $3
         WHERE id = $1::uuid`,
        [userId, role, address],
      )
      if (updated.rowCount !== 1) throw new Error(`createFixtureUser: profile update failed for ${role}`)
    }

    fixtureUsers.set(role, { id: userId, email: address, role })
    return userId
  }

  /**
   * Act as an authenticated app user inside the outer transaction.
   * Creates the user+profile if `role` is a role name not yet created.
   */
  async function asUser(roleOrUserId, fn) {
    let userId = roleOrUserId
    let role = null
    if (
      typeof roleOrUserId === "string" &&
      ["admin", "sales", "accounts", "technicians", "viewer"].includes(roleOrUserId)
    ) {
      role = roleOrUserId
      userId = fixtureUsers.get(role)?.id || (await createFixtureUser(role))
    }

    await db.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ])
    await db.query(`SET LOCAL ROLE authenticated`)
    try {
      const uid = await db.query(`SELECT auth.uid()::text AS uid`)
      if (uid.rows[0]?.uid !== userId) {
        throw new Error(`asUser: auth.uid() is ${uid.rows[0]?.uid}, expected ${userId}`)
      }
      return await fn({ db, userId, role })
    } finally {
      // If fn aborted the txn, these may fail — don't mask the original error.
      try {
        await db.query(`RESET ROLE`)
        await db.query(`SELECT set_config('request.jwt.claim.sub', '', true)`)
        await db.query(`SELECT set_config('request.jwt.claims', '', true)`)
      } catch {
        /* outer harness ROLLBACK cleans up */
      }
    }
  }

  async function raises(sql, params, needle) {
    const sp = `sp_${Math.random().toString(36).slice(2, 10)}`
    await db.query(`SAVEPOINT ${sp}`)
    try {
      await db.query(sql, params)
      await db.query(`ROLLBACK TO SAVEPOINT ${sp}`)
      return `expected ${needle}`
    } catch (error) {
      await db.query(`ROLLBACK TO SAVEPOINT ${sp}`)
      const message = error instanceof Error ? error.message : String(error)
      return message.includes(needle) ? null : message
    }
  }

  try {
    beforeTotals = await liveTotals(db)
    const startRow = await db.query(`SELECT clock_timestamp() AS at`)
    runStartedAt = startRow.rows[0].at
    console.log(
      `HARNESS  ${label} begin${production ? " (production ref; will ROLLBACK)" : ""} — csdc ${beforeTotals.csdc.clients}/${beforeTotals.csdc.orders}/${beforeTotals.csdc.units}, audit from ${new Date(runStartedAt).toISOString()}`,
    )

    await db.query("BEGIN")

    const ctx = {
      db,
      results,
      pass: (name, reason) => pass(results, name, reason),
      fail: (name, reason) => fail(results, name, reason),
      asUser,
      createFixtureUser,
      raises,
      fixtureUsers,
      beforeTotals,
      runStartedAt,
    }

    const run = Promise.resolve().then(() => fn(ctx))
    const timeout = new Promise((_, reject) => {
      setTimeout(() => {
        timedOut = true
        reject(new Error(`withHarness: timed out after ${timeoutMs}ms`))
      }, timeoutMs)
    })

    try {
      await Promise.race([run, timeout])
    } catch (error) {
      runError = error
      fail(results, "harness_run", error instanceof Error ? error.message : String(error))
    }
  } finally {
    try {
      await db.query("ROLLBACK")
    } catch (error) {
      fail(results, "harness_rollback", error instanceof Error ? error.message : String(error))
    }

    // Outside the rolled-back transaction: markers, totals, audit.
    for (const marker of markers) {
      try {
        const found = await db.query(marker.sql, marker.params || [])
        const n = Number(found.rows[0]?.n ?? found.rows[0]?.count ?? 0)
        if (n === 0) pass(results, `marker:${marker.label}`, "absent after ROLLBACK")
        else fail(results, `marker:${marker.label}`, `${n} row(s) still present`)
      } catch (error) {
        fail(results, `marker:${marker.label}`, error instanceof Error ? error.message : String(error))
      }
    }

    const markersClean = markers.every((m) => results[`marker:${m.label}`]?.result === "PASS")
    const needles = markerNeedles(markers)

    try {
      const afterTotals = await liveTotals(db)
      const same = JSON.stringify(beforeTotals) === JSON.stringify(afterTotals)
      if (same) {
        pass(
          results,
          "live_totals",
          `unchanged ${afterTotals.csdc.clients}/${afterTotals.csdc.orders}/${afterTotals.csdc.units}`,
        )
      } else if (production && markersClean) {
        const diff = formatTotalsDiff(beforeTotals, afterTotals)
        let concurrentNote = ""
        try {
          const concurrent = await db.query(
            `SELECT count(*)::int AS n
             FROM public.transactions
             WHERE created_at >= $1::timestamptz`,
            [runStartedAt],
          )
          concurrentNote = `; ${concurrent.rows[0].n} non-test transaction(s) created during the run`
        } catch {
          concurrentNote = "; could not count concurrent transactions"
        }
        console.log(`LIVE  totals drifted (markers clean): ${diff}${concurrentNote}`)
        pass(
          results,
          "live_totals",
          `concurrent live drift (markers clean): ${diff}${concurrentNote}`,
        )
      } else {
        fail(
          results,
          "live_totals",
          `before ${JSON.stringify(beforeTotals)} after ${JSON.stringify(afterTotals)}`,
        )
      }
    } catch (error) {
      fail(results, "live_totals", error instanceof Error ? error.message : String(error))
    }

    try {
      if (!needles.length) {
        // Read-only / noop-marker scripts (e.g. schema-rules) create no fixture ids.
        pass(results, "audit_markers", "no fixture needles (read-only markers)")
      } else {
        const hit = await db.query(
          `SELECT id, table_name, row_id, action
           FROM public.audit_log AS log
           WHERE log.at >= $1::timestamptz
             AND EXISTS (
               SELECT 1
               FROM unnest($2::text[]) AS needle(pattern)
               WHERE log.row_id LIKE needle.pattern
                  OR log.changed::text LIKE needle.pattern
                  OR log.actor LIKE needle.pattern
                  OR coalesce(log.reason, '') LIKE needle.pattern
             )
           ORDER BY log.id
           LIMIT 20`,
          [runStartedAt, needles],
        )
        if (hit.rowCount === 0) {
          pass(
            results,
            "audit_markers",
            `no audit_log row at>=run start references marker needles (${needles.length})`,
          )
        } else {
          fail(
            results,
            "audit_markers",
            hit.rows.map((r) => `${r.id}:${r.table_name}/${r.row_id}/${r.action}`).join("; "),
          )
        }
      }
    } catch (error) {
      fail(results, "audit_markers", error instanceof Error ? error.message : String(error))
    }

    await Promise.race([db.end(), new Promise((r) => setTimeout(r, 2000))])
  }

  const failed = Object.values(results).filter((r) => r.result === "FAIL")
  const passed = Object.values(results).filter((r) => r.result === "PASS")
  console.log(
    `\nHARNESS  ${label} done — ${passed.length} passed, ${failed.length} failed${timedOut ? " (timed out)" : ""}${runError && !timedOut ? " (run error)" : ""}`,
  )
  return { results, failed: failed.length, passed: passed.length, ok: failed.length === 0 }
}

// Re-export strict guard for scripts that still use the old path.
export { assertNotProduction, PRODUCTION_SUPABASE_REF, projectRefFromUrl, loadEnvLocal }

const isMain =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isMain) {
  console.log("verify-harness: import withHarness from a verify script; not a CLI entry point.")
  process.exit(2)
}
