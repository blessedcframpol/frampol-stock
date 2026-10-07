/**
 * Verify migration 049_stock_request_lifecycle_guard.sql against the current
 * schema (049 + 051/052). Does not apply SQL — re-applying 049 would overwrite
 * assign_serial_to_request_line and tr_stock_requests_guard_status_transition
 * with pre-product_id / pre-requires_serial bodies.
 *
 * Creates verify-049-* fixtures, runs transition / reservation / auto-promote /
 * concurrency / policy checks, then cleans up in finally.
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SUPABASE_DB_URL (or DATABASE_URL)
 *
 * Safety:
 *   VERIFY_049_I_KNOW_THIS_IS_NOT_PROD=1  — required or the script exits.
 *
 * Usage:
 *   VERIFY_049_I_KNOW_THIS_IS_NOT_PROD=1 node scripts/verify-049-stock-request-lifecycle.mjs
 *
 * Transition checks use asActor (JWT claims, no SET ROLE) so RLS does not mask
 * the guard. RPC / concurrency checks use asUser (SET LOCAL ROLE authenticated).
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"
import { execSync } from "child_process"
import { createClient } from "@supabase/supabase-js"

const require = createRequire(import.meta.url)
const { prepareVerifyEnv } = require("./verify-env.cjs")

const FIXTURE_PASSWORD = "Verify049!Lifecycle-Temp"
const EMAIL = {
  sales: "verify-049-sales@example.com",
  salesB: "verify-049-sales-b@example.com",
  accounts: "verify-049-accounts@example.com",
  tech: "verify-049-tech@example.com",
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function stamp() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

async function require049Schema(admin) {
  const { rows: trg } = await admin.query(`
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.stock_requests'::regclass
      AND tgname = 'stock_requests_guard_status'
      AND NOT tgisinternal
  `)
  if (!trg[0]) {
    throw new Error(
      "Expected 049 schema is missing (trigger stock_requests_guard_status). Apply supabase/migrations/049_stock_request_lifecycle_guard.sql first."
    )
  }

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

  // Live predicate, not byte-equality with 049.sql: 051/052 replaced
  // lower(l.product_name) LIKE '%starlink%' with product_lines.requires_serial.
  const { rows: guardRows } = await admin.query(`
    SELECT pg_get_functiondef('public.tr_stock_requests_guard_status_transition()'::regprocedure) AS def
  `)
  const def = guardRows[0]?.def ?? ""
  const readsRequiresSerial = /\brequires_serial\b/.test(def)
  const usesStarlinkLike = /like\s+'%starlink%'/i.test(def)
  if (!readsRequiresSerial || usesStarlinkLike) {
    throw new Error(
      "Serial gate does not read product_lines.requires_serial (still the 049 '%starlink%' predicate). Apply supabase/migrations/051_stock_request_lines_product_fk.sql and 052_serviced_gate_message.sql first."
    )
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  prepareVerifyEnv()

  if (process.env.VERIFY_049_I_KNOW_THIS_IS_NOT_PROD !== "1") {
    console.error(
      "Refusing to run against a database without VERIFY_049_I_KNOW_THIS_IS_NOT_PROD=1"
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
      `SELECT id::text AS id, email FROM public.profiles WHERE email LIKE 'verify-049-%'`
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

  let clientId
  {
    const { rows } = await admin.query(`SELECT id FROM public.clients LIMIT 1`)
    if (rows[0]) clientId = rows[0].id
    else {
      const ins = await admin.query(
        `INSERT INTO public.clients (id, name, company, email)
         VALUES (gen_random_uuid()::text, 'Verify049', 'Verify049 Co', 'verify049@example.com')
         RETURNING id`
      )
      clientId = ins.rows[0].id
    }
  }

  /**
   * Create a disposable request, walking legal transitions with JWT actors
   * so triggers fire. adminActorId must be set first.
   */
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
        return ["cancelled"] // from draft
      default:
        throw new Error(`Unknown target status ${target}`)
    }
  }

  async function createRequestAt(ownerId, targetStatus, opts = {}) {
    const tag = stamp()
    const notes = opts.notes ?? `verify-049 ${tag}`
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

    if (targetStatus === "cancelled" && !opts.fromSubmitted) {
      await asActor(opts.cancelActorId ?? ownerId, async (c) => {
        await c.query(`UPDATE public.stock_requests SET status = 'cancelled' WHERE id = $1`, [requestId])
      })
    } else {
      const path = statusPathTo(targetStatus === "cancelled" ? "submitted" : targetStatus)
      for (const next of path) {
        const actor =
          next === "submitted" || next === "cancelled"
            ? opts.submitActorId ?? ownerId
            : next === "invoiced"
              ? opts.invoiceActorId ?? actorForWalk
              : opts.fulfillActorId ?? actorForWalk
        await asActor(actor, async (c) => {
          await c.query(`UPDATE public.stock_requests SET status = $2 WHERE id = $1`, [requestId, next])
        })
      }
      if (targetStatus === "cancelled" && opts.fromSubmitted) {
        await asActor(opts.cancelActorId ?? ownerId, async (c) => {
          await c.query(`UPDATE public.stock_requests SET status = 'cancelled' WHERE id = $1`, [requestId])
        })
      }
    }

    const { rows: st } = await admin.query(`SELECT status FROM public.stock_requests WHERE id = $1`, [
      requestId,
    ])
    assert(st[0]?.status === targetStatus, `createRequestAt expected ${targetStatus}, got ${st[0]?.status}`)
    return { requestId, lineIds, tag }
  }

  async function ensureProductLine(productName, { requiresSerial = false } = {}) {
    const { rows } = await admin.query(
      `SELECT id FROM public.product_lines WHERE lower(trim(product_name)) = lower(trim($1)) LIMIT 1`,
      [productName]
    )
    if (rows[0]) {
      if (requiresSerial) {
        await admin.query(`UPDATE public.product_lines SET requires_serial = true WHERE id = $1`, [rows[0].id])
      }
      return rows[0].id
    }
    const id = `pl-v049-${stamp()}`
    await admin.query(
      `INSERT INTO public.product_lines (id, product_name, vendor, requires_serial)
       VALUES ($1, $2, 'General', $3)`,
      [id, productName, requiresSerial]
    )
    cleanup.productLines.push(id)
    return id
  }

  async function createInStockItem(productName, opts = {}) {
    const productId = opts.productId ?? (await ensureProductLine(productName, opts))
    const id = `inv-v049-${stamp()}`
    const serial = `V049-${stamp()}`
    await admin.query(
      `INSERT INTO public.inventory_items (
         id, product_id, serial_number, status, date_added, location
       ) VALUES ($1, $2, $3, 'In Stock', current_date::text, 'Warehouse A')`,
      [id, productId, serial]
    )
    cleanup.inventory.push(id)
    return { id, serial, productName }
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
    console.log("\n=== Checking 049/051/052 schema is already applied ===")
    await require049Schema(admin)
    console.log("049 trigger present; serial gate reads requires_serial")

    await deleteFixtureUsersByEmail()

    console.log("\n=== Resolving fixtures ===")
    // Role actors, including admin, are dedicated verify-049-* users.
    const adminUser = await resolveOrCreateRole("admin", "verify-049-admin@example.com", { preferExisting: false })
    adminActorId = adminUser.id
    const sales = await createFixtureUser(EMAIL.sales, "sales")
    const salesB = await createFixtureUser(EMAIL.salesB, "sales")
    const accounts = await createFixtureUser(EMAIL.accounts, "accounts")
    const tech = await createFixtureUser(EMAIL.tech, "technicians")

    for (const [k, v] of Object.entries({ adminUser, sales, salesB, accounts, tech })) {
      assert(v?.id && v?.active === true, `Required fixture missing or inactive: ${k}`)
      assert(v.role, `Fixture ${k} missing role`)
    }
    assert(adminUser.role === "admin", "admin fixture role mismatch")
    assert(sales.role === "sales" && salesB.role === "sales", "sales fixture role mismatch")
    assert(accounts.role === "accounts", "accounts fixture role mismatch")
    assert(tech.role === "technicians", "technicians fixture role mismatch")
    console.log("All fixtures resolved")

    // ================================================================== LEGAL
    console.log("\n=== Legal edges ===")

    {
      const r = await createRequestAt(sales.id, "draft")
      await expectTransitionOk("legal_draft_submitted_owner", sales.id, r.requestId, "submitted")
    }
    {
      const r = await createRequestAt(sales.id, "draft")
      await expectTransitionOk("legal_draft_submitted_admin", adminUser.id, r.requestId, "submitted")
    }
    {
      const r = await createRequestAt(sales.id, "draft")
      await expectTransitionOk("legal_draft_cancelled_owner", sales.id, r.requestId, "cancelled")
    }
    {
      const r = await createRequestAt(sales.id, "submitted")
      await expectTransitionOk("legal_submitted_draft_owner", sales.id, r.requestId, "draft")
    }
    {
      const r = await createRequestAt(sales.id, "submitted")
      await expectTransitionOk("legal_submitted_in_progress_tech", tech.id, r.requestId, "in_progress")
    }
    {
      const r = await createRequestAt(sales.id, "submitted", {
        lines: [{ product_name: `Cable-${stamp()}`, quantity_requested: 1 }],
      })
      await expectTransitionOk("legal_submitted_serviced_tech_no_serial_lines", tech.id, r.requestId, "serviced")
    }
    {
      const r = await createRequestAt(sales.id, "submitted")
      await expectTransitionOk("legal_submitted_cancelled_owner", sales.id, r.requestId, "cancelled")
    }
    {
      const r = await createRequestAt(sales.id, "in_progress")
      await expectTransitionOk("legal_in_progress_serviced_tech", tech.id, r.requestId, "serviced")
    }
    {
      const r = await createRequestAt(sales.id, "in_progress")
      await expectTransitionOk("legal_in_progress_cancelled_tech", tech.id, r.requestId, "cancelled")
    }
    {
      const r = await createRequestAt(sales.id, "serviced")
      await expectTransitionOk("legal_serviced_in_progress_tech_recovery", tech.id, r.requestId, "in_progress")
    }
    {
      const r = await createRequestAt(sales.id, "serviced")
      await expectTransitionOk("legal_serviced_invoiced_accounts", accounts.id, r.requestId, "invoiced")
    }

    // ================================================================ ILLEGAL
    console.log("\n=== Illegal edges ===")
    const illegalMsg = /Invalid stock request transition/i

    async function illegal(name, from, to, ownerId = sales.id) {
      const r = await createRequestAt(ownerId, from)
      await expectRaiseOnRequest(name, adminUser.id, r.requestId, to, illegalMsg)
    }

    await illegal("illegal_draft_in_progress", "draft", "in_progress")
    await illegal("illegal_draft_serviced", "draft", "serviced")
    await illegal("illegal_draft_invoiced", "draft", "invoiced")
    await illegal("illegal_submitted_invoiced", "submitted", "invoiced")
    await illegal("illegal_in_progress_draft", "in_progress", "draft")
    await illegal("illegal_in_progress_submitted", "in_progress", "submitted")
    await illegal("illegal_serviced_draft", "serviced", "draft")
    await illegal("illegal_serviced_cancelled", "serviced", "cancelled")
    await illegal("illegal_invoiced_serviced", "invoiced", "serviced")
    await illegal("illegal_invoiced_cancelled", "invoiced", "cancelled")
    await illegal("illegal_cancelled_draft", "cancelled", "draft")
    await illegal("illegal_cancelled_submitted", "cancelled", "submitted")

    // ============================================================== WRONG ROLE
    console.log("\n=== Wrong role (legal edge) ===")
    {
      const r = await createRequestAt(sales.id, "submitted")
      await expectRaiseOnRequest(
        "wrong_role_sales_submitted_in_progress",
        sales.id,
        r.requestId,
        "in_progress",
        illegalMsg
      )
    }
    {
      const r = await createRequestAt(sales.id, "serviced")
      await expectRaiseOnRequest(
        "wrong_role_sales_serviced_invoiced",
        sales.id,
        r.requestId,
        "invoiced",
        illegalMsg
      )
    }
    {
      const r = await createRequestAt(sales.id, "serviced")
      await expectRaiseOnRequest(
        "wrong_role_tech_serviced_invoiced",
        tech.id,
        r.requestId,
        "invoiced",
        illegalMsg
      )
    }
    {
      const r = await createRequestAt(sales.id, "in_progress")
      await expectRaiseOnRequest(
        "wrong_role_accounts_in_progress_serviced",
        accounts.id,
        r.requestId,
        "serviced",
        illegalMsg
      )
    }
    {
      // salesB does not own sales's draft
      const r = await createRequestAt(sales.id, "draft")
      await expectRaiseOnRequest(
        "wrong_role_non_owner_sales_draft_submitted",
        salesB.id,
        r.requestId,
        "submitted",
        illegalMsg
      )
    }

    // ======================================================= NON-STATUS UPDATES
    console.log("\n=== Non-status updates ===")
    {
      const r = await createRequestAt(sales.id, "draft")
      try {
        await asActor(sales.id, async (c) => {
          await c.query(`UPDATE public.stock_requests SET notes = 'edited-draft' WHERE id = $1`, [r.requestId])
        })
        const { rows } = await admin.query(`SELECT notes, status FROM public.stock_requests WHERE id = $1`, [
          r.requestId,
        ])
        if (rows[0]?.notes === "edited-draft" && rows[0]?.status === "draft") {
          pass("nonstatus_notes_on_draft", "notes updated, status unchanged")
        } else fail("nonstatus_notes_on_draft", JSON.stringify(rows[0]))
      } catch (e) {
        fail("nonstatus_notes_on_draft", e.message)
      }
    }
    {
      const r = await createRequestAt(sales.id, "invoiced")
      try {
        await asActor(adminUser.id, async (c) => {
          await c.query(`UPDATE public.stock_requests SET notes = 'edited-invoiced' WHERE id = $1`, [
            r.requestId,
          ])
        })
        const { rows } = await admin.query(`SELECT notes, status FROM public.stock_requests WHERE id = $1`, [
          r.requestId,
        ])
        if (rows[0]?.notes === "edited-invoiced" && rows[0]?.status === "invoiced") {
          pass("nonstatus_notes_on_invoiced", "notes updated on terminal status")
        } else fail("nonstatus_notes_on_invoiced", JSON.stringify(rows[0]))
      } catch (e) {
        fail("nonstatus_notes_on_invoiced", e.message)
      }
    }

    // ====================================================== SERIAL REQUIREMENT
    console.log("\n=== Serial requirement (requires_serial) ===")
    {
      const product = `Starlink Kit ${stamp()}`
      const r = await createRequestAt(sales.id, "in_progress", {
        lines: [{ product_name: product, quantity_requested: 2, requiresSerial: true }],
      })
      await expectRaiseOnRequest(
        "serial_req_0_of_2_serviced",
        tech.id,
        r.requestId,
        "serviced",
        /Cannot mark serviced/i
      )
    }
    {
      const product = `Starlink Kit ${stamp()}`
      const r = await createRequestAt(sales.id, "in_progress", {
        lines: [{ product_name: product, quantity_requested: 2, requiresSerial: true }],
      })
      const item = await createInStockItem(product, { requiresSerial: true })
      await asUser(tech.id, async (c) => {
        await c.query(`SELECT public.assign_serial_to_request_line($1::uuid, $2)`, [
          r.lineIds[0],
          item.id,
        ])
      })
      await expectRaiseOnRequest(
        "serial_req_1_of_2_serviced",
        tech.id,
        r.requestId,
        "serviced",
        /Cannot mark serviced/i
      )
    }
    {
      const product = `Starlink Kit ${stamp()}`
      const r = await createRequestAt(sales.id, "in_progress", {
        lines: [{ product_name: product, quantity_requested: 2, requiresSerial: true }],
      })
      const a = await createInStockItem(product, { requiresSerial: true })
      const b = await createInStockItem(product, { requiresSerial: true })
      await asUser(tech.id, async (c) => {
        await c.query(`SELECT public.assign_serial_to_request_line($1::uuid, $2)`, [r.lineIds[0], a.id])
        await c.query(`SELECT public.assign_serial_to_request_line($1::uuid, $2)`, [r.lineIds[0], b.id])
      })
      await expectTransitionOk("serial_req_2_of_2_serviced", tech.id, r.requestId, "serviced")
    }
    {
      const product = `Generic Modem ${stamp()}`
      const r = await createRequestAt(sales.id, "in_progress", {
        lines: [{ product_name: product, quantity_requested: 2 }],
      })
      await expectTransitionOk(
        "serial_req_non_starlink_0_assigned_ok",
        tech.id,
        r.requestId,
        "serviced"
      )
    }

    // ==================================================== RESERVATION RELEASE
    console.log("\n=== Reservation release ===")
    // Reserve via direct inventory UPDATE so status stays where we put it (assign RPC auto-promotes).
    {
      const product = `WidgetRel ${stamp()}`
      const r = await createRequestAt(sales.id, "submitted", {
        lines: [{ product_name: product, quantity_requested: 1 }],
      })
      const item = await createInStockItem(product)
      await admin.query(
        `UPDATE public.inventory_items SET reserved_for_request_line_id = $1::uuid WHERE id = $2`,
        [r.lineIds[0], item.id]
      )
      // Clear prior serials_released events for this request
      await admin.query(`DELETE FROM public.stock_request_events WHERE request_id = $1 AND event_type = 'serials_released'`, [
        r.requestId,
      ])
      try {
        await asActor(sales.id, async (c) => {
          await c.query(`UPDATE public.stock_requests SET status = 'draft' WHERE id = $1`, [r.requestId])
        })
        const { rows: inv } = await admin.query(
          `SELECT reserved_for_request_line_id FROM public.inventory_items WHERE id = $1`,
          [item.id]
        )
        const { rows: ev } = await admin.query(
          `SELECT event_type, from_status, to_status, payload
           FROM public.stock_request_events
           WHERE request_id = $1 AND event_type = 'serials_released'
           ORDER BY created_at DESC LIMIT 1`,
          [r.requestId]
        )
        const okInv = inv[0]?.reserved_for_request_line_id == null
        const okEv =
          ev[0]?.from_status === "submitted" &&
          ev[0]?.to_status === "draft" &&
          Number(ev[0]?.payload?.released_count) === 1
        if (okInv && okEv) pass("release_submitted_to_draft", "cleared + serials_released logged")
        else
          fail(
            "release_submitted_to_draft",
            `inv=${inv[0]?.reserved_for_request_line_id} ev=${JSON.stringify(ev[0])}`
          )
      } catch (e) {
        fail("release_submitted_to_draft", e.message)
      }
    }
    {
      const product = `WidgetRel2 ${stamp()}`
      const r = await createRequestAt(sales.id, "in_progress", {
        lines: [{ product_name: product, quantity_requested: 1 }],
      })
      const item = await createInStockItem(product)
      await admin.query(
        `UPDATE public.inventory_items SET reserved_for_request_line_id = $1::uuid WHERE id = $2`,
        [r.lineIds[0], item.id]
      )
      await admin.query(`DELETE FROM public.stock_request_events WHERE request_id = $1 AND event_type = 'serials_released'`, [
        r.requestId,
      ])
      try {
        await asActor(tech.id, async (c) => {
          await c.query(`UPDATE public.stock_requests SET status = 'cancelled' WHERE id = $1`, [r.requestId])
        })
        const { rows: inv } = await admin.query(
          `SELECT reserved_for_request_line_id FROM public.inventory_items WHERE id = $1`,
          [item.id]
        )
        const { rows: ev } = await admin.query(
          `SELECT from_status, to_status, payload FROM public.stock_request_events
           WHERE request_id = $1 AND event_type = 'serials_released'
           ORDER BY created_at DESC LIMIT 1`,
          [r.requestId]
        )
        const ok =
          inv[0]?.reserved_for_request_line_id == null &&
          ev[0]?.from_status === "in_progress" &&
          ev[0]?.to_status === "cancelled" &&
          Number(ev[0]?.payload?.released_count) === 1
        if (ok) pass("release_in_progress_to_cancelled", "cleared + serials_released logged")
        else fail("release_in_progress_to_cancelled", JSON.stringify({ inv: inv[0], ev: ev[0] }))
      } catch (e) {
        fail("release_in_progress_to_cancelled", e.message)
      }
    }
    {
      const r = await createRequestAt(sales.id, "submitted")
      await admin.query(`DELETE FROM public.stock_request_events WHERE request_id = $1 AND event_type = 'serials_released'`, [
        r.requestId,
      ])
      try {
        await asActor(sales.id, async (c) => {
          await c.query(`UPDATE public.stock_requests SET status = 'draft' WHERE id = $1`, [r.requestId])
        })
        const { rows: ev } = await admin.query(
          `SELECT count(*)::int AS n FROM public.stock_request_events
           WHERE request_id = $1 AND event_type = 'serials_released'`,
          [r.requestId]
        )
        if (ev[0].n === 0) pass("release_zero_reservations_no_event", "no serials_released event")
        else fail("release_zero_reservations_no_event", `events=${ev[0].n}`)
      } catch (e) {
        fail("release_zero_reservations_no_event", e.message)
      }
    }

    // =========================================================== AUTO-PROMOTE
    console.log("\n=== Auto-promote ===")
    {
      const product = `Promo ${stamp()}`
      const r = await createRequestAt(sales.id, "submitted", {
        lines: [{ product_name: product, quantity_requested: 2 }],
      })
      const a = await createInStockItem(product)
      const b = await createInStockItem(product)
      await admin.query(`DELETE FROM public.stock_request_events WHERE request_id = $1`, [r.requestId])
      // Re-seed submitted event not needed
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
        const ok =
          st[0]?.status === "in_progress" &&
          types.includes("serial_assigned") &&
          types.includes("in_progress")
        if (ok) pass("auto_promote_first_assign", `status=in_progress events=${types.join(",")}`)
        else fail("auto_promote_first_assign", `status=${st[0]?.status} events=${types.join(",")}`)

        await asUser(tech.id, async (c) => {
          await c.query(`SELECT public.assign_serial_to_request_line($1::uuid, $2)`, [r.lineIds[0], b.id])
        })
        const { rows: st2 } = await admin.query(`SELECT status FROM public.stock_requests WHERE id = $1`, [
          r.requestId,
        ])
        if (st2[0]?.status === "in_progress") {
          pass("auto_promote_second_assign_stable", "stays in_progress")
        } else fail("auto_promote_second_assign_stable", `status=${st2[0]?.status}`)
      } catch (e) {
        if (!results.auto_promote_first_assign) fail("auto_promote_first_assign", e.message)
        if (!results.auto_promote_second_assign_stable) {
          fail("auto_promote_second_assign_stable", e.message)
        }
      }
    }

    // ============================================================ CONCURRENCY
    console.log("\n=== Concurrency (FOR UPDATE) ===")
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
        await s1.query(`SELECT public.assign_serial_to_request_line($1::uuid, $2)`, [
          r.lineIds[0],
          itemA.id,
        ])
        await s2.query(`SET LOCAL statement_timeout = '4000ms'`)
        // Attach handlers immediately so a rejection while s1 still holds the lock
        // is not an unhandledRejection that kills the process before await.
        const p2Outcome = s2
          .query(`SELECT public.assign_serial_to_request_line($1::uuid, $2)`, [
            r.lineIds[0],
            itemB.id,
          ])
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
          pass("concurrency_same_line_qty1", `blocked then rejected; assigned=${cnt[0].n}`)
        } else {
          fail(
            "concurrency_same_line_qty1",
            `err=${p2Err?.message ?? "none"} assigned=${cnt[0].n}`
          )
        }
      } catch (e) {
        fail("concurrency_same_line_qty1", e.message)
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
        await s1.query(`SELECT public.assign_serial_to_request_line($1::uuid, $2)`, [
          r1.lineIds[0],
          item.id,
        ])
        await s2.query(`SET LOCAL statement_timeout = '4000ms'`)
        const p2Outcome = s2
          .query(`SELECT public.assign_serial_to_request_line($1::uuid, $2)`, [
            r2.lineIds[0],
            item.id,
          ])
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
        if (
          p2Err &&
          /reserved for another request/i.test(p2Err.message) &&
          inv[0]?.line === r1.lineIds[0]
        ) {
          pass("concurrency_same_serial_two_lines", `still reserved to line1; ${p2Err.message.split("\n")[0]}`)
        } else {
          fail(
            "concurrency_same_serial_two_lines",
            `err=${p2Err?.message ?? "none"} line=${inv[0]?.line}`
          )
        }
      } catch (e) {
        fail("concurrency_same_serial_two_lines", e.message)
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

    // ================================================================= POLICY
    console.log("\n=== Policy InitPlan wrapper ===")
    {
      const { rows } = await admin.query(
        `SELECT qual FROM pg_policies
         WHERE schemaname = 'public'
           AND tablename = 'stock_request_events'
           AND policyname = 'stock_request_events_select_oversight'`
      )
      const qual = rows[0]?.qual ?? ""
      if (/SELECT/i.test(qual) && /get_my_role/i.test(qual)) {
        pass("policy_oversight_has_select_wrapper", qual)
      } else {
        fail("policy_oversight_has_select_wrapper", `qual=${qual}`)
      }
    }
  } finally {
    console.log("\n=== Cleanup ===")
    try {
      for (const id of cleanup.inventory) {
        await admin
          .query(`UPDATE public.inventory_items SET reserved_for_request_line_id = NULL WHERE id = $1`, [id])
          .catch(() => {})
      }
      for (const id of cleanup.requests) {
        await admin.query(`DELETE FROM public.stock_request_events WHERE request_id = $1`, [id]).catch(() => {})
        await admin.query(`DELETE FROM public.notifications WHERE metadata->>'request_id' = $1`, [id]).catch(
          () => {}
        )
        await admin.query(`DELETE FROM public.stock_requests WHERE id = $1`, [id]).catch(() => {})
      }
      for (const id of cleanup.inventory) {
        await admin.query(`DELETE FROM public.inventory_items WHERE id = $1`, [id]).catch(() => {})
      }
      for (const id of cleanup.productLines) {
        await admin.query(`DELETE FROM public.product_lines WHERE id = $1`, [id]).catch(() => {})
      }
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

  console.log("\n========== VERIFY 049 SUMMARY ==========")
  console.log(JSON.stringify(results, null, 2))
  console.log("========================================")

  const failed = Object.values(results).filter((r) => r.result === "FAIL")
  if (failed.length > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
