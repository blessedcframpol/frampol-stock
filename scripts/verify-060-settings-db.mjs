/**
 * Verify 060_settings_db.sql. This script does not apply the migration.
 *
 * Creates only verify-060-* identities and __verify_060__ fixtures. All created
 * state is removed in finally, the original singleton settings row is restored,
 * and residue is asserted.
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SUPABASE_DB_URL (or DATABASE_URL)
 *
 * Usage: node scripts/verify-060-settings-db.mjs
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"
import { createClient } from "@supabase/supabase-js"
import { getLowStockAlerts } from "../lib/low-stock-helper.mjs"

const require = createRequire(import.meta.url)
const { prepareVerifyEnv } = require("./verify-env.cjs")
const EMAIL_PREFIX = "verify-060-"
const DATA_PREFIX = "__verify_060__"
const ROLES = ["admin", "sales", "accounts", "technicians", "viewer"]
const PRODUCT_IDS = {
  equal: `${DATA_PREFIX}equal`,
  above: `${DATA_PREFIX}above`,
  inherited: `${DATA_PREFIX}inherited`,
  inactive: `${DATA_PREFIX}inactive`,
  excludedStatuses: `${DATA_PREFIX}excluded`,
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

function sourceFiles(root) {
  const files = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if ([".git", ".next", "node_modules", "supabase"].includes(entry.name)) continue
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(fullPath))
    else if (/\.(?:ts|tsx|js|mjs)$/.test(entry.name)) files.push(fullPath)
  }
  return files
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
    const { rows } = await client.query(`SELECT auth.uid()::text AS uid`)
    assert(rows[0]?.uid === userId, `auth.uid() did not resolve for ${userId}`)
  }

  async function asUser(userId, fn, { rollback = false } = {}) {
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
      await client.query(rollback ? "ROLLBACK" : "COMMIT")
      return result
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {})
      throw error
    } finally {
      await client.end()
    }
  }

  async function expectError(client, savepoint, query, params = []) {
    await client.query(`SAVEPOINT ${savepoint}`)
    try {
      await client.query(query, params)
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
      return null
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
      return error.code ?? "error"
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

  async function createFixtures() {
    await db.query(
      `UPDATE public.app_settings
       SET default_reorder_level = 2,
           low_stock_emails_enabled = false,
           low_stock_recipients = '{}'::text[]`
    )
    await db.query(
      `INSERT INTO public.product_lines
         (id, product_name, vendor, requires_serial, reorder_level, is_active)
       VALUES
         ($1, $6 || 'equal', 'Verify 060', false, 2, true),
         ($2, $6 || 'above', 'Verify 060', false, 1, true),
         ($3, $6 || 'inherited', 'Verify 060', false, NULL, true),
         ($4, $6 || 'inactive', 'Verify 060', false, 0, false),
         ($5, $6 || 'excluded', 'Verify 060', false, 0, true)`,
      [
        PRODUCT_IDS.equal,
        PRODUCT_IDS.above,
        PRODUCT_IDS.inherited,
        PRODUCT_IDS.inactive,
        PRODUCT_IDS.excludedStatuses,
        DATA_PREFIX,
      ]
    )
    const inventoryRows = [
      ["equal-1", PRODUCT_IDS.equal, "In Stock", null],
      ["equal-2", PRODUCT_IDS.equal, "In Stock", null],
      ["above-1", PRODUCT_IDS.above, "In Stock", null],
      ["above-2", PRODUCT_IDS.above, "In Stock", null],
      ["inherited-1", PRODUCT_IDS.inherited, "In Stock", null],
      ["inherited-2", PRODUCT_IDS.inherited, "In Stock", null],
      ["inactive-1", PRODUCT_IDS.inactive, "In Stock", null],
      ["excluded-deleted", PRODUCT_IDS.excludedStatuses, "In Stock", new Date()],
      ["excluded-sold", PRODUCT_IDS.excludedStatuses, "Sold", null],
      ["excluded-maintenance", PRODUCT_IDS.excludedStatuses, "Maintenance", null],
    ]
    for (const [suffix, productId, status, deletedAt] of inventoryRows) {
      const id = `${DATA_PREFIX}${suffix}`
      await db.query(
        `INSERT INTO public.inventory_items
           (id, serial_number, status, date_added, location, product_id, deleted_at)
         VALUES ($1, $1, $2, '2026-01-01', 'Warehouse A', $3, $4)`,
        [id, status, productId, deletedAt]
      )
    }
  }

  async function cleanupFixtures() {
    await db.query(`DELETE FROM public.inventory_items WHERE id LIKE $1`, [
      `${DATA_PREFIX}%`,
    ])
    await db.query(`DELETE FROM public.product_lines WHERE id LIKE $1`, [
      `${DATA_PREFIX}%`,
    ])
  }

  try {
    console.log("\n=== 1. Schema and singleton ===")
    const schema = await db.query(
      `SELECT
         EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'product_lines'
             AND column_name = 'reorder_level'
         ) AS reorder_level,
         EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'product_lines'
             AND column_name = 'is_active'
         ) AS is_active,
         to_regclass('public.app_settings') IS NOT NULL AS app_settings,
         to_regclass('public.low_stock_products') IS NOT NULL AS low_stock_products,
         EXISTS (
           SELECT 1
           FROM pg_class relation
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
           WHERE namespace.nspname = 'public'
             AND relation.relname = 'low_stock_products'
             AND relation.reloptions @> ARRAY['security_invoker=true']
         ) AS security_invoker`
    )
    const singleton = await db.query(`SELECT * FROM public.app_settings`)
    originalSettings = businessSettings(singleton.rows[0])
    const schemaOk =
      Object.values(schema.rows[0]).every(Boolean) &&
      singleton.rows.length === 1 &&
      singleton.rows[0].id === true
    if (schemaOk) pass("schema_singleton_view", JSON.stringify(schema.rows[0]))
    else fail("schema_singleton_view", JSON.stringify({ schema: schema.rows[0], rows: singleton.rows.length }))

    console.log("\n=== Creating dedicated identities and fixtures ===")
    await deleteIdentities()
    await cleanupFixtures()
    await createIdentities()

    console.log("\n=== 2. app_settings role matrix ===")
    const settingsMatrix = {}
    for (const role of ROLES) {
      settingsMatrix[role] = await asUser(userIds.get(role), async (client) => {
        const selected = await client.query(
          `SELECT count(*)::int AS n FROM public.app_settings`
        )
        const updated = await client.query(
          `UPDATE public.app_settings
           SET timezone = timezone
           WHERE id
           RETURNING updated_by::text`
        )
        return {
          selected: selected.rows[0].n,
          updated: updated.rowCount,
          updatedBy: updated.rows[0]?.updated_by ?? null,
        }
      })
    }
    const adminId = userIds.get("admin")
    const roleMatrixOk = ROLES.every(
      (role) =>
        settingsMatrix[role].selected === 1 &&
        settingsMatrix[role].updated === (role === "admin" ? 1 : 0)
    ) && settingsMatrix.admin.updatedBy === adminId
    if (roleMatrixOk) pass("app_settings_role_matrix", JSON.stringify(settingsMatrix))
    else fail("app_settings_role_matrix", JSON.stringify(settingsMatrix))

    let singletonShapeError = null
    await db.query("BEGIN")
    try {
      await db.query(`INSERT INTO public.app_settings (id) VALUES (false)`)
    } catch (error) {
      singletonShapeError = error.code ?? "error"
    } finally {
      await db.query("ROLLBACK")
    }

    const settingsConstraints = await asUser(
      adminId,
      async (client) => ({
        clientInsert: await expectError(
          client,
          "second_row",
          `INSERT INTO public.app_settings (id) VALUES (false)`
        ),
        invalidRecipient: await expectError(
          client,
          "invalid_recipient",
          `UPDATE public.app_settings
           SET low_stock_recipients = ARRAY['not-an-email']
           WHERE id`
        ),
      }),
      { rollback: true }
    )
    if (
      singletonShapeError &&
      settingsConstraints.clientInsert &&
      settingsConstraints.invalidRecipient
    ) {
      pass(
        "app_settings_constraints",
        JSON.stringify({ singletonShapeError, ...settingsConstraints })
      )
    } else {
      fail(
        "app_settings_constraints",
        JSON.stringify({ singletonShapeError, ...settingsConstraints })
      )
    }

    console.log("\n=== 3. product_lines update permissions ===")
    await createFixtures()
    const productUpdates = {}
    for (const role of ROLES) {
      productUpdates[role] = await asUser(
        userIds.get(role),
        async (client) => {
          const result = await client.query(
            `UPDATE public.product_lines
             SET reorder_level = reorder_level, is_active = is_active
             WHERE id = $1`,
            [PRODUCT_IDS.equal]
          )
          return result.rowCount
        },
        { rollback: true }
      )
    }
    const productPermissionsOk = ROLES.every(
      (role) => productUpdates[role] === (role === "admin" ? 1 : 0)
    )
    if (productPermissionsOk) {
      pass("product_settings_update_permissions", JSON.stringify(productUpdates))
    } else {
      fail("product_settings_update_permissions", JSON.stringify(productUpdates))
    }

    console.log("\n=== 4. View correctness ===")
    const viewRows = await db.query(
      `SELECT product_id, product_name, vendor, in_stock_count,
              effective_reorder_level, is_low
       FROM public.low_stock_products
       WHERE product_id LIKE $1
       ORDER BY product_id`,
      [`${DATA_PREFIX}%`]
    )
    const byId = new Map(viewRows.rows.map((row) => [row.product_id, row]))
    const viewOk =
      viewRows.rows.length === 4 &&
      byId.get(PRODUCT_IDS.equal)?.in_stock_count === 2 &&
      byId.get(PRODUCT_IDS.equal)?.effective_reorder_level === 2 &&
      byId.get(PRODUCT_IDS.equal)?.is_low === true &&
      byId.get(PRODUCT_IDS.above)?.in_stock_count === 2 &&
      byId.get(PRODUCT_IDS.above)?.effective_reorder_level === 1 &&
      byId.get(PRODUCT_IDS.above)?.is_low === false &&
      byId.get(PRODUCT_IDS.inherited)?.effective_reorder_level === 2 &&
      byId.get(PRODUCT_IDS.inherited)?.is_low === true &&
      !byId.has(PRODUCT_IDS.inactive) &&
      byId.get(PRODUCT_IDS.excludedStatuses)?.in_stock_count === 0 &&
      byId.get(PRODUCT_IDS.excludedStatuses)?.is_low === true
    if (viewOk) pass("low_stock_view_correctness", JSON.stringify(viewRows.rows))
    else fail("low_stock_view_correctness", JSON.stringify(viewRows.rows))

    console.log("\n=== 5. View RLS parity ===")
    const parity = {}
    for (const role of ["admin", "sales", "viewer"]) {
      parity[role] = await asUser(userIds.get(role), async (client) => {
        const { rows } = await client.query(
          `SELECT product_id, in_stock_count, effective_reorder_level, is_low
           FROM public.low_stock_products
           WHERE product_id LIKE $1
           ORDER BY product_id`,
          [`${DATA_PREFIX}%`]
        )
        return rows
      })
    }
    const parityOk =
      JSON.stringify(parity.admin) === JSON.stringify(parity.sales) &&
      JSON.stringify(parity.admin) === JSON.stringify(parity.viewer)
    if (parityOk) pass("low_stock_view_rls_parity", JSON.stringify(parity.admin))
    else fail("low_stock_view_rls_parity", JSON.stringify(parity))

    console.log("\n=== 6. App helper consistency ===")
    const appRows = viewRows.rows.map((row) => ({
      productId: row.product_id,
      productName: row.product_name,
      vendor: row.vendor,
      inStockCount: row.in_stock_count,
      effectiveReorderLevel: row.effective_reorder_level,
      isLow: row.is_low,
    }))
    const helperAlerts = getLowStockAlerts(appRows)
    const databaseLowCount = viewRows.rows.filter((row) => row.is_low).length
    const dashboardSource = fs.readFileSync(
      path.join(process.cwd(), "components", "dashboard-content.tsx"),
      "utf8"
    )
    const alertsSource = fs.readFileSync(
      path.join(process.cwd(), "components", "alerts-content.tsx"),
      "utf8"
    )
    const helperOk =
      helperAlerts.length === databaseLowCount &&
      dashboardSource.includes("useLowStockProducts") &&
      alertsSource.includes("useLowStockProducts")
    if (helperOk) {
      pass(
        "app_low_stock_consistency",
        JSON.stringify({ databaseLowCount, helperLowCount: helperAlerts.length })
      )
    } else {
      fail(
        "app_low_stock_consistency",
        JSON.stringify({ databaseLowCount, helperLowCount: helperAlerts.length })
      )
    }

    console.log("\n=== 7. No localStorage settings paths ===")
    const oldSymbols = [
      "fram-stock-settings-low-stock-emails-enabled",
      "fram-stock-settings-low-stock-email-recipients",
      "fram-stock-settings-reorder-level-default",
      "fram-stock-settings-reorder-level-overrides",
      "getReorderLevelForProduct",
      "getReorderLevelOverrides",
      "subscribeClientSettings",
      "getClientSettingsSnapshot",
    ]
    const violations = []
    for (const file of sourceFiles(process.cwd())) {
      if (file.endsWith("verify-060-settings-db.mjs")) continue
      const source = fs.readFileSync(file, "utf8")
      for (const symbol of oldSymbols) {
        if (source.includes(symbol)) {
          violations.push(`${path.relative(process.cwd(), file)}:${symbol}`)
        }
      }
    }
    const settingsSource = fs.readFileSync(
      path.join(process.cwd(), "lib", "settings.ts"),
      "utf8"
    )
    if (violations.length === 0 && !settingsSource.includes("localStorage")) {
      pass("no_local_settings_storage", "no old keys, hydration helpers, or localStorage")
    } else {
      fail("no_local_settings_storage", JSON.stringify(violations))
    }
  } finally {
    console.log("\n=== 8. Cleanup and residue ===")
    try {
      await cleanupFixtures()
      if (originalSettings) {
        await db.query("SET session_replication_role = replica")
        try {
          await db.query(
            `UPDATE public.app_settings
             SET default_reorder_level = $1,
                 low_stock_emails_enabled = $2,
                 low_stock_recipients = $3,
                 timezone = $4,
                 updated_at = $5,
                 updated_by = $6
             WHERE id`,
            [
              originalSettings.default_reorder_level,
              originalSettings.low_stock_emails_enabled,
              originalSettings.low_stock_recipients,
              originalSettings.timezone,
              originalSettings.updated_at,
              originalSettings.updated_by,
            ]
          )
        } finally {
          await db.query("SET session_replication_role = origin")
        }
      }
      await deleteIdentities()

      const residue = await db.query(
        `SELECT
           (SELECT count(*)::int FROM auth.users WHERE email LIKE $1) AS auth_users,
           (SELECT count(*)::int FROM public.profiles WHERE email LIKE $1) AS profiles,
           (SELECT count(*)::int FROM public.product_lines WHERE id LIKE $2) AS product_lines,
           (SELECT count(*)::int FROM public.inventory_items WHERE id LIKE $2) AS inventory_items`,
        [`${EMAIL_PREFIX}%`, `${DATA_PREFIX}%`]
      )
      const restored = originalSettings
        ? businessSettings((await db.query(`SELECT * FROM public.app_settings WHERE id`)).rows[0])
        : null
      const zeroResidue =
        Object.values(residue.rows[0]).every((value) => Number(value) === 0) &&
        (!originalSettings || JSON.stringify(restored) === JSON.stringify(originalSettings))
      if (zeroResidue) {
        pass("zero_residue", JSON.stringify({ ...residue.rows[0], settingsRestored: true }))
      } else {
        fail(
          "zero_residue",
          JSON.stringify({ ...residue.rows[0], originalSettings, restored })
        )
      }
    } catch (error) {
      fail("zero_residue", error.message)
    }
    await db.end().catch(() => {})
  }

  console.log("\n========== VERIFY 060 SUMMARY ==========")
  console.log(JSON.stringify(results, null, 2))
  console.log("========================================\n")
  if (Object.values(results).some((result) => result.result === "FAIL")) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error("VERIFY 060 FAILED:", error)
  process.exitCode = 1
})
