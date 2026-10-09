/**
 * Verify 057_profile_and_auth_lockdown.sql. Does not apply SQL.
 *
 * Creates only verify-057-* identities/data and removes them in finally.
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SUPABASE_DB_URL (or DATABASE_URL)
 *
 * Usage: node scripts/verify-057-profile-lockdown.mjs
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"
import { createClient } from "@supabase/supabase-js"

const require = createRequire(import.meta.url)
const { prepareVerifyEnv } = require("./verify-env.cjs")
const EMAIL_PREFIX = "verify-057-"
const FIXTURE_PASSWORD = "Verify057!ProfileLockdown"
const PRODUCT_PREFIX = "__verify_057_pl__"
const EMAIL = {
  admin: "verify-057-admin@test.local",
  tech: "verify-057-tech@test.local",
  sales: "verify-057-sales@test.local",
  accounts: "verify-057-accounts@test.local",
  norole: "verify-057-norole@test.local",
  target: "verify-057-target@test.local",
  inside: "verify-057-inside@frampolafrica.com",
  outside: "verify-057-outside@test.local",
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function stamp() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

async function main() {
  prepareVerifyEnv()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
  assert(url, "Missing NEXT_PUBLIC_SUPABASE_URL")
  assert(anonKey, "Missing NEXT_PUBLIC_SUPABASE_ANON_KEY")
  assert(serviceKey, "Missing SUPABASE_SERVICE_ROLE_KEY")
  assert(dbUrl, "Missing SUPABASE_DB_URL or DATABASE_URL")

  const pg = require("pg")
  const admin = new pg.Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
  })
  await admin.connect()
  const supabaseAdmin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const results = {}
  const fixtureUserIds = []
  let snapshot = null

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
    assert(rows[0]?.uid === userId, `auth.uid() did not resolve on pooled connection for ${userId}`)
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
      await client.query("COMMIT")
      return result
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {})
      throw error
    } finally {
      await client.end()
    }
  }

  async function deleteFixtureUsers() {
    const { rows } = await admin.query(
      `SELECT id::text AS id FROM public.profiles WHERE email LIKE $1
       UNION
       SELECT id::text FROM auth.users WHERE email LIKE $1`,
      [`${EMAIL_PREFIX}%`]
    )
    const ids = [...new Set(rows.map((row) => row.id))]
    for (const id of ids) {
      const { error } = await supabaseAdmin.auth.admin.deleteUser(id)
      if (error && !/not found|user not found/i.test(error.message)) {
        throw new Error(`deleteUser(${id}): ${error.message}`)
      }
    }
    await admin.query(`DELETE FROM public.product_lines WHERE product_name LIKE $1`, [
      `${PRODUCT_PREFIX}%`,
    ])
  }

  async function createAuthUser(email) {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: FIXTURE_PASSWORD,
      email_confirm: true,
    })
    if (error) throw new Error(`createUser(${email}): ${error.message}`)
    fixtureUserIds.push(data.user.id)
    return data.user.id
  }

  async function createRoleUser(email, role) {
    const id = await createAuthUser(email)
    await admin.query(
      `UPDATE public.profiles
       SET role = $2::public.app_role, active = true
       WHERE id = $1`,
      [id, role]
    )
    return id
  }

  async function profileCounts() {
    const { rows } = await admin.query(`
      SELECT coalesce(role::text, '<null>') AS role, active, count(*)::int AS n
      FROM public.profiles
      GROUP BY 1, 2
      ORDER BY 1, 2
    `)
    return JSON.stringify(rows)
  }

  try {
    const { rows: schema } = await admin.query(`
      SELECT
        EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = 'public.profiles'::regclass
            AND tgname = 'profiles_guard_access_fields'
            AND NOT tgisinternal
        ) AS has_guard,
        EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = 'public'
            AND tablename = 'profiles'
            AND policyname = 'Allow insert own profile'
        ) AS has_insert_own,
        to_regclass('public.profile_signup_email_domains') IS NOT NULL AS has_allowlist
    `)
    if (!schema[0]?.has_guard || schema[0]?.has_insert_own || !schema[0]?.has_allowlist) {
      fail(
        "schema_057",
        "Migration 057 is not applied (guard / allowlist / insert policy). Apply supabase/migrations/057_profile_and_auth_lockdown.sql first."
      )
      return
    }
    pass("schema_057", "guard trigger present; insert-own policy gone; allowlist table present")

    await deleteFixtureUsers()
    snapshot = await profileCounts()

    console.log("\n=== 1. Allow insert own profile gone ===")
    {
      const { rows } = await admin.query(`
        SELECT count(*)::int AS n
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'profiles'
          AND policyname = 'Allow insert own profile'
      `)
      if (rows[0].n === 0) pass("insert_own_policy_dropped", "policy absent")
      else fail("insert_own_policy_dropped", "policy still exists")
    }

    console.log("\n=== Creating dedicated identities ===")
    const adminId = await createRoleUser(EMAIL.admin, "admin")
    const techId = await createRoleUser(EMAIL.tech, "technicians")
    const salesId = await createRoleUser(EMAIL.sales, "sales")
    const accountsId = await createRoleUser(EMAIL.accounts, "accounts")
    const noroleId = await createAuthUser(EMAIL.norole)
    const targetId = await createRoleUser(EMAIL.target, "technicians")
    await admin.query(`UPDATE public.profiles SET role = NULL WHERE id = $1`, [noroleId])

    console.log("\n=== 2. User without a profile cannot insert one ===")
    {
      const orphanId = await createAuthUser(`${EMAIL_PREFIX}orphan@test.local`)
      await admin.query(`DELETE FROM public.profile_access_events WHERE profile_id = $1`, [orphanId])
      await admin.query(`DELETE FROM public.profiles WHERE id = $1`, [orphanId])

      async function tryInsert(userId, label) {
        try {
          await asUser(userId, (client) =>
            client.query(
              `INSERT INTO public.profiles (id, email, display_name, role, active)
               VALUES ($1, $2, 'orphan', NULL, false)`,
              [orphanId, `${EMAIL_PREFIX}orphan@test.local`]
            )
          )
          fail(label, "insert succeeded")
        } catch (error) {
          pass(label, error.message.split("\n")[0])
        }
        const { rows } = await admin.query(
          `SELECT count(*)::int AS n FROM public.profiles WHERE id = $1`,
          [orphanId]
        )
        if (rows[0].n !== 0) fail(`${label}_residue`, "profile row appeared")
      }

      await tryInsert(orphanId, "orphan_self_insert_denied")
      await tryInsert(adminId, "admin_insert_foreign_profile_denied")
    }

    console.log("\n=== 3. Non-admin cannot change own role/active; admin can and is audited ===")
    {
      await admin.query(`DELETE FROM public.profile_access_events WHERE profile_id = $1`, [
        techId,
      ])
      try {
        await asUser(techId, (client) =>
          client.query(`UPDATE public.profiles SET role = 'admin' WHERE id = $1`, [techId])
        )
      } catch {
        // exception or RLS zero-row both acceptable
      }
      try {
        await asUser(techId, (client) =>
          client.query(`UPDATE public.profiles SET active = false WHERE id = $1`, [techId])
        )
      } catch {
        // ignored
      }
      const { rows: afterSelf } = await admin.query(
        `SELECT role::text AS role, active FROM public.profiles WHERE id = $1`,
        [techId]
      )
      const { rows: leakedAudit } = await admin.query(
        `SELECT count(*)::int AS n FROM public.profile_access_events WHERE profile_id = $1`,
        [techId]
      )
      if (
        afterSelf[0].role === "technicians" &&
        afterSelf[0].active === true &&
        leakedAudit[0].n === 0
      ) {
        pass("non_admin_cannot_change_own_access", "role/active unchanged; no audit row")
      } else {
        fail("non_admin_cannot_change_own_access", JSON.stringify({ afterSelf, leakedAudit }))
      }

      await admin.query(`DELETE FROM public.profile_access_events WHERE profile_id = $1`, [
        targetId,
      ])
      await asUser(adminId, (client) =>
        client.query(`UPDATE public.profiles SET role = 'sales' WHERE id = $1`, [targetId])
      )
      await asUser(adminId, (client) =>
        client.query(`UPDATE public.profiles SET active = false WHERE id = $1`, [targetId])
      )
      const { rows: auditRows } = await admin.query(
        `SELECT actor_id::text AS actor_id, from_role, to_role, from_active, to_active
         FROM public.profile_access_events
         WHERE profile_id = $1
         ORDER BY created_at, id`,
        [targetId]
      )
      const roleEvent = auditRows.find(
        (row) => row.from_role === "technicians" && row.to_role === "sales"
      )
      const activeEvent = auditRows.find(
        (row) => row.from_active === true && row.to_active === false
      )
      if (roleEvent?.actor_id === adminId && activeEvent?.actor_id === adminId) {
        pass("admin_update_audited", "admin changed others' role/active with actor_id")
      } else {
        fail("admin_update_audited", JSON.stringify(auditRows))
      }
    }

    console.log("\n=== 4. Auth trigger domain allowlist ===")
    {
      const insideId = await createAuthUser(EMAIL.inside)
      const outsideId = await createAuthUser(EMAIL.outside)
      const { rows: inside } = await admin.query(
        `SELECT role::text AS role, active FROM public.profiles WHERE id = $1`,
        [insideId]
      )
      const { rows: outside } = await admin.query(
        `SELECT role::text AS role, active FROM public.profiles WHERE id = $1`,
        [outsideId]
      )
      if (inside[0]?.role == null && inside[0]?.active === true) {
        pass("auth_trigger_allowlisted_domain", "frampolafrica.com → role NULL, active true")
      } else {
        fail("auth_trigger_allowlisted_domain", JSON.stringify(inside[0] ?? null))
      }
      if (outside[0]?.role == null && outside[0]?.active === false) {
        pass("auth_trigger_other_domain", "other domain → role NULL, active false")
      } else {
        fail("auth_trigger_other_domain", JSON.stringify(outside[0] ?? null))
      }
    }

    console.log("\n=== 5. ensure_product_line role gate ===")
    {
      const allowed = [
        ["admin", adminId],
        ["technicians", techId],
        ["sales", salesId],
      ]
      for (const [role, userId] of allowed) {
        const name = `${PRODUCT_PREFIX}${role}-${stamp()}`
        try {
          const id = await asUser(userId, async (client) => {
            const { rows } = await client.query(
              `SELECT public.ensure_product_line($1, 'General') AS id`,
              [name]
            )
            return rows[0].id
          })
          const { rows } = await admin.query(
            `SELECT count(*)::int AS n FROM public.product_lines WHERE id = $1`,
            [id]
          )
          if (rows[0].n === 1) pass(`ensure_product_line_${role}`, id)
          else fail(`ensure_product_line_${role}`, "rpc ok but row missing")
        } catch (error) {
          fail(`ensure_product_line_${role}`, error.message.split("\n")[0])
        }
      }

      const denied = [
        ["accounts", accountsId],
        ["null_role", noroleId],
      ]
      for (const [label, userId] of denied) {
        const name = `${PRODUCT_PREFIX}${label}-${stamp()}`
        try {
          await asUser(userId, (client) =>
            client.query(`SELECT public.ensure_product_line($1, 'General')`, [name])
          )
          fail(`ensure_product_line_${label}_denied`, "succeeded")
        } catch (error) {
          const { rows } = await admin.query(
            `SELECT count(*)::int AS n FROM public.product_lines WHERE product_name = $1`,
            [name]
          )
          if (rows[0].n === 0) {
            pass(`ensure_product_line_${label}_denied`, error.message.split("\n")[0])
          } else {
            fail(`ensure_product_line_${label}_denied`, `row created despite error (${rows[0].n})`)
          }
        }
      }
    }
  } finally {
    console.log("\n=== 8. Cleanup and residue ===")
    try {
      await deleteFixtureUsers()
      for (const id of [...new Set(fixtureUserIds)]) {
        const { error } = await supabaseAdmin.auth.admin.deleteUser(id)
        if (error && !/not found|user not found/i.test(error.message)) {
          throw new Error(`deleteUser(${id}): ${error.message}`)
        }
      }

      const { rows: profiles } = await admin.query(
        `SELECT count(*)::int AS n FROM public.profiles WHERE email LIKE $1`,
        [`${EMAIL_PREFIX}%`]
      )
      const { rows: authUsers } = await admin.query(
        `SELECT count(*)::int AS n FROM auth.users WHERE email LIKE $1`,
        [`${EMAIL_PREFIX}%`]
      )
      const { rows: products } = await admin.query(
        `SELECT count(*)::int AS n FROM public.product_lines WHERE product_name LIKE $1`,
        [`${PRODUCT_PREFIX}%`]
      )
      const { rows: events } = await admin.query(
        `SELECT count(*)::int AS n
         FROM public.profile_access_events e
         JOIN public.profiles p ON p.id = e.profile_id
         WHERE p.email LIKE $1`,
        [`${EMAIL_PREFIX}%`]
      )
      const residue = {
        profiles: profiles[0].n,
        auth_users: authUsers[0].n,
        product_lines: products[0].n,
        profile_access_events: events[0].n,
      }
      if (Object.values(residue).every((count) => count === 0)) {
        pass("zero_residue", JSON.stringify(residue))
      } else {
        fail("zero_residue", JSON.stringify(residue))
      }

      console.log("\n=== 7. Existing profiles unchanged ===")
      if (snapshot) {
        const after = await profileCounts()
        if (after === snapshot) pass("existing_profiles_unchanged", snapshot)
        else fail("existing_profiles_unchanged", `before=${snapshot}; after=${after}`)
      }
    } catch (error) {
      fail("zero_residue", error.message)
    } finally {
      await admin.end().catch(() => {})
    }
  }

  console.log("\n========== VERIFY 057 SUMMARY ==========")
  console.log(JSON.stringify(results, null, 2))
  console.log("========================================")
  if (Object.values(results).some((result) => result.result === "FAIL")) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
