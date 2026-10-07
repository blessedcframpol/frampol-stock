/**
 * P3.1b denial check. Does not apply a migration.
 *
 * Creates only verify-p31b-* identities. Every write runs inside a transaction
 * that rolls back. finally deletes the identities and asserts zero residue,
 * including the reorder level of the probed product line.
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SUPABASE_DB_URL (or DATABASE_URL)
 *
 * Usage: node scripts/verify-p31b-inventory-writes.mjs
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"
import { createClient } from "@supabase/supabase-js"

const require = createRequire(import.meta.url)
const { prepareVerifyEnv } = require("./verify-env.cjs")
const EMAIL_PREFIX = "verify-p31b-"
const TAKE_PREFIX = "__verify_p31b__"
const DENIAL_ROLES = ["technicians", "sales", "accounts"]
const ROLES = ["admin", ...DENIAL_ROLES]
const PRODUCT_ID = "PL-c5ed17b5fe1d4d31a89f51da5a5d3422"

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function main() {
  prepareVerifyEnv()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
  assert(url, "Missing NEXT_PUBLIC_SUPABASE_URL")
  assert(serviceKey, "Missing SUPABASE_SERVICE_ROLE_KEY")
  assert(dbUrl, "Missing SUPABASE_DB_URL or DATABASE_URL")

  const pg = require("pg")
  const db = new pg.Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
  })
  await db.connect()
  const service = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const userIds = new Map()
  const results = {}
  let originalReorder = undefined

  function pass(name, reason) {
    results[name] = { result: "PASS", reason }
    console.log(`PASS  ${name} — ${reason}`)
  }

  function fail(name, reason) {
    results[name] = { result: "FAIL", reason }
    console.log(`FAIL  ${name} — ${reason}`)
  }

  async function setJwt(client, userId) {
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ])
    const { rows } = await client.query(`SELECT auth.uid()::text AS uid`)
    assert(rows[0]?.uid === userId, `auth.uid() did not resolve for ${userId}`)
  }

  async function asUser(userId, fn) {
    const client = new pg.Client({
      connectionString: dbUrl,
      ssl: { rejectUnauthorized: false },
    })
    await client.connect()
    try {
      await client.query("BEGIN")
      await setJwt(client, userId)
      await client.query("SET LOCAL ROLE authenticated")
      const result = await fn(client)
      await client.query("ROLLBACK")
      return result
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {})
      throw error
    } finally {
      await client.end()
    }
  }

  async function expectDenied(client, savepoint, query, params = []) {
    await client.query(`SAVEPOINT ${savepoint}`)
    try {
      const result = await client.query(query, params)
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
      return { code: null, rowCount: result.rowCount }
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
      return { code: error.code ?? "error", message: error.message }
    }
  }

  async function createIdentities() {
    for (const role of ROLES) {
      const email = `${EMAIL_PREFIX}${role}@test.local`
      const { data, error } = await service.auth.admin.createUser({
        email,
        email_confirm: true,
      })
      if (error) throw new Error(`createUser(${role}): ${error.message}`)
      userIds.set(role, data.user.id)
      await db.query(
        `UPDATE public.profiles
         SET role = $2::public.app_role, active = true
         WHERE id = $1`,
        [data.user.id, role]
      )
    }
  }

  async function deleteIdentities() {
    const { rows } = await db.query(
      `SELECT id::text AS id FROM auth.users WHERE email LIKE $1`,
      [`${EMAIL_PREFIX}%`]
    )
    for (const id of new Set([...userIds.values(), ...rows.map((row) => row.id)])) {
      const { error } = await service.auth.admin.deleteUser(id)
      if (error && !/not found/i.test(error.message)) throw error
    }
  }

  async function residue() {
    const ids = [...userIds.values()]
    const { rows } = await db.query(
      `SELECT
         (SELECT count(*)::int FROM auth.users WHERE email LIKE $2) AS auth_users,
         (SELECT count(*)::int FROM public.profiles
           WHERE email LIKE $2 OR id = ANY($4::uuid[])) AS profiles,
         (SELECT count(*)::int FROM public.stock_takes WHERE id LIKE $3) AS stock_takes,
         (SELECT reorder_level FROM public.product_lines WHERE id = $1) AS reorder_level`,
      [PRODUCT_ID, `${EMAIL_PREFIX}%`, `${TAKE_PREFIX}%`, ids.length > 0 ? ids : ["00000000-0000-0000-0000-000000000000"]]
    )
    return rows[0]
  }

  try {
    const before = await db.query(
      `SELECT reorder_level FROM public.product_lines WHERE id = $1`,
      [PRODUCT_ID]
    )
    assert(before.rows[0], `Probe product ${PRODUCT_ID} is missing`)
    originalReorder = before.rows[0].reorder_level

    await createIdentities()

    const technicianId = userIds.get("technicians")
    const reorderAttempt = await asUser(technicianId, async (client) => {
      const denied = await expectDenied(
        client,
        "sp_reorder",
        `UPDATE public.product_lines SET reorder_level = 7 WHERE id = $1`,
        [PRODUCT_ID]
      )
      const { rows } = await client.query(
        `SELECT reorder_level FROM public.product_lines WHERE id = $1`,
        [PRODUCT_ID]
      )
      return { denied, visible: rows[0]?.reorder_level ?? null }
    })
    if (reorderAttempt.denied.code === "42501" && reorderAttempt.visible === originalReorder) {
      pass(
        "technicians_reorder_update_denied",
        `SQLSTATE 42501; reorder_level stayed ${originalReorder === null ? "null" : originalReorder}`
      )
    } else {
      fail(
        "technicians_reorder_update_denied",
        JSON.stringify(reorderAttempt)
      )
    }

    const adminWrite = await asUser(userIds.get("admin"), async (client) => {
      const updated = await client.query(
        `UPDATE public.product_lines SET reorder_level = 7 WHERE id = $1 RETURNING reorder_level`,
        [PRODUCT_ID]
      )
      return updated.rows[0]?.reorder_level ?? null
    })
    if (adminWrite === 7) {
      pass("admin_reorder_update_rolls_back", "wrote 7 inside a transaction that rolled back")
    } else {
      fail("admin_reorder_update_rolls_back", JSON.stringify(adminWrite))
    }

    const snapshot = JSON.stringify({
      scannedSerials: [],
      matched: [],
      notInSystem: [],
      notScanned: [],
    })
    for (const role of DENIAL_ROLES) {
      const attempt = await asUser(userIds.get(role), async (client) =>
        expectDenied(
          client,
          "sp_take",
          `INSERT INTO public.stock_takes (id, completed_at, result_snapshot)
           VALUES ($1, $2, $3::jsonb)`,
          [`${TAKE_PREFIX}${role}`, new Date().toISOString(), snapshot]
        )
      )
      if (attempt.code === "42501") {
        pass(`${role}_stock_take_insert_denied`, "SQLSTATE 42501")
      } else {
        fail(`${role}_stock_take_insert_denied`, JSON.stringify(attempt))
      }
    }
  } catch (error) {
    fail("verify_p31b", error instanceof Error ? error.message : String(error))
  } finally {
    try {
      await deleteIdentities()
      if (originalReorder !== undefined) {
        await db.query(
          `UPDATE public.product_lines
           SET reorder_level = $2
           WHERE id = $1
             AND reorder_level IS DISTINCT FROM $2`,
          [PRODUCT_ID, originalReorder]
        )
      }
      const left = await residue()
      const reorderOk = left.reorder_level === originalReorder
        || (left.reorder_level == null && originalReorder == null)
      const clean = left.auth_users === 0 && left.profiles === 0 && left.stock_takes === 0 && reorderOk
      if (clean) {
        pass(
          "fixture_cleanup",
          `users=0 profiles=0 stock_takes=0 reorder_level=${left.reorder_level === null ? "null" : left.reorder_level}`
        )
      } else {
        fail("fixture_cleanup", JSON.stringify(left))
      }
    } catch (error) {
      fail("fixture_cleanup", error instanceof Error ? error.message : String(error))
    }
    await db.end()
  }

  const failed = Object.values(results).filter((row) => row.result === "FAIL")
  if (failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
