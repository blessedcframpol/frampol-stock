/**
 * Verify 054_request_hygiene_and_profile_access_audit.sql. Does not apply SQL.
 *
 * Creates only verify-054-* identities/data and removes them in finally.
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SUPABASE_DB_URL (or DATABASE_URL)
 *
 * Usage: node scripts/verify-054-request-hygiene.mjs
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"
import { createClient } from "@supabase/supabase-js"

const require = createRequire(import.meta.url)
const { prepareVerifyEnv } = require("./verify-env.cjs")
const FIXTURE_REQUEST_ID = "a95a25eb-2edb-4baa-a1f6-1449a2bf316a"
const FIXTURE_PRODUCT = "__audit_verify_product__"
const REIGN_ACRE_CLIENT_ID = "CLT-1774007295290-1pl6z68"
const EMAIL_PREFIX = "verify-054-"
const EMAIL = {
  admin: "verify-054-admin@test.local",
  tech: "verify-054-tech@test.local",
  target: "verify-054-target@test.local",
}
const FIXTURE_PASSWORD = "Verify054!RequestHygiene"

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function stamp() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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
  const supabaseAdmin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const admin = new pg.Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
  })
  await admin.connect()

  const results = {}
  const fixtureUserIds = []
  const requestIds = []
  const productLineIds = []

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

  async function deleteFixtureUsersByPrefix() {
    const { rows } = await admin.query(
      `SELECT id::text AS id
       FROM public.profiles
       WHERE email LIKE $1`,
      [`${EMAIL_PREFIX}%`]
    )
    for (const row of rows) {
      const { error } = await supabaseAdmin.auth.admin.deleteUser(row.id)
      if (error) throw new Error(`deleteUser(${row.id}): ${error.message}`)
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
      `UPDATE public.profiles
       SET role = $2::public.app_role, active = true
       WHERE id = $1`,
      [id, role]
    )
    return { id, email, role }
  }

  async function createRequest(ownerId, suffix) {
    const productId = `pl-v054-${stamp()}`
    const productName = `Verify 054 ${suffix} ${stamp()}`
    await admin.query(
      `INSERT INTO public.product_lines (id, product_name, vendor, requires_serial)
       VALUES ($1, $2, 'General', false)`,
      [productId, productName]
    )
    productLineIds.push(productId)

    const { rows } = await admin.query(
      `INSERT INTO public.stock_requests (client_id, created_by, status, notes)
       VALUES ($1, $2, 'draft', $3)
       RETURNING id::text AS id`,
      [REIGN_ACRE_CLIENT_ID, ownerId, `verify-054 ${suffix}`]
    )
    const requestId = rows[0].id
    requestIds.push(requestId)
    await admin.query(
      `INSERT INTO public.stock_request_lines
         (request_id, product_name, quantity_requested, sort_order, product_id)
       VALUES ($1, $2, 1, 0, $3)`,
      [requestId, productName, productId]
    )
    return requestId
  }

  async function setStatus(actorId, requestId, status) {
    await asUser(actorId, (client) =>
      client.query(`UPDATE public.stock_requests SET status = $2 WHERE id = $1`, [
        requestId,
        status,
      ])
    )
  }

  async function requestState(requestId) {
    const { rows } = await admin.query(
      `SELECT status, serviced_at FROM public.stock_requests WHERE id = $1`,
      [requestId]
    )
    return rows[0]
  }

  async function cleanupRequests() {
    const { rows } = await admin.query(
      `SELECT id::text AS id
       FROM public.stock_requests
       WHERE notes LIKE 'verify-054 %'`
    )
    const ids = [...new Set([...requestIds, ...rows.map((row) => row.id)])]
    for (const id of ids) {
      await admin.query(`DELETE FROM public.stock_request_events WHERE request_id = $1`, [id])
      await admin.query(
        `DELETE FROM public.notifications WHERE metadata->>'request_id' = $1`,
        [id]
      )
      await admin.query(`DELETE FROM public.stock_request_lines WHERE request_id = $1`, [id])
      await admin.query(`DELETE FROM public.stock_requests WHERE id = $1`, [id])
    }
  }

  async function cleanupProductLines() {
    await admin.query(`DELETE FROM public.product_lines WHERE id LIKE 'pl-v054-%'`)
    for (const id of productLineIds) {
      await admin.query(`DELETE FROM public.product_lines WHERE id = $1`, [id])
    }
  }

  async function hasProfileAccessEvents() {
    const { rows } = await admin.query(
      `SELECT to_regclass('public.profile_access_events') IS NOT NULL AS exists`
    )
    return rows[0].exists === true
  }

  try {
    const { rows: schema } = await admin.query(`
      SELECT
        to_regclass('public.profile_access_events') IS NOT NULL AS has_table,
        EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = 'public.profiles'::regclass
            AND tgname = 'profiles_log_access_change'
            AND NOT tgisinternal
        ) AS has_trigger
    `)
    if (!schema[0]?.has_table || !schema[0]?.has_trigger) {
      fail(
        "schema_054",
        "Migration 054 is not applied (profile access audit table/trigger missing). Apply supabase/migrations/054_request_hygiene_and_profile_access_audit.sql first."
      )
      return
    }
    pass("schema_054", "profile_access_events table and trigger present")

    await cleanupRequests()
    await cleanupProductLines()
    await deleteFixtureUsersByPrefix()

    console.log("\n=== 1. Removed audit-verify fixture ===")
    {
      const { rows } = await admin.query(
        `SELECT
          (SELECT count(*)::int FROM public.stock_requests
            WHERE id = $1::uuid) AS requests,
          (SELECT count(*)::int FROM public.stock_request_lines
            WHERE request_id = $1::uuid) AS lines,
          (SELECT count(*)::int FROM public.stock_request_events
            WHERE request_id = $1::uuid) AS events,
          (SELECT count(*)::int FROM public.product_lines
            WHERE product_name = $2) AS product_lines,
          (SELECT count(*)::int
            FROM public.inventory_items i
            JOIN public.product_lines p ON p.id = i.product_id
            WHERE p.product_name = $2) AS inventory_items,
          (SELECT count(*)::int FROM public.transactions
            WHERE item_name = $2) AS transactions,
          (SELECT count(*)::int FROM public.clients
            WHERE id = $3) AS reign_acre`,
        [FIXTURE_REQUEST_ID, FIXTURE_PRODUCT, REIGN_ACRE_CLIENT_ID]
      )
      const counts = rows[0]
      const gone = [
        counts.requests,
        counts.lines,
        counts.events,
        counts.product_lines,
        counts.inventory_items,
        counts.transactions,
      ].every((count) => count === 0)
      if (gone && counts.reign_acre === 1) {
        pass("fixture_cleanup", `footprint=${JSON.stringify(counts)}; Reign Acre retained`)
      } else {
        fail("fixture_cleanup", JSON.stringify(counts))
      }
    }

    console.log("\n=== Creating dedicated identities ===")
    const adminUser = await createFixtureUser(EMAIL.admin, "admin")
    const techUser = await createFixtureUser(EMAIL.tech, "technicians")
    const targetUser = await createFixtureUser(EMAIL.target, "technicians")
    {
      const { rows } = await admin.query(
        `SELECT from_role, to_role, from_active, to_active
         FROM public.profile_access_events
         WHERE profile_id = $1
           AND from_role IS NULL
           AND from_active IS NULL
         ORDER BY created_at
         LIMIT 1`,
        [targetUser.id]
      )
      if (
        rows[0]?.to_role == null &&
        rows[0]?.from_active == null &&
        rows[0]?.to_active === true
      ) {
        pass("profile_insert_audit", "initial NULL role and active=true captured")
      } else {
        fail("profile_insert_audit", JSON.stringify(rows[0] ?? null))
      }
    }

    console.log("\n=== 2. serviced_at lifecycle and backfill behavior ===")
    {
      const requestId = await createRequest(techUser.id, "lifecycle")
      await setStatus(adminUser.id, requestId, "submitted")
      await setStatus(adminUser.id, requestId, "in_progress")
      await setStatus(adminUser.id, requestId, "serviced")
      const firstServiced = await requestState(requestId)
      await setStatus(adminUser.id, requestId, "in_progress")
      const reopened = await requestState(requestId)
      await setStatus(adminUser.id, requestId, "serviced")
      const secondServiced = await requestState(requestId)
      await setStatus(adminUser.id, requestId, "invoiced")
      const invoiced = await requestState(requestId)

      const ok =
        firstServiced.status === "serviced" &&
        firstServiced.serviced_at != null &&
        reopened.status === "in_progress" &&
        reopened.serviced_at == null &&
        secondServiced.status === "serviced" &&
        secondServiced.serviced_at != null &&
        invoiced.status === "invoiced" &&
        invoiced.serviced_at != null
      if (ok) pass("serviced_at_lifecycle", "set → cleared on reopen → reset → kept on invoiced")
      else {
        fail(
          "serviced_at_lifecycle",
          JSON.stringify({ firstServiced, reopened, secondServiced, invoiced })
        )
      }
    }

    {
      const requestId = await createRequest(techUser.id, "backfill")
      await setStatus(adminUser.id, requestId, "submitted")
      await setStatus(adminUser.id, requestId, "in_progress")
      await admin.query(`UPDATE public.stock_requests SET serviced_at = now() WHERE id = $1`, [
        requestId,
      ])
      const { rows: before } = await admin.query(
        `SELECT count(*)::int AS n FROM public.stock_request_events WHERE request_id = $1`,
        [requestId]
      )
      await admin.query(
        `UPDATE public.stock_requests
         SET serviced_at = NULL
         WHERE id = $1
           AND status NOT IN ('serviced', 'invoiced')
           AND serviced_at IS NOT NULL`,
        [requestId]
      )
      const { rows: after } = await admin.query(
        `SELECT count(*)::int AS n FROM public.stock_request_events WHERE request_id = $1`,
        [requestId]
      )
      const { rows: stale } = await admin.query(
        `SELECT count(*)::int AS n
         FROM public.stock_requests
         WHERE status NOT IN ('serviced', 'invoiced')
           AND serviced_at IS NOT NULL`
      )
      if (before[0].n === after[0].n && stale[0].n === 0) {
        pass("serviced_at_backfill", "zero stale rows; status-unchanged cleanup logged no event")
      } else {
        fail(
          "serviced_at_backfill",
          `events ${before[0].n}→${after[0].n}; stale=${stale[0].n}`
        )
      }
    }

    console.log("\n=== 3. Profile access audit and RLS ===")
    await admin.query(`DELETE FROM public.profile_access_events WHERE profile_id = $1`, [
      targetUser.id,
    ])
    await asUser(adminUser.id, (client) =>
      client.query(`UPDATE public.profiles SET role = 'sales' WHERE id = $1`, [targetUser.id])
    )
    await asUser(adminUser.id, (client) =>
      client.query(`UPDATE public.profiles SET active = false WHERE id = $1`, [targetUser.id])
    )

    const { rows: auditRows } = await admin.query(
      `SELECT actor_id::text AS actor_id, from_role, to_role, from_active, to_active
       FROM public.profile_access_events
       WHERE profile_id = $1
       ORDER BY created_at, id`,
      [targetUser.id]
    )
    const roleEvent = auditRows.find(
      (row) =>
        row.from_role === "technicians" &&
        row.to_role === "sales" &&
        row.from_active === true &&
        row.to_active === true
    )
    const activeEvent = auditRows.find(
      (row) =>
        row.from_role === "sales" &&
        row.to_role === "sales" &&
        row.from_active === true &&
        row.to_active === false
    )
    if (
      auditRows.length === 2 &&
      roleEvent?.actor_id === adminUser.id &&
      activeEvent?.actor_id === adminUser.id
    ) {
      pass("profile_access_audit", "role and active changes captured with pooled auth.uid() actor")
    } else {
      fail("profile_access_audit", JSON.stringify(auditRows))
    }

    const nonAdminCount = await asUser(techUser.id, async (client) => {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM public.profile_access_events WHERE profile_id = $1`,
        [targetUser.id]
      )
      return rows[0].n
    })
    const adminCount = await asUser(adminUser.id, async (client) => {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM public.profile_access_events WHERE profile_id = $1`,
        [targetUser.id]
      )
      return rows[0].n
    })
    if (nonAdminCount === 0 && adminCount === 2) {
      pass("profile_access_events_rls", "non-admin=0 rows; admin=2 rows")
    } else {
      fail("profile_access_events_rls", `non-admin=${nonAdminCount}; admin=${adminCount}`)
    }
    {
      const { rows } = await admin.query(`
        SELECT
          has_table_privilege('authenticated', 'public.profile_access_events', 'INSERT') AS can_insert,
          has_table_privilege('authenticated', 'public.profile_access_events', 'UPDATE') AS can_update,
          has_table_privilege('authenticated', 'public.profile_access_events', 'DELETE') AS can_delete,
          has_function_privilege(
            'authenticated',
            'public.tr_profiles_log_access_change()',
            'EXECUTE'
          ) AS can_execute_trigger
      `)
      const acl = rows[0]
      if (
        acl.can_insert === false &&
        acl.can_update === false &&
        acl.can_delete === false &&
        acl.can_execute_trigger === false
      ) {
        pass("profile_access_events_immutability", "no client writes or trigger EXECUTE")
      } else {
        fail("profile_access_events_immutability", JSON.stringify(acl))
      }
    }
  } finally {
    console.log("\n=== Cleanup and residue assertion ===")
    try {
      await cleanupRequests()
      await cleanupProductLines()
      const auditTableExists = await hasProfileAccessEvents()
      if (auditTableExists) {
        await admin.query(
          `DELETE FROM public.profile_access_events
           WHERE profile_id = ANY($1::uuid[])
              OR profile_id IN (
                SELECT id FROM public.profiles WHERE email LIKE $2
              )`,
          [fixtureUserIds, `${EMAIL_PREFIX}%`]
        )
      }
      for (const id of [...new Set(fixtureUserIds)]) {
        const { error } = await supabaseAdmin.auth.admin.deleteUser(id)
        if (error && !/not found/i.test(error.message)) {
          throw new Error(`deleteUser(${id}): ${error.message}`)
        }
      }
      await deleteFixtureUsersByPrefix()

      const profileEventsSql = auditTableExists
        ? `(SELECT count(*)::int
            FROM public.profile_access_events e
            LEFT JOIN public.profiles p ON p.id = e.profile_id
            WHERE e.profile_id = ANY($3::uuid[])
               OR p.email LIKE $1)`
        : `(SELECT 0 WHERE cardinality($3::uuid[]) IS NOT NULL)`
      const { rows } = await admin.query(
        `SELECT
          (SELECT count(*)::int FROM public.stock_requests
            WHERE notes LIKE 'verify-054 %'
               OR id = ANY($2::uuid[])) AS requests,
          (SELECT count(*)::int FROM public.stock_request_lines
            WHERE request_id = ANY($2::uuid[])) AS lines,
          (SELECT count(*)::int FROM public.stock_request_events
            WHERE request_id = ANY($2::uuid[])) AS request_events,
          (SELECT count(*)::int FROM public.notifications
            WHERE metadata->>'request_id' = ANY($4::text[])) AS notifications,
          (SELECT count(*)::int FROM public.profiles
            WHERE email LIKE $1) AS profiles,
          ${profileEventsSql} AS profile_events,
          (SELECT count(*)::int FROM public.product_lines
            WHERE id LIKE 'pl-v054-%') AS product_lines`,
        [
          `${EMAIL_PREFIX}%`,
          requestIds,
          fixtureUserIds,
          requestIds.map((id) => String(id)),
        ]
      )
      const residue = rows[0]
      if (Object.values(residue).every((count) => Number(count) === 0)) {
        pass("zero_residue", JSON.stringify(residue))
      } else {
        fail("zero_residue", JSON.stringify(residue))
      }
    } catch (error) {
      fail("zero_residue", error.message)
    } finally {
      await admin.end().catch(() => {})
    }
  }

  console.log("\n========== VERIFY 054 SUMMARY ==========")
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
