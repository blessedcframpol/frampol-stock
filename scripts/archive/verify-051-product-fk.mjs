/**
 * Verify migration 051_stock_request_lines_product_fk.sql (and 052 message) against
 * the live schema. Does not apply SQL.
 *
 * Creates verify-051-* fixtures, runs backfill / FK / requires_serial
 * / assign / concurrency / grant checks, then cleans up in finally.
 * Also deletes the cancelled audit leftover (a95a25eb / __audit_verify_product__)
 * if it is present, and fails when any of that residue remains.
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SUPABASE_DB_URL (or DATABASE_URL)
 *
 * Safety:
 *   VERIFY_051_I_KNOW_THIS_IS_NOT_PROD=1  — required or the script exits.
 *
 * Usage:
 *   VERIFY_051_I_KNOW_THIS_IS_NOT_PROD=1 node scripts/verify-051-product-fk.mjs
 *
 * Status-gate checks use asActor (JWT claims, no SET ROLE) so RLS does not mask
 * the guard. RPC / concurrency / RLS-select checks use asUser (SET LOCAL ROLE
 * authenticated). Flag-toggle checks 11–12 always ROLLBACK.
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"
import { execSync } from "child_process"
import { createClient } from "@supabase/supabase-js"

const require = createRequire(import.meta.url)
const { prepareVerifyEnv } = require("./verify-env.cjs")

const FIXTURE_PASSWORD = "Verify051!ProductFk-Temp"
const EMAIL = {
  sales: "verify-051-sales@example.com",
  tech: "verify-051-tech@example.com",
}

/**
 * Discovery mappings for the real lines that were live when 051 was written.
 * The cancelled audit leftover (request a95a25eb, product __audit_verify_product__)
 * is not in this list. cleanupAuditLeftover() deletes it if it reappears.
 */
const AUDIT_REQUEST_ID = "a95a25eb-2edb-4baa-a1f6-1449a2bf316a"
const AUDIT_PRODUCT_ID = "pl-audit-verify"
const AUDIT_PRODUCT_NAME = "__audit_verify_product__"

const EXPECTED_LIVE_LINES = [
  {
    requestPrefix: "e684584c",
    product_name: "Access Point",
    product_id: "PL-2e92a5d1b0987ed66bcd09f77e807a88",
  },
  {
    requestPrefix: "e684584c",
    product_name: "Starlink Standard Kit v4",
    product_id: "PL-0f5e21b74e33b8c442fee9330c8b07c6",
  },
  {
    requestPrefix: "e684584c",
    product_name: "Unifi Cloud Gateway Ultra (UCG)",
    product_id: "PL-c3f944b12888987870f330129f5cf6f2",
  },
  {
    requestPrefix: "5797c194",
    product_name: "Starlink Standard Kit v4",
    product_id: "PL-0f5e21b74e33b8c442fee9330c8b07c6",
  },
  {
    requestPrefix: "06c8bbf9",
    product_name: "Starlink Standard Kit v4",
    product_id: "PL-0f5e21b74e33b8c442fee9330c8b07c6",
  },
]

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function stamp() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

async function require051Schema(admin) {
  const { rows: pid } = await admin.query(`
    SELECT a.attnotnull AS not_null
    FROM pg_attribute a
    WHERE a.attrelid = 'public.stock_request_lines'::regclass
      AND a.attname = 'product_id'
      AND a.attnum > 0 AND NOT a.attisdropped
  `)
  if (!pid[0]?.not_null) {
    throw new Error(
      "Expected 051 schema is missing (stock_request_lines.product_id NOT NULL). Apply supabase/migrations/051_stock_request_lines_product_fk.sql first."
    )
  }

  const { rows: fk } = await admin.query(`
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.stock_request_lines'::regclass
      AND conname = 'stock_request_lines_product_id_fkey'
  `)
  if (!fk[0]) {
    throw new Error(
      "Expected 051 schema is missing (FK stock_request_lines_product_id_fkey). Apply supabase/migrations/051_stock_request_lines_product_fk.sql first."
    )
  }

  const { rows: flag } = await admin.query(`
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'public.product_lines'::regclass
      AND attname = 'requires_serial'
      AND attnum > 0 AND NOT attisdropped
  `)
  if (!flag[0]) {
    throw new Error(
      "Expected 051 schema is missing (product_lines.requires_serial). Apply supabase/migrations/051_stock_request_lines_product_fk.sql first."
    )
  }

  const { rows: assignRows } = await admin.query(`
    SELECT pg_get_functiondef('public.assign_serial_to_request_line(uuid, text)'::regprocedure) AS def
  `)
  const assignDef = assignRows[0]?.def ?? ""
  if (!/inv_rec\.product_id IS DISTINCT FROM line_rec\.product_id/.test(assignDef)) {
    throw new Error(
      "Expected 051 schema is missing: assign_serial_to_request_line does not compare product_id. Apply supabase/migrations/051_stock_request_lines_product_fk.sql first."
    )
  }

  const { rows: guardRows } = await admin.query(`
    SELECT pg_get_functiondef('public.tr_stock_requests_guard_status_transition()'::regprocedure) AS def
  `)
  const guardDef = guardRows[0]?.def ?? ""
  if (!/\brequires_serial\b/.test(guardDef) || /like\s+'%starlink%'/i.test(guardDef)) {
    throw new Error(
      "Serial gate does not read product_lines.requires_serial. Apply supabase/migrations/051_stock_request_lines_product_fk.sql first."
    )
  }
  if (!/serial-tracked lines need all serials assigned/.test(guardDef)) {
    throw new Error(
      "Expected 052 schema is missing (serviced-gate message still says Starlink). Apply supabase/migrations/052_serviced_gate_message.sql first."
    )
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  prepareVerifyEnv()

  if (process.env.VERIFY_051_I_KNOW_THIS_IS_NOT_PROD !== "1") {
    console.error(
      "Refusing to run against a database without VERIFY_051_I_KNOW_THIS_IS_NOT_PROD=1"
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
    console.error("Installing pg…")
    execSync("npm install pg --no-save", { stdio: "inherit" })
    pg = require("pg")
  }

  const supabaseAdmin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const admin = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
  await admin.connect()
  console.log("Connected to Postgres")

  const results = {}
  const fixtureUserIds = []
  const cleanup = {
    requests: [],
    inventory: [],
    productLines: [],
  }

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
  }

  /** JWT + SET LOCAL ROLE authenticated (RLS on). */
  async function asUser(userId, fn) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
    await client.connect()
    try {
      await client.query("BEGIN")
      await setJwt(client, userId)
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

  /**
   * JWT only — stays as table owner / postgres so RLS does not mask the guard.
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

  /** Like asActor but always ROLLBACK (flag-toggle proofs 11–12). */
  async function asActorRollback(userId, fn) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
    await client.connect()
    try {
      await client.query("BEGIN")
      await setJwt(client, userId)
      const result = await fn(client)
      await client.query("ROLLBACK")
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

  async function openUserSession(userId) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
    await client.connect()
    await client.query("BEGIN")
    await setJwt(client, userId)
    await client.query(`SET LOCAL ROLE authenticated`)
    return client
  }

  async function deleteFixtureUsersByEmail() {
    const { rows } = await admin.query(
      `SELECT id::text AS id, email FROM public.profiles WHERE email LIKE 'verify-051-%'`
    )
    for (const r of rows) {
      const { error } = await supabaseAdmin.auth.admin.deleteUser(r.id)
      if (error) console.warn(`Could not delete fixture ${r.email}: ${error.message}`)
      else console.log(`Deleted leftover fixture ${r.email}`)
    }
  }

  /**
   * Removes the cancelled audit request and catalog row (migration 054's fixture).
   * Inventory that still points at the product is left in place so a real item is
   * not deleted; the residue check then fails instead of hiding the reference.
   */
  async function cleanupAuditLeftover() {
    await admin.query(
      `UPDATE public.inventory_items
       SET reserved_for_request_line_id = NULL
       WHERE reserved_for_request_line_id IN (
         SELECT id FROM public.stock_request_lines WHERE request_id = $1::uuid
       )`,
      [AUDIT_REQUEST_ID]
    )
    await admin.query(`DELETE FROM public.notifications WHERE metadata->>'request_id' = $1`, [
      AUDIT_REQUEST_ID,
    ])
    await admin.query(`DELETE FROM public.transactions WHERE item_name = $1`, [AUDIT_PRODUCT_NAME])
    await admin.query(`DELETE FROM public.stock_requests WHERE id = $1::uuid`, [AUDIT_REQUEST_ID])
    await admin.query(
      `DELETE FROM public.product_lines AS product
       WHERE (product.id = $1 OR product.product_name = $2)
         AND NOT EXISTS (
           SELECT 1 FROM public.inventory_items AS item WHERE item.product_id = product.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM public.stock_request_lines AS line WHERE line.product_id = product.id
         )`,
      [AUDIT_PRODUCT_ID, AUDIT_PRODUCT_NAME]
    )
  }

  async function cleanupOwnedFixtures() {
    await admin.query(
      `UPDATE public.inventory_items
       SET reserved_for_request_line_id = NULL
       WHERE id LIKE 'inv-v051-%'
          OR id = ANY($1::text[])`,
      [cleanup.inventory]
    )
    await admin.query(
      `DELETE FROM public.inventory_items
       WHERE id LIKE 'inv-v051-%'
          OR id = ANY($1::text[])`,
      [cleanup.inventory]
    )

    const { rows: reqRows } = await admin.query(
      `SELECT id::text AS id FROM public.stock_requests WHERE notes LIKE 'verify-051%'`
    )
    const requestIds = [...new Set([...cleanup.requests, ...reqRows.map((r) => r.id)])]
    for (const id of requestIds) {
      await admin.query(`DELETE FROM public.notifications WHERE metadata->>'request_id' = $1`, [id])
      await admin.query(`DELETE FROM public.stock_requests WHERE id = $1`, [id])
    }

    await admin.query(
      `DELETE FROM public.product_lines
       WHERE id LIKE 'pl-v051-%'
          OR id = ANY($1::text[])
          OR product_name LIKE '\\_\\_verify\\_051\\_anon\\_%' ESCAPE '\\'`,
      [cleanup.productLines]
    )
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
    await admin.query(`UPDATE public.profiles SET role = $2::public.app_role, active = true WHERE id = $1`, [
      id,
      role,
    ])
    const { rows } = await admin.query(
      `SELECT id::text AS id, email, role::text AS role, active FROM public.profiles WHERE id = $1`,
      [id]
    )
    assert(rows[0]?.role === role && rows[0]?.active === true, `Fixture ${email} not ${role}/active`)
    return rows[0]
  }

  async function resolveOrCreateRole(role, email, { preferExisting = true } = {}) {
    if (preferExisting) {
      const { rows } = await admin.query(
        `SELECT id::text AS id, email, role::text AS role, active
         FROM public.profiles
         WHERE role = $1::public.app_role AND active = true
         ORDER BY email LIMIT 1`,
        [role]
      )
      if (rows[0]) {
        console.log(`Reusing ${role}: ${rows[0].email}`)
        return rows[0]
      }
    }
    console.log(`Creating fixture ${email} (${role})`)
    return createFixtureUser(email, role)
  }

  async function readAcl(regproc) {
    const { rows } = await admin.query(
      `SELECT
         has_function_privilege('anon', $1::regprocedure, 'EXECUTE') AS anon_exec,
         has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') AS auth_exec,
         has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') AS service_exec,
         EXISTS (
           SELECT 1
           FROM aclexplode(COALESCE(
             (SELECT proacl FROM pg_proc WHERE oid = $1::regprocedure),
             acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = $1::regprocedure))
           )) a
           WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
         ) AS public_exec`,
      [regproc]
    )
    return rows[0]
  }

  let clientId
  {
    const { rows } = await admin.query(`SELECT id FROM public.clients LIMIT 1`)
    if (rows[0]) clientId = rows[0].id
    else {
      const ins = await admin.query(
        `INSERT INTO public.clients (id, name, company, email)
         VALUES (gen_random_uuid()::text, 'Verify051', 'Verify051 Co', 'verify051@example.com')
         RETURNING id`
      )
      clientId = ins.rows[0].id
    }
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
      default:
        throw new Error(`Unknown target status ${target}`)
    }
  }

  async function ensureProductLine(productName, { requiresSerial = false } = {}) {
    const { rows } = await admin.query(
      `SELECT id FROM public.product_lines WHERE lower(trim(product_name)) = lower(trim($1)) LIMIT 1`,
      [productName]
    )
    if (rows[0]) return rows[0].id
    const id = `pl-v051-${stamp()}`
    await admin.query(
      `INSERT INTO public.product_lines (id, product_name, vendor, requires_serial)
       VALUES ($1, $2, 'General', $3)`,
      [id, productName, requiresSerial]
    )
    cleanup.productLines.push(id)
    return id
  }

  async function createRequestAt(ownerId, targetStatus, opts = {}) {
    const tag = stamp()
    const notes = opts.notes ?? `verify-051 ${tag}`
    const { rows } = await admin.query(
      `INSERT INTO public.stock_requests (client_id, created_by, status, notes)
       VALUES ($1, $2, 'draft', $3) RETURNING id::text AS id`,
      [clientId, ownerId, notes]
    )
    const requestId = rows[0].id
    cleanup.requests.push(requestId)

    const lines = opts.lines ?? [{ product_name: `Widget-${tag}`, quantity_requested: 1 }]
    const lineIds = []
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]
      const productId =
        ln.product_id ?? (await ensureProductLine(ln.product_name, { requiresSerial: ln.requiresSerial }))
      const ins = await admin.query(
        `INSERT INTO public.stock_request_lines
           (request_id, product_name, quantity_requested, sort_order, product_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id::text AS id`,
        [requestId, ln.product_name, ln.quantity_requested, i, productId]
      )
      lineIds.push(ins.rows[0].id)
    }

    const actorForWalk = opts.walkActorId ?? adminActorId
    assert(actorForWalk, "adminActorId not set")

    for (const next of statusPathTo(targetStatus)) {
      const actor =
        next === "submitted" ? (opts.submitActorId ?? ownerId) : (opts.fulfillActorId ?? actorForWalk)
      await asActor(actor, async (c) => {
        await c.query(`UPDATE public.stock_requests SET status = $2 WHERE id = $1`, [requestId, next])
      })
    }

    const { rows: st } = await admin.query(`SELECT status FROM public.stock_requests WHERE id = $1`, [
      requestId,
    ])
    assert(st[0]?.status === targetStatus, `createRequestAt expected ${targetStatus}, got ${st[0]?.status}`)
    return { requestId, lineIds, tag }
  }

  async function createInStockItem(productName, opts = {}) {
    const productId = opts.productId ?? (await ensureProductLine(productName, opts))
    const id = `inv-v051-${stamp()}`
    const serial = `V051-${stamp()}`
    await admin.query(
      `INSERT INTO public.inventory_items (
         id, product_id, serial_number, status, date_added, location
       ) VALUES ($1, $2, $3, 'In Stock', current_date::text, 'Warehouse A')`,
      [id, productId, serial]
    )
    cleanup.inventory.push(id)
    return { id, serial, productName, productId }
  }

  async function setStatus(actorId, requestId, status) {
    await asActor(actorId, async (c) => {
      await c.query(`UPDATE public.stock_requests SET status = $2 WHERE id = $1`, [requestId, status])
    })
  }

  async function expectTransitionOk(name, actorId, requestId, toStatus) {
    try {
      await setStatus(actorId, requestId, toStatus)
      const { rows } = await admin.query(`SELECT status FROM public.stock_requests WHERE id = $1`, [requestId])
      if (rows[0]?.status === toStatus) pass(name, `${toStatus}`)
      else fail(name, `status is ${rows[0]?.status}`)
    } catch (e) {
      fail(name, e.message)
    }
  }

  async function expectRaiseOnRequest(name, actorId, requestId, toStatus, msgRe) {
    try {
      await setStatus(actorId, requestId, toStatus)
      fail(name, `expected raise matching ${msgRe}, but UPDATE succeeded`)
    } catch (e) {
      if (msgRe.test(e.message)) pass(name, e.message.split("\n")[0])
      else fail(name, `wrong error: ${e.message}`)
    }
  }

  try {
    console.log("\n=== Checking 051/052 schema is already applied ===")
    await require051Schema(admin)
    console.log("051/052 schema present")

    await deleteFixtureUsersByEmail()
    await cleanupOwnedFixtures()
    await cleanupAuditLeftover()

    // ================================================================== 1
    console.log("\n=== 1. Live line backfill ===")
    {
      const { rows } = await admin.query(
        `SELECT l.id::text AS line_id,
                left(l.request_id::text, 8) AS request_prefix,
                l.product_name,
                l.product_id,
                p.product_name AS catalog_name
         FROM public.stock_request_lines l
         LEFT JOIN public.product_lines p ON p.id = l.product_id`
      )
      const nullIds = rows.filter((r) => r.product_id == null)
      const mismatch = rows.filter(
        (r) =>
          r.product_id != null &&
          String(r.catalog_name ?? "")
            .trim()
            .toLowerCase() !== String(r.product_name ?? "").trim().toLowerCase()
      )
      if (nullIds.length === 0 && mismatch.length === 0 && rows.length > 0) {
        pass(
          "1_live_lines_backfill",
          `${rows.length} rows, all product_id NOT NULL and fold-match catalog name`
        )
      } else {
        fail(
          "1_live_lines_backfill",
          `count=${rows.length} null=${nullIds.length} mismatch=${JSON.stringify(mismatch)}`
        )
      }

      const missing = []
      const wrong = []
      for (const exp of EXPECTED_LIVE_LINES) {
        const hit = rows.find(
          (r) => r.request_prefix === exp.requestPrefix && r.product_name === exp.product_name
        )
        if (!hit) missing.push(exp)
        else if (hit.product_id !== exp.product_id) {
          wrong.push({ ...exp, actual: hit.product_id })
        }
      }
      if (missing.length === 0 && wrong.length === 0) {
        pass(
          "1_live_lines_expected_ids",
          `${EXPECTED_LIVE_LINES.length} discovery rows matched exact product_id`
        )
      } else {
        fail("1_live_lines_expected_ids", JSON.stringify({ missing, wrong }))
      }

      const { rows: leftover } = await admin.query(
        `SELECT
           (SELECT count(*)::int FROM public.stock_requests WHERE id = $1::uuid) AS requests,
           (SELECT count(*)::int FROM public.stock_request_lines WHERE request_id = $1::uuid) AS lines,
           (SELECT count(*)::int FROM public.stock_request_events WHERE request_id = $1::uuid) AS events,
           (SELECT count(*)::int FROM public.product_lines
             WHERE id = $2 OR product_name = $3) AS products,
           (SELECT count(*)::int FROM public.transactions WHERE item_name = $3) AS transactions`,
        [AUDIT_REQUEST_ID, AUDIT_PRODUCT_ID, AUDIT_PRODUCT_NAME]
      )
      const counts = leftover[0]
      if (Object.values(counts).every((count) => Number(count) === 0)) {
        pass("1_audit_leftover_absent", JSON.stringify(counts))
      } else {
        fail("1_audit_leftover_absent", JSON.stringify(counts))
      }
    }

    // ================================================================== 5–6 before extra fixture products
    console.log("\n=== 5–6. requires_serial parity ===")
    {
      const { rows } = await admin.query(
        `SELECT
           (SELECT count(*)::int FROM public.product_lines WHERE requires_serial) AS flagged,
           (SELECT count(*)::int FROM public.product_lines
             WHERE lower(btrim(product_name)) LIKE '%starlink%') AS starlink,
           (SELECT count(*)::int FROM public.product_lines
             WHERE requires_serial
               AND lower(btrim(product_name)) NOT LIKE '%starlink%') AS extra_flagged,
           (SELECT count(*)::int FROM public.product_lines
             WHERE NOT requires_serial
               AND lower(btrim(product_name)) LIKE '%starlink%') AS unflagged_starlink,
           (SELECT count(*)::int FROM public.product_lines) AS total`
      )
      const r = rows[0]
      if (r.flagged === r.starlink && r.extra_flagged === 0 && r.unflagged_starlink === 0) {
        pass(
          "5_requires_serial_set_equality",
          `flagged=starlink=${r.flagged}, both extra directions empty`
        )
      } else {
        fail("5_requires_serial_set_equality", JSON.stringify(r))
      }
      if (r.extra_flagged === 0 && r.unflagged_starlink === 0) {
        pass("6_non_starlink_requires_serial_false", `${r.total - r.flagged} remaining rows are false`)
      } else {
        fail("6_non_starlink_requires_serial_false", JSON.stringify(r))
      }
    }

    console.log("\n=== Resolving fixtures ===")
    const adminUser = await resolveOrCreateRole("admin", "verify-051-admin@example.com", { preferExisting: false })
    adminActorId = adminUser.id
    const sales = await createFixtureUser(EMAIL.sales, "sales")
    const tech = await createFixtureUser(EMAIL.tech, "technicians")
    for (const [k, v] of Object.entries({ adminUser, sales, tech })) {
      assert(v?.id && v?.active === true, `Required fixture missing or inactive: ${k}`)
    }
    assert(adminUser.role === "admin", "admin fixture role mismatch")
    assert(sales.role === "sales", "sales fixture role mismatch")
    assert(tech.role === "technicians", "technicians fixture role mismatch")
    console.log("All fixtures resolved")

    // ================================================================== 2–4
    console.log("\n=== 2–4. Constraints ===")
    {
      const { rows } = await admin.query(
        `INSERT INTO public.stock_requests (client_id, created_by, status, notes)
         VALUES ($1, $2, 'draft', $3) RETURNING id::text AS id`,
        [clientId, adminUser.id, `verify-051 ${stamp()}`]
      )
      const requestId = rows[0].id
      cleanup.requests.push(requestId)
      try {
        await admin.query(
          `INSERT INTO public.stock_request_lines (request_id, product_name, quantity_requested, sort_order)
           VALUES ($1, 'NoProductId', 1, 0)`,
          [requestId]
        )
        fail("2_product_id_not_null", "INSERT without product_id succeeded")
      } catch (e) {
        if (e.code === "23502" || /null value in column "product_id"/i.test(e.message)) {
          pass("2_product_id_not_null", e.message.split("\n")[0])
        } else fail("2_product_id_not_null", e.message)
      }
    }
    {
      const { rows } = await admin.query(
        `INSERT INTO public.stock_requests (client_id, created_by, status, notes)
         VALUES ($1, $2, 'draft', $3) RETURNING id::text AS id`,
        [clientId, adminUser.id, `verify-051 ${stamp()}`]
      )
      const requestId = rows[0].id
      cleanup.requests.push(requestId)
      try {
        await admin.query(
          `INSERT INTO public.stock_request_lines
             (request_id, product_name, quantity_requested, sort_order, product_id)
           VALUES ($1, 'MissingFk', 1, 0, 'pl-v051-does-not-exist')`,
          [requestId]
        )
        fail("3_fk_rejects_missing_product", "INSERT with bogus product_id succeeded")
      } catch (e) {
        if (e.code === "23503") pass("3_fk_rejects_missing_product", `23503 ${e.message.split("\n")[0]}`)
        else fail("3_fk_rejects_missing_product", `code=${e.code} ${e.message}`)
      }
    }
    {
      const product = `RestrictDel ${stamp()}`
      const r = await createRequestAt(sales.id, "draft", {
        lines: [{ product_name: product, quantity_requested: 1 }],
      })
      const { rows: ln } = await admin.query(
        `SELECT product_id FROM public.stock_request_lines WHERE id = $1::uuid`,
        [r.lineIds[0]]
      )
      const plId = ln[0].product_id
      try {
        await admin.query(`DELETE FROM public.product_lines WHERE id = $1`, [plId])
        fail("4_on_delete_restrict", "DELETE of referenced product_lines succeeded")
      } catch (e) {
        if (e.code === "23503" || /restrict|violates foreign key/i.test(e.message)) {
          pass("4_on_delete_restrict", e.message.split("\n")[0])
        } else fail("4_on_delete_restrict", e.message)
      }
    }
    {
      const { rows } = await admin.query(
        `SELECT conname, confupdtype, confdeltype
         FROM pg_constraint
         WHERE conrelid = 'public.stock_request_lines'::regclass
           AND conname = 'stock_request_lines_product_id_fkey'`
      )
      const c = rows[0]
      // confupdtype 'c' = CASCADE; confdeltype 'r' = RESTRICT.
      // Did not rename a live/fixture product_lines.id — ids are never updated in practice.
      if (c?.confupdtype === "c" && c?.confdeltype === "r") {
        pass(
          "4_on_update_cascade_pg_constraint",
          "asserted pg_constraint (ON UPDATE CASCADE, ON DELETE RESTRICT); did not exercise PK rename"
        )
      } else {
        fail("4_on_update_cascade_pg_constraint", JSON.stringify(c))
      }
    }

    // ================================================================== 7–12 serial gate
    console.log("\n=== 7–12. Serial gate via requires_serial ===")
    {
      const product = `Starlink Kit ${stamp()}`
      const r = await createRequestAt(sales.id, "in_progress", {
        lines: [{ product_name: product, quantity_requested: 2, requiresSerial: true }],
      })
      await expectRaiseOnRequest(
        "7_serial_gate_0_of_n",
        tech.id,
        r.requestId,
        "serviced",
        /Cannot mark serviced: serial-tracked lines need all serials assigned/
      )
    }
    {
      const product = `Starlink Kit ${stamp()}`
      const r = await createRequestAt(sales.id, "in_progress", {
        lines: [{ product_name: product, quantity_requested: 2, requiresSerial: true }],
      })
      const item = await createInStockItem(product)
      await asUser(tech.id, async (c) => {
        await c.query(`SELECT public.assign_serial_to_request_line($1::uuid, $2)`, [r.lineIds[0], item.id])
      })
      await expectRaiseOnRequest(
        "8_serial_gate_1_of_2",
        tech.id,
        r.requestId,
        "serviced",
        /Cannot mark serviced: serial-tracked lines need all serials assigned/
      )
    }
    {
      const product = `Starlink Kit ${stamp()}`
      const r = await createRequestAt(sales.id, "in_progress", {
        lines: [{ product_name: product, quantity_requested: 2, requiresSerial: true }],
      })
      const a = await createInStockItem(product)
      const b = await createInStockItem(product)
      await asUser(tech.id, async (c) => {
        await c.query(`SELECT public.assign_serial_to_request_line($1::uuid, $2)`, [r.lineIds[0], a.id])
        await c.query(`SELECT public.assign_serial_to_request_line($1::uuid, $2)`, [r.lineIds[0], b.id])
      })
      await expectTransitionOk("9_serial_gate_2_of_2", tech.id, r.requestId, "serviced")
    }
    {
      const product = `Generic Modem ${stamp()}`
      const r = await createRequestAt(sales.id, "in_progress", {
        lines: [{ product_name: product, quantity_requested: 2, requiresSerial: false }],
      })
      await expectTransitionOk("10_serial_gate_false_0_assigned", tech.id, r.requestId, "serviced")
    }
    {
      const product = `GateWidget ${stamp()}`
      const plId = await ensureProductLine(product, { requiresSerial: false })
      const r = await createRequestAt(sales.id, "in_progress", {
        lines: [{ product_name: product, quantity_requested: 1, product_id: plId }],
      })
      try {
        let gateMsg = null
        let unexpected = null
        await asActorRollback(tech.id, async (c) => {
          await c.query(`UPDATE public.product_lines SET requires_serial = true WHERE id = $1`, [plId])
          try {
            await c.query(`UPDATE public.stock_requests SET status = 'serviced' WHERE id = $1`, [r.requestId])
            unexpected = "expected raise, UPDATE succeeded"
          } catch (e) {
            if (/Cannot mark serviced: serial-tracked lines need all serials assigned/.test(e.message)) gateMsg = e.message.split("\n")[0]
            else unexpected = e.message
          }
        })
        const { rows: flag } = await admin.query(
          `SELECT requires_serial FROM public.product_lines WHERE id = $1`,
          [plId]
        )
        if (unexpected) fail("11_flag_on_non_starlink_fires", unexpected)
        else if (flag[0]?.requires_serial !== false) {
          fail("11_flag_on_non_starlink_fires", `flag not rolled back: ${flag[0]?.requires_serial}`)
        } else if (gateMsg) {
          pass("11_flag_on_non_starlink_fires", `gate fired on non-starlink name; rolled back. ${gateMsg}`)
        } else fail("11_flag_on_non_starlink_fires", "no gate and no error")
      } catch (e) {
        fail("11_flag_on_non_starlink_fires", e.message)
      }
    }
    {
      const product = `Starlink Inverse ${stamp()}`
      const plId = await ensureProductLine(product, { requiresSerial: true })
      const r = await createRequestAt(sales.id, "in_progress", {
        lines: [{ product_name: product, quantity_requested: 1, product_id: plId, requiresSerial: true }],
      })
      try {
        await asActorRollback(tech.id, async (c) => {
          await c.query(`UPDATE public.product_lines SET requires_serial = false WHERE id = $1`, [plId])
          await c.query(`UPDATE public.stock_requests SET status = 'serviced' WHERE id = $1`, [r.requestId])
        })
        const { rows: flag } = await admin.query(
          `SELECT requires_serial FROM public.product_lines WHERE id = $1`,
          [plId]
        )
        const { rows: st } = await admin.query(`SELECT status FROM public.stock_requests WHERE id = $1`, [
          r.requestId,
        ])
        if (flag[0]?.requires_serial === true && st[0]?.status === "in_progress") {
          pass(
            "12_flag_off_starlink_does_not_fire",
            "serviced succeeded with flag false despite %starlink% name; flag and status rolled back"
          )
        } else {
          fail(
            "12_flag_off_starlink_does_not_fire",
            `flag=${flag[0]?.requires_serial} status=${st[0]?.status}`
          )
        }
      } catch (e) {
        fail("12_flag_off_starlink_does_not_fire", e.message)
      }
    }

    // ================================================================== 13–15 assign matching
    console.log("\n=== 13–15. Assignment matching via product_id ===")
    {
      const product = `AssignMatch ${stamp()}`
      const r = await createRequestAt(sales.id, "submitted", {
        lines: [{ product_name: product, quantity_requested: 1 }],
      })
      const item = await createInStockItem(product)
      try {
        await asUser(tech.id, async (c) => {
          await c.query(`SELECT public.assign_serial_to_request_line($1::uuid, $2)`, [r.lineIds[0], item.id])
        })
        const { rows } = await admin.query(
          `SELECT reserved_for_request_line_id::text AS line FROM public.inventory_items WHERE id = $1`,
          [item.id]
        )
        if (rows[0]?.line === r.lineIds[0]) pass("13_assign_matching_product_id", "reserved to line")
        else fail("13_assign_matching_product_id", JSON.stringify(rows[0]))
      } catch (e) {
        fail("13_assign_matching_product_id", e.message)
      }
    }
    {
      const productA = `AssignA ${stamp()}`
      const productB = `AssignB ${stamp()}`
      const r = await createRequestAt(sales.id, "submitted", {
        lines: [{ product_name: productA, quantity_requested: 1 }],
      })
      const item = await createInStockItem(productB)
      try {
        await asUser(tech.id, async (c) => {
          await c.query(`SELECT public.assign_serial_to_request_line($1::uuid, $2)`, [r.lineIds[0], item.id])
        })
        fail("14_assign_mismatched_product_id", "assign succeeded across different product_id")
      } catch (e) {
        if (/Product name does not match this line/i.test(e.message)) {
          pass("14_assign_mismatched_product_id", e.message.split("\n")[0])
        } else fail("14_assign_mismatched_product_id", e.message)
      }
    }
    {
      const base = `FoldDup ${stamp()}`
      const idA = await ensureProductLine(base)
      const dupId = `pl-v051-${stamp()}`
      try {
        await admin.query(
          `INSERT INTO public.product_lines (id, product_name, vendor)
           VALUES ($1, $2, 'General')`,
          [dupId, `  ${base.toUpperCase()}  `]
        )
        cleanup.productLines.push(dupId)
        fail(
          "15_unique_index_blocks_fold_duplicate",
          "insert of case/padding variant succeeded; unique index did not block"
        )
      } catch (e) {
        if (e.code === "23505" || /unique/i.test(e.message)) {
          pass(
            "15_unique_index_blocks_fold_duplicate",
            `unique index on lower(trim(product_name)) prevents case/padding duplicates; took the product_id-match path instead. ${e.message.split("\n")[0]}`
          )
        } else fail("15_unique_index_blocks_fold_duplicate", e.message)
      }
      const padded = `  ${base}  `
      const r = await createRequestAt(sales.id, "submitted", {
        lines: [{ product_name: padded, quantity_requested: 1, product_id: idA }],
      })
      const item = await createInStockItem(base, { productId: idA })
      try {
        await asUser(tech.id, async (c) => {
          await c.query(`SELECT public.assign_serial_to_request_line($1::uuid, $2)`, [r.lineIds[0], item.id])
        })
        const { rows } = await admin.query(
          `SELECT reserved_for_request_line_id::text AS line FROM public.inventory_items WHERE id = $1`,
          [item.id]
        )
        if (rows[0]?.line === r.lineIds[0]) {
          pass(
            "15_assign_ignores_padded_product_name",
            "shared product_id matched despite whitespace on retained product_name"
          )
        } else fail("15_assign_ignores_padded_product_name", JSON.stringify(rows[0]))
      } catch (e) {
        fail("15_assign_ignores_padded_product_name", e.message)
      }
    }

    // ================================================================== 16 concurrency
    console.log("\n=== 16. Concurrency (FOR UPDATE) ===")
    {
      const product = `ConcA ${stamp()}`
      const r = await createRequestAt(sales.id, "submitted", {
        lines: [{ product_name: product, quantity_requested: 1 }],
      })
      const itemA = await createInStockItem(product)
      const itemB = await createInStockItem(product)

      const s1 = await openUserSession(tech.id)
      const s2 = await openUserSession(tech.id)
      try {
        await s1.query(`SELECT public.assign_serial_to_request_line($1::uuid, $2)`, [r.lineIds[0], itemA.id])
        await s2.query(`SET LOCAL statement_timeout = '4000ms'`)
        const p2Outcome = s2
          .query(`SELECT public.assign_serial_to_request_line($1::uuid, $2)`, [r.lineIds[0], itemB.id])
          .then(
            async () => {
              await s2.query("COMMIT")
              return { err: null }
            },
            async (e) => {
              try {
                await s2.query("ROLLBACK")
              } catch {
                /* ignore */
              }
              return { err: e }
            }
          )
        await sleep(300)
        await s1.query("COMMIT")
        const { err: p2Err } = await p2Outcome
        const { rows: cnt } = await admin.query(
          `SELECT count(*)::int AS n FROM public.inventory_items WHERE reserved_for_request_line_id = $1::uuid`,
          [r.lineIds[0]]
        )
        if (p2Err && /already has all units assigned/i.test(p2Err.message) && cnt[0].n === 1) {
          pass("16_concurrency_same_line_qty1", `blocked then rejected; assigned=${cnt[0].n}`)
        } else {
          fail("16_concurrency_same_line_qty1", `err=${p2Err?.message ?? "none"} assigned=${cnt[0].n}`)
        }
      } catch (e) {
        fail("16_concurrency_same_line_qty1", e.message)
        try {
          await s1.query("ROLLBACK")
        } catch {
          /* ignore */
        }
        try {
          await s2.query("ROLLBACK")
        } catch {
          /* ignore */
        }
      } finally {
        await s1.end().catch(() => {})
        await s2.end().catch(() => {})
      }
    }
    {
      const product = `ConcB ${stamp()}`
      const r1 = await createRequestAt(sales.id, "submitted", {
        lines: [{ product_name: product, quantity_requested: 1 }],
      })
      const r2 = await createRequestAt(sales.id, "submitted", {
        lines: [{ product_name: product, quantity_requested: 1 }],
      })
      const item = await createInStockItem(product)

      const s1 = await openUserSession(tech.id)
      const s2 = await openUserSession(tech.id)
      try {
        await s1.query(`SELECT public.assign_serial_to_request_line($1::uuid, $2)`, [r1.lineIds[0], item.id])
        await s2.query(`SET LOCAL statement_timeout = '4000ms'`)
        const p2Outcome = s2
          .query(`SELECT public.assign_serial_to_request_line($1::uuid, $2)`, [r2.lineIds[0], item.id])
          .then(
            async () => {
              await s2.query("COMMIT")
              return { err: null }
            },
            async (e) => {
              try {
                await s2.query("ROLLBACK")
              } catch {
                /* ignore */
              }
              return { err: e }
            }
          )
        await sleep(300)
        await s1.query("COMMIT")
        const { err: p2Err } = await p2Outcome
        const { rows: inv } = await admin.query(
          `SELECT reserved_for_request_line_id::text AS line FROM public.inventory_items WHERE id = $1`,
          [item.id]
        )
        if (p2Err && /reserved for another request/i.test(p2Err.message) && inv[0]?.line === r1.lineIds[0]) {
          pass(
            "16_concurrency_same_serial_two_lines",
            `still reserved to line1; ${p2Err.message.split("\n")[0]}`
          )
        } else {
          fail("16_concurrency_same_serial_two_lines", `err=${p2Err?.message ?? "none"} line=${inv[0]?.line}`)
        }
      } catch (e) {
        fail("16_concurrency_same_serial_two_lines", e.message)
        try {
          await s1.query("ROLLBACK")
        } catch {
          /* ignore */
        }
        try {
          await s2.query("ROLLBACK")
        } catch {
          /* ignore */
        }
      } finally {
        await s1.end().catch(() => {})
        await s2.end().catch(() => {})
      }
    }

    // ================================================================== 17 auto-promote
    console.log("\n=== 17. Auto-promote ===")
    {
      const product = `Promo ${stamp()}`
      const r = await createRequestAt(sales.id, "submitted", {
        lines: [{ product_name: product, quantity_requested: 2 }],
      })
      const a = await createInStockItem(product)
      await admin.query(`DELETE FROM public.stock_request_events WHERE request_id = $1`, [r.requestId])
      try {
        await asUser(tech.id, async (c) => {
          await c.query(`SELECT public.assign_serial_to_request_line($1::uuid, $2)`, [r.lineIds[0], a.id])
        })
        const { rows: st } = await admin.query(`SELECT status FROM public.stock_requests WHERE id = $1`, [
          r.requestId,
        ])
        const { rows: ev } = await admin.query(
          `SELECT event_type FROM public.stock_request_events WHERE request_id = $1 ORDER BY created_at`,
          [r.requestId]
        )
        const types = ev.map((e) => e.event_type)
        if (st[0]?.status === "in_progress" && types.includes("serial_assigned") && types.includes("in_progress")) {
          pass("17_auto_promote", `status=in_progress events=${types.join(",")}`)
        } else fail("17_auto_promote", `status=${st[0]?.status} events=${types.join(",")}`)
      } catch (e) {
        fail("17_auto_promote", e.message)
      }
    }

    // ================================================================== 18 grants
    console.log("\n=== 18. Grants ===")
    const grantSpecs = [
      {
        name: "18_grants_ensure_product_line",
        sig: "public.ensure_product_line(text,text)",
        auth: true,
        service: true,
      },
      {
        name: "18_grants_assign_serial",
        sig: "public.assign_serial_to_request_line(uuid,text)",
        auth: true,
        service: false,
      },
      {
        name: "18_grants_release_serial",
        sig: "public.release_serial_from_request_line(text)",
        auth: true,
        service: false,
      },
      {
        name: "18_grants_create_request_serviced_notification",
        sig: "public.create_request_serviced_notification(uuid)",
        auth: true,
        service: false,
      },
      {
        name: "18_grants_get_my_role",
        sig: "public.get_my_role()",
        auth: true,
        service: false,
      },
      // Trigger functions: PUBLIC and anon must not have EXECUTE; authenticated must
      // not either. Do not assert on service_role — leftover default EXECUTE is the
      // service key, which bypasses RLS entirely by design, so its grant on a
      // RETURNS trigger function changes nothing (see 18_handle_new_user_direct_call).
      {
        name: "18_grants_handle_new_user",
        sig: "public.handle_new_user()",
        auth: false,
        trigger: true,
      },
      {
        name: "18_grants_tr_stock_requests_updated_at",
        sig: "public.tr_stock_requests_updated_at_and_side_effects()",
        auth: false,
        trigger: true,
      },
    ]
    for (const spec of grantSpecs) {
      try {
        const acl = await readAcl(spec.sig)
        const anonOk = acl.anon_exec === false
        const publicOk = acl.public_exec === false
        const authOk = acl.auth_exec === spec.auth
        // Trigger ACLs: PUBLIC / anon / authenticated only. service_role is not asserted.
        const triggerOk = spec.trigger
          ? acl.auth_exec === false && acl.anon_exec === false && acl.public_exec === false
          : true
        const ensureOk = spec.service ? acl.service_exec === true : true
        const ok = anonOk && publicOk && authOk && triggerOk && ensureOk
        if (ok) {
          pass(
            spec.name,
            `anon=${acl.anon_exec} public=${acl.public_exec} auth=${acl.auth_exec} service=${acl.service_exec}`
          )
        } else {
          fail(spec.name, JSON.stringify({ expectedAuth: spec.auth, ...acl }))
        }
      } catch (e) {
        fail(spec.name, e.message)
      }
    }
    {
      // Direct call with authenticated JWT, staying as table owner (EXECUTE allowed —
      // same leftover privilege service_role has). RETURNS trigger still cannot be
      // invoked as SQL; that is why the leftover grant is harmless.
      try {
        await asActor(tech.id, async (c) => {
          await c.query(`SELECT public.handle_new_user()`)
        })
        fail("18_handle_new_user_direct_call", "direct call succeeded")
      } catch (e) {
        if (/trigger functions can only be called as triggers/i.test(e.message)) {
          pass("18_handle_new_user_direct_call", e.message.split("\n")[0])
        } else fail("18_handle_new_user_direct_call", e.message)
      }
    }

    // ================================================================== 19 anon ensure_product_line
    console.log("\n=== 19. anon ensure_product_line ===")
    {
      const probeName = `__verify_051_anon_${stamp()}__`
      const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
      await client.connect()
      try {
        await client.query("BEGIN")
        await client.query(`SET LOCAL ROLE anon`)
        await client.query(`SELECT public.ensure_product_line($1, 'General')`, [probeName])
        await client.query("COMMIT")
        fail("19_anon_ensure_product_line_denied", "anon EXECUTE succeeded (hole still open)")
      } catch (e) {
        const denied = e.code === "42501" || /permission denied|insufficient_privilege/i.test(e.message)
        if (denied) pass("19_anon_ensure_product_line_denied", e.message.split("\n")[0])
        else fail("19_anon_ensure_product_line_denied", e.message)
        try {
          await client.query("ROLLBACK")
        } catch {
          /* ignore */
        }
      } finally {
        await client.end().catch(() => {})
      }
      const { rows } = await admin.query(
        `SELECT id FROM public.product_lines WHERE lower(trim(product_name)) = lower(trim($1))`,
        [probeName]
      )
      if (rows.length > 0) {
        fail("19_anon_ensure_product_line_denied", `row inserted despite error: ${rows[0].id}`)
        cleanup.productLines.push(rows[0].id)
      }
    }

    // ================================================================== 20 RLS still works
    console.log("\n=== 20. authenticated SELECT via get_my_role ===")
    {
      try {
        const n = await asUser(tech.id, async (c) => {
          const { rows } = await c.query(`SELECT count(*)::int AS n FROM public.product_lines`)
          return rows[0].n
        })
        if (n > 0) pass("20_authenticated_rls_select", `product_lines visible count=${n}`)
        else fail("20_authenticated_rls_select", "authenticated SELECT returned 0 rows")
      } catch (e) {
        fail("20_authenticated_rls_select", e.message)
      }
    }
  } finally {
    console.log("\n=== Cleanup ===")
    try {
      // FK order: clear reservations, delete inventory, then requests (lines cascade),
      // then product_lines. 051 ON DELETE RESTRICT blocks a catalog delete while a
      // line still references it.
      await cleanupOwnedFixtures()
      await cleanupAuditLeftover()

      for (const id of [...new Set(fixtureUserIds)]) {
        const { error } = await supabaseAdmin.auth.admin.deleteUser(id)
        if (error) console.warn(`deleteUser(${id}): ${error.message}`)
      }
      await deleteFixtureUsersByEmail()

      const { rows: residueRows } = await admin.query(
        `SELECT
           (SELECT count(*)::int FROM auth.users WHERE email LIKE 'verify-051-%') AS auth_users,
           (SELECT count(*)::int FROM public.profiles WHERE email LIKE 'verify-051-%') AS profiles,
           (SELECT count(*)::int FROM public.stock_requests WHERE notes LIKE 'verify-051%') AS requests,
           (SELECT count(*)::int FROM public.inventory_items WHERE id LIKE 'inv-v051-%') AS inventory_items,
           (SELECT count(*)::int FROM public.product_lines
             WHERE id LIKE 'pl-v051-%'
                OR product_name LIKE '\\_\\_verify\\_051\\_anon\\_%' ESCAPE '\\') AS product_lines,
           (SELECT count(*)::int FROM public.stock_requests WHERE id = $1::uuid) AS audit_requests,
           (SELECT count(*)::int FROM public.product_lines
             WHERE id = $2 OR product_name = $3) AS audit_products,
           (SELECT count(*)::int FROM public.transactions WHERE item_name = $3) AS audit_transactions`,
        [AUDIT_REQUEST_ID, AUDIT_PRODUCT_ID, AUDIT_PRODUCT_NAME]
      )
      const residue = residueRows[0]
      if (Object.values(residue).every((count) => Number(count) === 0)) {
        pass("zero_residue", JSON.stringify(residue))
      } else {
        fail("zero_residue", JSON.stringify(residue))
      }
    } catch (e) {
      fail("zero_residue", e.message)
    }
    await admin.end().catch(() => {})
  }

  console.log("\n========== VERIFY 051 SUMMARY ==========")
  console.log(JSON.stringify(results, null, 2))
  console.log("========================================")

  const failed = Object.values(results).filter((r) => r.result === "FAIL")
  if (failed.length > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
