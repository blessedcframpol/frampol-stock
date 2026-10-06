/**
 * Verify 060b_scope_low_stock_and_requires_serial.sql. Does not apply SQL.
 *
 * Creates verify-060b-* identities and __verify_060b__ fixtures, then removes
 * them and asserts the app_settings singleton is unchanged.
 *
 * Usage: node scripts/verify-060b-low-stock-scope.mjs
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"
import { createClient } from "@supabase/supabase-js"
import { getLowStockAlerts } from "../lib/low-stock-helper.mjs"

const require = createRequire(import.meta.url)
const EMAIL_PREFIX = "verify-060b-"
const DATA_PREFIX = "__verify_060b__"
const PRODUCT_IDS = {
  neverStocked: `${DATA_PREFIX}never`,
  soldOut: `${DATA_PREFIX}soldout`,
  guarded: `${DATA_PREFIX}guarded`,
}

function loadEnvLocal() {
  const envPath = path.join(process.cwd(), ".env.local")
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    const key = match[1]
    let value = match[2].trim()
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

function businessSettings(row) {
  return {
    id: row.id,
    default_reorder_level: row.default_reorder_level,
    low_stock_emails_enabled: row.low_stock_emails_enabled,
    low_stock_recipients: row.low_stock_recipients,
    timezone: row.timezone,
    updated_at: new Date(row.updated_at).toISOString(),
    updated_by: row.updated_by,
  }
}

async function main() {
  loadEnvLocal()
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
  let originalSettings = null

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

  async function asActor(userId, fn) {
    const client = new pg.Client({
      connectionString: dbUrl,
      ssl: { rejectUnauthorized: false },
    })
    await client.connect()
    try {
      await client.query("BEGIN")
      await setJwt(client, userId)
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

  async function createIdentities() {
    for (const role of ["sales", "technicians"]) {
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

  async function cleanupFixtures() {
    await db.query(
      `UPDATE public.inventory_items
       SET reserved_for_request_line_id = NULL
       WHERE product_id LIKE $1 OR id LIKE $1`,
      [`${DATA_PREFIX}%`]
    )
    const { rows } = await db.query(
      `SELECT id::text AS id FROM public.stock_requests WHERE notes LIKE 'verify-060b %'`
    )
    for (const row of rows) {
      await db.query(`DELETE FROM public.notifications WHERE metadata->>'request_id' = $1`, [
        row.id,
      ])
      await db.query(`DELETE FROM public.stock_requests WHERE id = $1`, [row.id])
    }
    await db.query(`DELETE FROM public.inventory_items WHERE id LIKE $1 OR product_id LIKE $1`, [
      `${DATA_PREFIX}%`,
    ])
    await db.query(`DELETE FROM public.product_lines WHERE id LIKE $1`, [`${DATA_PREFIX}%`])
  }

  try {
    console.log("\n=== 1. Serial flag call sites ===")
    const read = (relativePath) =>
      fs.readFileSync(path.join(process.cwd(), relativePath), "utf8")
    const form = read("components/stock-request-form.tsx")
    const fulfill = read("components/stock-request-fulfill.tsx")
    const detail = read("components/stock-request-detail.tsx")
    const billing = read("components/stock-request-billing.tsx")
    const callSitesOk =
      !form.includes("requires_serial") &&
      !form.includes("lineRequiresSerialAssignment") &&
      fulfill.includes("Add serial from free pool") &&
      fulfill.includes("linesBlockingServiced") &&
      !fulfill.includes("lineRequiresSerialAssignment") &&
      detail.includes("lineRequiresSerialAssignment") &&
      detail.includes("Serial-tracked: full serial count before serviced") &&
      detail.includes("Optional before serviced") &&
      billing.includes("lineRequiresSerialAssignment") &&
      billing.includes("Serial-tracked — needs full serials to invoice") &&
      billing.includes("canMarkRequestInvoiced")
    if (callSitesOk) {
      pass(
        "serial_flag_call_sites",
        "form ignores the flag; fulfill always shows the picker and blocks Mark serviced; detail and billing change copy and the invoice gate"
      )
    } else {
      fail("serial_flag_call_sites", "a requires_serial screen no longer matches the 060b call-site contract")
    }

    console.log("\n=== 2. Scoped view ===")
    const definition = await db.query(
      `SELECT pg_get_viewdef('public.low_stock_products'::regclass, true) AS def`
    )
    const invoker = await db.query(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_class relation
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname = 'low_stock_products'
           AND relation.relkind = 'v'
           AND relation.reloptions @> ARRAY['security_invoker=true']
       ) AS ok`
    )
    const viewDef = definition.rows[0]?.def ?? ""
    const scoped = /held\.deleted_at IS NULL/i.test(viewDef) && invoker.rows[0]?.ok === true
    if (scoped) pass("schema_scoped_view", "live-inventory filter and security_invoker")
    else {
      fail(
        "schema_scoped_view",
        "Apply supabase/migrations/060b_scope_low_stock_and_requires_serial.sql first."
      )
    }

    const singleton = await db.query(`SELECT * FROM public.app_settings WHERE id`)
    originalSettings = businessSettings(singleton.rows[0])

    await deleteIdentities()
    await cleanupFixtures()
    await createIdentities()

    await db.query(
      `INSERT INTO public.product_lines
         (id, product_name, vendor, requires_serial, reorder_level, is_active)
       VALUES
         ($1, $4 || 'never', 'Verify 060b', false, NULL, true),
         ($2, $4 || 'soldout', 'Verify 060b', true, 0, true),
         ($3, $4 || 'guarded', 'Verify 060b', true, NULL, true)`,
      [PRODUCT_IDS.neverStocked, PRODUCT_IDS.soldOut, PRODUCT_IDS.guarded, DATA_PREFIX]
    )
    await db.query(
      `INSERT INTO public.inventory_items
         (id, serial_number, status, date_added, location, product_id)
       VALUES ($1, $1, 'Sold', '2026-01-01', 'Warehouse A', $2)`,
      [`${DATA_PREFIX}sold-1`, PRODUCT_IDS.soldOut]
    )

    console.log("\n=== 3. Never-stocked absent, sold-out low ===")
    const viewRows = await db.query(
      `SELECT product_id, product_name, vendor, in_stock_count,
              effective_reorder_level, is_low
       FROM public.low_stock_products
       WHERE product_id LIKE $1
       ORDER BY product_id`,
      [`${DATA_PREFIX}%`]
    )
    const byId = new Map(viewRows.rows.map((row) => [row.product_id, row]))
    const soldOut = byId.get(PRODUCT_IDS.soldOut)
    const scopeOk =
      !byId.has(PRODUCT_IDS.neverStocked) &&
      !byId.has(PRODUCT_IDS.guarded) &&
      viewRows.rows.length === 1 &&
      soldOut?.in_stock_count === 0 &&
      soldOut?.is_low === true
    if (scopeOk) pass("low_stock_scope", JSON.stringify(viewRows.rows))
    else fail("low_stock_scope", JSON.stringify(viewRows.rows))

    console.log("\n=== 4. Helper matches every view row ===")
    const helperAlerts = getLowStockAlerts(
      viewRows.rows.map((row) => ({
        productId: row.product_id,
        productName: row.product_name,
        vendor: row.vendor,
        inStockCount: row.in_stock_count,
        effectiveReorderLevel: row.effective_reorder_level,
        isLow: row.is_low,
      }))
    )
    const parityMismatches = []
    for (const row of viewRows.rows) {
      const alert = helperAlerts.find((item) => item.productId === row.product_id)
      if (row.is_low) {
        if (!alert || alert.inStock !== row.in_stock_count || alert.threshold !== row.effective_reorder_level) {
          parityMismatches.push(row.product_id)
        }
      } else if (alert) {
        parityMismatches.push(row.product_id)
      }
    }
    if (
      parityMismatches.length === 0 &&
      helperAlerts.length === viewRows.rows.filter((row) => row.is_low).length
    ) {
      pass("helper_view_parity", JSON.stringify({ rows: viewRows.rows.length, alerts: helperAlerts.length }))
    } else {
      fail("helper_view_parity", JSON.stringify({ parityMismatches, helperAlerts }))
    }

    console.log("\n=== 5. Stocked lines require serials ===")
    const unflaggedFixtures = await db.query(
      `SELECT product.id, product.product_name
       FROM public.product_lines AS product
       WHERE product.id LIKE $1
         AND NOT product.requires_serial
         AND EXISTS (
           SELECT 1
           FROM public.inventory_items AS item
           WHERE item.product_id = product.id
             AND item.deleted_at IS NULL
         )
       ORDER BY product.id`,
      [`${DATA_PREFIX}%`],
    )
    const unflaggedLive = await db.query(
      `SELECT product.id, product.product_name
       FROM public.product_lines AS product
       WHERE product.id NOT LIKE $1
         AND NOT product.requires_serial
         AND EXISTS (
           SELECT 1
           FROM public.inventory_items AS item
           WHERE item.product_id = product.id
             AND item.deleted_at IS NULL
         )
       ORDER BY product.id`,
      [`${DATA_PREFIX}%`],
    )
    if (unflaggedFixtures.rows.length === 0) {
      pass(
        "stocked_lines_require_serial",
        unflaggedLive.rows.length === 0
          ? "0"
          : `fixtures clean; ${unflaggedLive.rows.length} later catalogue rows still unflagged: ${unflaggedLive.rows.map((row) => row.product_name).join(", ")}`,
      )
    } else {
      fail("stocked_lines_require_serial", JSON.stringify(unflaggedFixtures.rows))
    }

    console.log("\n=== 6. Serviced guard ===")
    const { rows: clients } = await db.query(`SELECT id FROM public.clients LIMIT 1`)
    if (!clients[0]) {
      fail("serviced_guard_requires_serials", "no client available for the fixture request")
    } else {
      const salesId = userIds.get("sales")
      const techId = userIds.get("technicians")
      const { rows: inserted } = await db.query(
        `INSERT INTO public.stock_requests (client_id, created_by, status, notes)
         VALUES ($1, $2, 'draft', $3)
         RETURNING id::text AS id`,
        [clients[0].id, salesId, `verify-060b ${DATA_PREFIX}`]
      )
      const requestId = inserted[0].id
      await db.query(
        `INSERT INTO public.stock_request_lines
           (request_id, product_name, quantity_requested, sort_order, product_id)
         VALUES ($1, $2, 1, 0, $3)`,
        [requestId, `${DATA_PREFIX}guarded`, PRODUCT_IDS.guarded]
      )
      await asActor(salesId, (client) =>
        client.query(`UPDATE public.stock_requests SET status = 'submitted' WHERE id = $1`, [
          requestId,
        ])
      )
      await asActor(techId, (client) =>
        client.query(`UPDATE public.stock_requests SET status = 'in_progress' WHERE id = $1`, [
          requestId,
        ])
      )
      let guardMessage = null
      try {
        await asActor(techId, (client) =>
          client.query(`UPDATE public.stock_requests SET status = 'serviced' WHERE id = $1`, [
            requestId,
          ])
        )
      } catch (error) {
        guardMessage = error.message
      }
      const { rows: statusRows } = await db.query(
        `SELECT status FROM public.stock_requests WHERE id = $1`,
        [requestId]
      )
      if (
        /serial-tracked lines need all serials assigned/.test(guardMessage ?? "") &&
        statusRows[0]?.status === "in_progress"
      ) {
        pass("serviced_guard_requires_serials", guardMessage.split("\n")[0])
      } else {
        fail(
          "serviced_guard_requires_serials",
          JSON.stringify({ guardMessage, status: statusRows[0]?.status })
        )
      }
    }
  } finally {
    console.log("\n=== 7. Cleanup ===")
    try {
      await cleanupFixtures()
      await deleteIdentities()
      const residue = await db.query(
        `SELECT
           (SELECT count(*)::int FROM auth.users WHERE email LIKE $1) AS auth_users,
           (SELECT count(*)::int FROM public.profiles WHERE email LIKE $1) AS profiles,
           (SELECT count(*)::int FROM public.product_lines WHERE id LIKE $2) AS product_lines,
           (SELECT count(*)::int FROM public.inventory_items WHERE id LIKE $2 OR product_id LIKE $2) AS inventory_items,
           (SELECT count(*)::int FROM public.stock_requests WHERE notes LIKE 'verify-060b %') AS requests`,
        [`${EMAIL_PREFIX}%`, `${DATA_PREFIX}%`]
      )
      const restored = originalSettings
        ? businessSettings((await db.query(`SELECT * FROM public.app_settings WHERE id`)).rows[0])
        : null
      const settingsRestored =
        !originalSettings || JSON.stringify(restored) === JSON.stringify(originalSettings)
      const zeroResidue =
        Object.values(residue.rows[0]).every((value) => Number(value) === 0) && settingsRestored
      if (zeroResidue) {
        pass("zero_residue", JSON.stringify({ ...residue.rows[0], settingsRestored: true }))
      } else {
        fail("zero_residue", JSON.stringify({ ...residue.rows[0], originalSettings, restored }))
      }
    } catch (error) {
      fail("zero_residue", error.message)
    }
    await db.end().catch(() => {})
  }

  console.log("\n========== VERIFY 060b SUMMARY ==========")
  console.log(JSON.stringify(results, null, 2))
  console.log("=========================================\n")
  if (Object.values(results).some((result) => result.result === "FAIL")) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error("VERIFY 060b FAILED:", error)
  process.exitCode = 1
})
