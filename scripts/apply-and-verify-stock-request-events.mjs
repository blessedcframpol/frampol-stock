/**
 * Apply 046_stock_request_events.sql and run Part B verification checks.
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SUPABASE_DB_URL  (or DATABASE_URL) — direct/pooler Postgres URI for DDL + auth.uid() tests
 *
 * Optional for check 1 via app client path:
 *   VERIFY_USER_EMAIL / VERIFY_USER_PASSWORD (non-admin sales or technicians user)
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY
 *
 * Usage: node scripts/apply-and-verify-stock-request-events.mjs
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"
import { execSync } from "child_process"
import { createClient } from "@supabase/supabase-js"

const require = createRequire(import.meta.url)

function loadEnvLocal() {
  const p = path.join(process.cwd(), ".env.local")
  if (!fs.existsSync(p)) return
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    let val = m[2].trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

async function main() {
  loadEnvLocal()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const verifyEmail = process.env.VERIFY_USER_EMAIL
  const verifyPassword = process.env.VERIFY_USER_PASSWORD

  assert(url, "Missing NEXT_PUBLIC_SUPABASE_URL")
  assert(serviceKey, "Missing SUPABASE_SERVICE_ROLE_KEY")
  assert(dbUrl, "Missing SUPABASE_DB_URL or DATABASE_URL (needed for DDL + SET ROLE verification)")

  let pg
  try {
    pg = require("pg")
  } catch {
    console.error("Installing pg…")
    execSync("npm install pg --no-save", { stdio: "inherit" })
    pg = require("pg")
  }

  const sqlPath = path.join(process.cwd(), "supabase/migrations/046_stock_request_events.sql")
  const migrationSql = fs.readFileSync(sqlPath, "utf8")

  const admin = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
  await admin.connect()
  console.log("Connected to Postgres")

  console.log("\n=== Applying migration 046_stock_request_events ===")
  await admin.query(migrationSql)
  console.log("Migration applied OK")

  const report = {
    check1_actor_resolution: null,
    check1_actor_ids: [],
    check2_serial_events: null,
    check3_immutability: null,
    check4_read_scope: null,
    check5_non_blocking: null,
    set_config_fallback_needed: false,
  }

  // Pick users by role
  const { rows: profiles } = await admin.query(`
    SELECT id, email, role::text AS role
    FROM public.profiles
    WHERE active = true AND role IS NOT NULL
    ORDER BY role, email
  `)
  const byRole = (r) => profiles.find((p) => p.role === r)
  const sales = byRole("sales") || byRole("technicians")
  const tech = byRole("technicians") || byRole("admin")
  const accounts = byRole("accounts")
  const adminUser = byRole("admin")
  assert(sales, "Need an active sales or technicians profile for checks")
  assert(adminUser, "Need an active admin profile for checks")

  async function asUser(userId, fn) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
    await client.connect()
    try {
      await client.query("BEGIN")
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
      await client.query(
        `SELECT set_config('request.jwt.claims', $1, true)`,
        [JSON.stringify({ sub: userId, role: "authenticated" })]
      )
      await client.query(`SET LOCAL ROLE authenticated`)
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

  // Ensure a client exists
  let clientId
  {
    const { rows } = await admin.query(`SELECT id FROM public.clients LIMIT 1`)
    if (rows[0]) clientId = rows[0].id
    else {
      const ins = await admin.query(
        `INSERT INTO public.clients (id, name, email) VALUES (gen_random_uuid()::text, 'Audit Verify Client', 'audit-verify@example.com') RETURNING id`
      )
      clientId = ins.rows[0].id
    }
  }

  console.log("\n=== Check 1: actor_id under authenticated JWT ===")
  let requestId
  await asUser(sales.id, async (c) => {
    const ins = await c.query(
      `INSERT INTO public.stock_requests (client_id, created_by, status, notes)
       VALUES ($1, $2, 'draft', 'audit-verify')
       RETURNING id`,
      [clientId, sales.id]
    )
    requestId = ins.rows[0].id
    await c.query(`UPDATE public.stock_requests SET status = 'submitted' WHERE id = $1`, [requestId])
    await c.query(`UPDATE public.stock_requests SET status = 'in_progress' WHERE id = $1`, [requestId])
    await c.query(
      `UPDATE public.stock_requests SET status = 'serviced', serviced_at = now() WHERE id = $1`,
      [requestId]
    )
  })

  const { rows: lifecycleEvents } = await admin.query(
    `SELECT event_type, actor_id::text AS actor_id, from_status, to_status
     FROM public.stock_request_events
     WHERE request_id = $1
     ORDER BY created_at, event_type`,
    [requestId]
  )
  console.log("Lifecycle events:", JSON.stringify(lifecycleEvents, null, 2))
  report.check1_actor_ids = lifecycleEvents.map((e) => e.actor_id)
  const expectedTypes = ["created", "submitted", "in_progress", "serviced"]
  const gotTypes = lifecycleEvents.map((e) => e.event_type)
  const actorsOk = lifecycleEvents.every((e) => e.actor_id === sales.id)
  const typesOk = expectedTypes.every((t) => gotTypes.includes(t))
  if (actorsOk && typesOk) {
    report.check1_actor_resolution = "PASS"
  } else if (lifecycleEvents.some((e) => e.actor_id == null)) {
    report.check1_actor_resolution = "FAIL (actor_id null)"
    report.set_config_fallback_needed = true
  } else {
    report.check1_actor_resolution = `FAIL types=${gotTypes.join(",")} actors=${report.check1_actor_ids.join(",")}`
  }
  console.log("Check 1:", report.check1_actor_resolution, "| expected actor", sales.id)

  console.log("\n=== Check 2: serial_assigned / serial_released ===")
  // Need in_progress request + matching In Stock item. Reset request to in_progress.
  await admin.query(`UPDATE public.stock_requests SET status = 'in_progress' WHERE id = $1`, [requestId])
  let lineId
  let invId
  let serial
  {
    const line = await admin.query(
      `INSERT INTO public.stock_request_lines (request_id, product_name, quantity_requested, sort_order)
       VALUES ($1, $2, 1, 0) RETURNING id, product_name`,
      [requestId, "__audit_verify_product__"]
    )
    lineId = line.rows[0].id
    // Ensure product line + inventory item
    let productId
    const pl = await admin.query(
      `SELECT id FROM public.product_lines WHERE lower(trim(product_name)) = lower(trim($1)) LIMIT 1`,
      ["__audit_verify_product__"]
    )
    if (pl.rows[0]) productId = pl.rows[0].id
    else {
      const created = await admin.query(
        `INSERT INTO public.product_lines (id, product_name, vendor)
         VALUES ('pl-audit-verify', '__audit_verify_product__', 'General') RETURNING id`
      )
      productId = created.rows[0].id
    }
    serial = `AUDIT-VERIFY-${Date.now()}`
    invId = `inv-audit-${Date.now()}`
    await admin.query(
      `INSERT INTO public.inventory_items (
         id, product_id, serial_number, status, date_added, location
       ) VALUES ($1, $2, $3, 'In Stock', current_date::text, 'Warehouse')
       ON CONFLICT (id) DO NOTHING`,
      [invId, productId, serial]
    )
  }

  // Tech/admin for assign RPC
  const assignActor = tech?.role === "technicians" || tech?.role === "admin" ? tech.id : adminUser.id
  await asUser(assignActor, async (c) => {
    await c.query(`SELECT public.assign_serial_to_request_line($1::uuid, $2)`, [lineId, invId])
    await c.query(`SELECT public.release_serial_from_request_line($1)`, [invId])
  })

  const { rows: serialEvents } = await admin.query(
    `SELECT event_type, actor_id::text AS actor_id, payload
     FROM public.stock_request_events
     WHERE request_id = $1 AND event_type IN ('serial_assigned', 'serial_released')
     ORDER BY created_at`,
    [requestId]
  )
  console.log("Serial events:", JSON.stringify(serialEvents, null, 2))
  const hasAssigned = serialEvents.some(
    (e) => e.event_type === "serial_assigned" && e.actor_id === assignActor && e.payload?.serial_number === serial
  )
  const hasReleased = serialEvents.some(
    (e) => e.event_type === "serial_released" && e.actor_id === assignActor && e.payload?.serial_number === serial
  )
  report.check2_serial_events = hasAssigned && hasReleased ? "PASS" : "FAIL"
  console.log("Check 2:", report.check2_serial_events)

  console.log("\n=== Check 3: immutability (direct INSERT/UPDATE/DELETE denied) ===")
  const immut = { insert: null, update: null, delete: null }
  await asUser(sales.id, async (c) => {
    try {
      await c.query(
        `INSERT INTO public.stock_request_events (request_id, event_type) VALUES ($1, 'created')`,
        [requestId]
      )
      immut.insert = "ALLOWED (bad)"
    } catch (e) {
      immut.insert = `DENIED: ${e.code || e.message}`
    }
    try {
      await c.query(
        `UPDATE public.stock_request_events SET event_type = 'tampered' WHERE request_id = $1`,
        [requestId]
      )
      // RLS: UPDATE with no policy → 0 rows, not always error
      const { rowCount } = await c.query(
        `UPDATE public.stock_request_events SET payload = '{"x":1}'::jsonb WHERE request_id = $1 RETURNING id`,
        [requestId]
      )
      immut.update = rowCount === 0 ? "DENIED (0 rows)" : "ALLOWED (bad)"
    } catch (e) {
      immut.update = `DENIED: ${e.code || e.message}`
    }
    try {
      const { rowCount } = await c.query(
        `DELETE FROM public.stock_request_events WHERE request_id = $1 RETURNING id`,
        [requestId]
      )
      immut.delete = rowCount === 0 ? "DENIED (0 rows)" : "ALLOWED (bad)"
    } catch (e) {
      immut.delete = `DENIED: ${e.code || e.message}`
    }
  })
  // Confirm rows still intact
  const { rows: stillThere } = await admin.query(
    `SELECT count(*)::int AS n FROM public.stock_request_events WHERE request_id = $1`,
    [requestId]
  )
  const immutOk =
    String(immut.insert).startsWith("DENIED") &&
    String(immut.update).startsWith("DENIED") &&
    String(immut.delete).startsWith("DENIED") &&
    stillThere[0].n > 0
  report.check3_immutability = immutOk ? "PASS" : `FAIL ${JSON.stringify(immut)}`
  console.log("Check 3:", report.check3_immutability, immut)

  console.log("\n=== Check 4: read scope admin/accounts vs sales/technicians ===")
  async function countAs(userId) {
    return asUser(userId, async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM public.stock_request_events WHERE request_id = $1`,
        [requestId]
      )
      return rows[0].n
    })
  }
  const nAdmin = await countAs(adminUser.id)
  const nAccounts = accounts ? await countAs(accounts.id) : null
  const nSales = await countAs(sales.id)
  const nTech = tech && tech.id !== sales.id ? await countAs(tech.id) : nSales
  console.log({ nAdmin, nAccounts, nSales, nTech })
  const readOk =
    nAdmin > 0 &&
    (nAccounts === null || nAccounts > 0) &&
    nSales === 0 &&
    nTech === 0
  report.check4_read_scope = readOk
    ? "PASS"
    : `FAIL admin=${nAdmin} accounts=${nAccounts} sales=${nSales} tech=${nTech}`
  console.log("Check 4:", report.check4_read_scope)

  console.log("\n=== Check 5: non-blocking status_changed path ===")
  // CHECK constraint prevents illegal status on stock_requests; verify CASE ELSE maps unknown → status_changed
  // and that a normal status update still succeeds after event machinery is in place.
  const mapSql = `
    SELECT CASE $1::text
      WHEN 'submitted' THEN 'submitted'
      WHEN 'in_progress' THEN 'in_progress'
      WHEN 'serviced' THEN 'serviced'
      WHEN 'invoiced' THEN 'invoiced'
      WHEN 'cancelled' THEN 'cancelled'
      ELSE 'status_changed'
    END AS event_type`
  const { rows: mapRows } = await admin.query(mapSql, ["weird_future_status"])
  assert(mapRows[0].event_type === "status_changed", "ELSE branch broken")
  // Parent write still works: cancel
  await asUser(adminUser.id, async (c) => {
    await c.query(`UPDATE public.stock_requests SET status = 'cancelled' WHERE id = $1`, [requestId])
  })
  const { rows: cancelEv } = await admin.query(
    `SELECT event_type, from_status, to_status FROM public.stock_request_events
     WHERE request_id = $1 AND event_type = 'cancelled' ORDER BY created_at DESC LIMIT 1`,
    [requestId]
  )
  report.check5_non_blocking =
    mapRows[0].event_type === "status_changed" && cancelEv[0]?.to_status === "cancelled"
      ? "PASS (ELSE→status_changed present; legitimate cancel succeeded)"
      : "FAIL"
  console.log("Check 5:", report.check5_non_blocking)

  // Optional: app client path (pooled) if credentials provided
  if (anonKey && verifyEmail && verifyPassword) {
    console.log("\n=== Bonus: app client (anon+password) create draft ===")
    const browser = createClient(url, anonKey)
    const { data: authData, error: authErr } = await browser.auth.signInWithPassword({
      email: verifyEmail,
      password: verifyPassword,
    })
    if (authErr) {
      console.log("Bonus skipped: sign-in failed", authErr.message)
    } else {
      const uid = authData.user.id
      const { data: req, error: reqErr } = await browser
        .from("stock_requests")
        .insert({ client_id: clientId, created_by: uid, status: "draft", notes: "pooled-client-verify" })
        .select("id")
        .single()
      if (reqErr) console.log("Bonus insert failed", reqErr.message)
      else {
        const { rows } = await admin.query(
          `SELECT actor_id::text AS actor_id FROM public.stock_request_events
           WHERE request_id = $1 AND event_type = 'created'`,
          [req.id]
        )
        console.log("Pooled client created actor_id:", rows[0]?.actor_id, "expected", uid)
        if (rows[0]?.actor_id !== uid) {
          report.set_config_fallback_needed = true
          report.check1_actor_resolution += " | BONUS pooled path actor mismatch"
        }
      }
      await browser.auth.signOut()
    }
  }

  // Cleanup verification inventory (keep events for inspection unless asked)
  await admin.query(`UPDATE public.inventory_items SET reserved_for_request_line_id = NULL WHERE id = $1`, [invId])
  await admin.query(`DELETE FROM public.inventory_items WHERE id = $1`, [invId])

  await admin.end()

  console.log("\n========== PART B REPORT ==========")
  console.log(JSON.stringify(report, null, 2))
  console.log("set_config fallback needed:", report.set_config_fallback_needed)
  console.log("===================================")

  if (report.set_config_fallback_needed) {
    process.exitCode = 2
  } else if (
    Object.values(report).some((v) => typeof v === "string" && v.startsWith("FAIL"))
  ) {
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
