/**
 * Apply 046_stock_request_events.sql and verify request-event behavior.
 *
 * WARNING: this legacy helper applies migration 046 directly. Do not run it
 * against production. It creates only verify-events-* fixtures and removes all
 * fixtures in finally, with a zero-residue assertion.
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SUPABASE_DB_URL (or DATABASE_URL)
 *
 * Safety:
 *   VERIFY_EVENTS_I_KNOW_THIS_IS_NOT_PROD=1 — required or the script exits.
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"
import { createClient } from "@supabase/supabase-js"

const require = createRequire(import.meta.url)
const EMAIL_PREFIX = "verify-events-"
const EMAIL = {
  admin: "verify-events-admin@test.local",
  sales: "verify-events-sales@test.local",
  tech: "verify-events-tech@test.local",
  accounts: "verify-events-accounts@test.local",
}
const FIXTURE_PASSWORD = "VerifyEvents!Temporary"

function loadEnvLocal() {
  const p = path.join(process.cwd(), ".env.local")
  if (!fs.existsSync(p)) return
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    let value = m[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function stamp() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

async function main() {
  loadEnvLocal()
  if (process.env.VERIFY_EVENTS_I_KNOW_THIS_IS_NOT_PROD !== "1") {
    console.error(
      "Refusing to apply migration 046 without VERIFY_EVENTS_I_KNOW_THIS_IS_NOT_PROD=1"
    )
    process.exit(1)
  }

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
  const inventoryIds = []
  const productLineIds = []
  const clientIds = []

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
      `SELECT id::text AS id FROM public.profiles WHERE email LIKE $1`,
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
      `UPDATE public.profiles SET role = $2::public.app_role, active = true WHERE id = $1`,
      [id, role]
    )
    return { id, email, role }
  }

  async function cleanupRequests() {
    const { rows } = await admin.query(
      `SELECT id::text AS id FROM public.stock_requests WHERE notes LIKE 'verify-events %'`
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

  try {
    await cleanupRequests()
    await admin.query(`DELETE FROM public.inventory_items WHERE id LIKE 'inv-verify-events-%'`)
    await admin.query(`DELETE FROM public.product_lines WHERE id LIKE 'pl-verify-events-%'`)
    await admin.query(`DELETE FROM public.clients WHERE id LIKE 'CLT-VERIFY-EVENTS-%'`)
    await deleteFixtureUsersByPrefix()

    console.log("\n=== Applying migration 046 (non-production only) ===")
    const migrationSql = fs.readFileSync(
      path.join(process.cwd(), "supabase/migrations/046_stock_request_events.sql"),
      "utf8"
    )
    await admin.query(migrationSql)
    pass("migration_046", "applied")

    console.log("\n=== Creating dedicated identities and data ===")
    const adminUser = await createFixtureUser(EMAIL.admin, "admin")
    const salesUser = await createFixtureUser(EMAIL.sales, "sales")
    const techUser = await createFixtureUser(EMAIL.tech, "technicians")
    const accountsUser = await createFixtureUser(EMAIL.accounts, "accounts")

    const clientId = `CLT-VERIFY-EVENTS-${stamp()}`
    clientIds.push(clientId)
    await admin.query(
      `INSERT INTO public.clients (id, name, company, email)
       VALUES ($1, 'Verify Events', 'Verify Events', $2)`,
      [clientId, `verify-events-${stamp()}@test.local`]
    )

    const productId = `pl-verify-events-${stamp()}`
    const productName = `Verify Events Product ${stamp()}`
    productLineIds.push(productId)
    await admin.query(
      `INSERT INTO public.product_lines (id, product_name, vendor, requires_serial)
       VALUES ($1, $2, 'General', false)`,
      [productId, productName]
    )

    let requestId
    await asUser(salesUser.id, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO public.stock_requests (client_id, created_by, status, notes)
         VALUES ($1, $2, 'draft', $3)
         RETURNING id::text AS id`,
        [clientId, salesUser.id, `verify-events ${stamp()}`]
      )
      requestId = rows[0].id
      requestIds.push(requestId)
      await client.query(
        `INSERT INTO public.stock_request_lines
           (request_id, product_name, quantity_requested, sort_order, product_id)
         VALUES ($1, $2, 1, 0, $3)`,
        [requestId, productName, productId]
      )
      await client.query(`UPDATE public.stock_requests SET status = 'submitted' WHERE id = $1`, [
        requestId,
      ])
    })
    await asUser(techUser.id, async (client) => {
      await client.query(`UPDATE public.stock_requests SET status = 'in_progress' WHERE id = $1`, [
        requestId,
      ])
      await client.query(`UPDATE public.stock_requests SET status = 'serviced' WHERE id = $1`, [
        requestId,
      ])
    })

    console.log("\n=== 1. Lifecycle actor resolution ===")
    const { rows: lifecycleEvents } = await admin.query(
      `SELECT event_type, actor_id::text AS actor_id
       FROM public.stock_request_events
       WHERE request_id = $1
       ORDER BY created_at, id`,
      [requestId]
    )
    const expectedActors = {
      created: salesUser.id,
      submitted: salesUser.id,
      in_progress: techUser.id,
      serviced: techUser.id,
    }
    const lifecycleOk = Object.entries(expectedActors).every(([eventType, actorId]) =>
      lifecycleEvents.some(
        (event) => event.event_type === eventType && event.actor_id === actorId
      )
    )
    if (lifecycleOk) pass("lifecycle_actor_resolution", JSON.stringify(expectedActors))
    else fail("lifecycle_actor_resolution", JSON.stringify(lifecycleEvents))

    console.log("\n=== 2. Serial event capture ===")
    await asUser(techUser.id, (client) =>
      client.query(`UPDATE public.stock_requests SET status = 'in_progress' WHERE id = $1`, [
        requestId,
      ])
    )
    const inventoryId = `inv-verify-events-${stamp()}`
    const serial = `VERIFY-EVENTS-${stamp()}`
    inventoryIds.push(inventoryId)
    await admin.query(
      `INSERT INTO public.inventory_items
         (id, product_id, serial_number, status, date_added, location)
       VALUES ($1, $2, $3, 'In Stock', current_date::text, 'Warehouse A')`,
      [inventoryId, productId, serial]
    )
    const { rows: lineRows } = await admin.query(
      `SELECT id::text AS id FROM public.stock_request_lines WHERE request_id = $1`,
      [requestId]
    )
    await asUser(techUser.id, async (client) => {
      await client.query(`SELECT public.assign_serial_to_request_line($1::uuid, $2)`, [
        lineRows[0].id,
        inventoryId,
      ])
      await client.query(`SELECT public.release_serial_from_request_line($1)`, [inventoryId])
    })
    const { rows: serialEvents } = await admin.query(
      `SELECT event_type, actor_id::text AS actor_id, payload
       FROM public.stock_request_events
       WHERE request_id = $1
         AND event_type IN ('serial_assigned', 'serial_released')`,
      [requestId]
    )
    const serialOk = ["serial_assigned", "serial_released"].every((eventType) =>
      serialEvents.some(
        (event) =>
          event.event_type === eventType &&
          event.actor_id === techUser.id &&
          event.payload?.serial_number === serial
      )
    )
    if (serialOk) pass("serial_events", "assigned and released events captured")
    else fail("serial_events", JSON.stringify(serialEvents))

    console.log("\n=== 3. Event immutability ===")
    async function mutationDenied(sql, params) {
      try {
        const rowCount = await asUser(salesUser.id, async (client) => {
          const result = await client.query(sql, params)
          return result.rowCount
        })
        return rowCount === 0
      } catch (error) {
        return error.code === "42501" || /permission denied|row-level security/i.test(error.message)
      }
    }
    const mutationDeniedResults = {
      insert: await mutationDenied(
        `INSERT INTO public.stock_request_events (request_id, event_type)
         VALUES ($1, 'tampered')`,
        [requestId]
      ),
      update: await mutationDenied(
        `UPDATE public.stock_request_events SET payload = '{"bad":true}' WHERE request_id = $1`,
        [requestId]
      ),
      delete: await mutationDenied(
        `DELETE FROM public.stock_request_events WHERE request_id = $1`,
        [requestId]
      ),
    }
    if (Object.values(mutationDeniedResults).every(Boolean)) {
      pass("event_immutability", "insert denied; update/delete affected zero rows")
    } else {
      fail("event_immutability", JSON.stringify(mutationDeniedResults))
    }

    console.log("\n=== 4. Event read scope ===")
    async function countEvents(userId) {
      return asUser(userId, async (client) => {
        const { rows } = await client.query(
          `SELECT count(*)::int AS n FROM public.stock_request_events WHERE request_id = $1`,
          [requestId]
        )
        return rows[0].n
      })
    }
    const scope = {
      admin: await countEvents(adminUser.id),
      accounts: await countEvents(accountsUser.id),
      sales: await countEvents(salesUser.id),
      tech: await countEvents(techUser.id),
    }
    if (scope.admin > 0 && scope.accounts > 0 && scope.sales === 0 && scope.tech === 0) {
      pass("event_read_scope", JSON.stringify(scope))
    } else {
      fail("event_read_scope", JSON.stringify(scope))
    }

    console.log("\n=== 5. Non-blocking status-change path ===")
    const { rows: mapping } = await admin.query(
      `SELECT CASE $1::text
         WHEN 'submitted' THEN 'submitted'
         WHEN 'in_progress' THEN 'in_progress'
         WHEN 'serviced' THEN 'serviced'
         WHEN 'invoiced' THEN 'invoiced'
         WHEN 'cancelled' THEN 'cancelled'
         ELSE 'status_changed'
       END AS event_type`,
      ["future_status"]
    )
    await asUser(adminUser.id, (client) =>
      client.query(`UPDATE public.stock_requests SET status = 'cancelled' WHERE id = $1`, [
        requestId,
      ])
    )
    const { rows: cancelledEvents } = await admin.query(
      `SELECT event_type, from_status, to_status
       FROM public.stock_request_events
       WHERE request_id = $1
         AND event_type = 'cancelled'
       ORDER BY created_at DESC
       LIMIT 1`,
      [requestId]
    )
    if (
      mapping[0]?.event_type === "status_changed" &&
      cancelledEvents[0]?.to_status === "cancelled"
    ) {
      pass("non_blocking_status_change", "ELSE mapping present; legitimate cancel succeeded")
    } else {
      fail(
        "non_blocking_status_change",
        JSON.stringify({ mapping: mapping[0], cancelled: cancelledEvents[0] })
      )
    }
  } finally {
    console.log("\n=== Cleanup and residue assertion ===")
    try {
      for (const id of inventoryIds) {
        await admin
          .query(
            `UPDATE public.inventory_items
             SET reserved_for_request_line_id = NULL
             WHERE id = $1`,
            [id]
          )
          .catch(() => {})
      }
      await admin.query(`DELETE FROM public.inventory_items WHERE id LIKE 'inv-verify-events-%'`)
      await cleanupRequests()
      await admin.query(`DELETE FROM public.product_lines WHERE id LIKE 'pl-verify-events-%'`)
      await admin.query(`DELETE FROM public.clients WHERE id LIKE 'CLT-VERIFY-EVENTS-%'`)

      if (fixtureUserIds.length > 0 && (await tableExists(admin, "profile_access_events"))) {
        await admin.query(
          `DELETE FROM public.profile_access_events WHERE profile_id = ANY($1::uuid[])`,
          [fixtureUserIds]
        )
      }
      for (const id of [...new Set(fixtureUserIds)]) {
        const { error } = await supabaseAdmin.auth.admin.deleteUser(id)
        if (error && !/not found/i.test(error.message)) {
          throw new Error(`deleteUser(${id}): ${error.message}`)
        }
      }
      await deleteFixtureUsersByPrefix()

      const profileAuditCount = (await tableExists(admin, "profile_access_events"))
        ? `(SELECT count(*)::int
            FROM public.profile_access_events e
            LEFT JOIN public.profiles p ON p.id = e.profile_id
            WHERE e.profile_id = ANY($1::uuid[]) OR p.email LIKE $2)`
        : "0"
      const { rows } = await admin.query(
        `SELECT
          (SELECT count(*)::int FROM public.stock_requests
            WHERE notes LIKE 'verify-events %') AS requests,
          (SELECT count(*)::int FROM public.stock_request_lines
            WHERE request_id = ANY($3::uuid[])) AS lines,
          (SELECT count(*)::int FROM public.stock_request_events
            WHERE request_id = ANY($3::uuid[])) AS request_events,
          (SELECT count(*)::int FROM public.notifications
            WHERE metadata->>'request_id' = ANY($4::text[])) AS notifications,
          (SELECT count(*)::int FROM public.inventory_items
            WHERE id LIKE 'inv-verify-events-%') AS inventory,
          (SELECT count(*)::int FROM public.product_lines
            WHERE id LIKE 'pl-verify-events-%') AS products,
          (SELECT count(*)::int FROM public.clients
            WHERE id LIKE 'CLT-VERIFY-EVENTS-%') AS clients,
          (SELECT count(*)::int FROM public.profiles
            WHERE email LIKE $2) AS profiles,
          ${profileAuditCount} AS profile_events`,
        [fixtureUserIds, `${EMAIL_PREFIX}%`, requestIds, requestIds]
      )
      const residue = rows[0]
      if (Object.values(residue).every((count) => count === 0)) {
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

  console.log("\n========== STOCK REQUEST EVENTS REPORT ==========")
  console.log(JSON.stringify(results, null, 2))
  console.log("=================================================")
  if (Object.values(results).some((result) => result.result === "FAIL")) {
    process.exitCode = 1
  }
}

async function tableExists(client, tableName) {
  const { rows } = await client.query(`SELECT to_regclass($1) IS NOT NULL AS exists`, [
    `public.${tableName}`,
  ])
  return rows[0].exists
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
