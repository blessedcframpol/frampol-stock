/**
 * RH1 — stock_availability: every role can call; returns counts only (no serials).
 *
 *   node scripts/rehearse-migration.mjs supabase/migrations/20261012123409_rh1_stock_availability.sql scripts/verify-087-rh1-stock-availability.mjs
 *   node scripts/verify-087-rh1-stock-availability.mjs
 */
import { runVerifyCli } from "./verify-harness.mjs"

const PREFIX = "H3087"

export const MARKERS = [
  {
    label: "users",
    sql: `SELECT count(*)::int AS n FROM auth.users WHERE email LIKE 'harness-087-%@test.local'`,
  },
  {
    label: "items",
    sql: `SELECT count(*)::int AS n FROM public.inventory_items WHERE serial_number LIKE $1`,
    params: [`${PREFIX}%`],
  },
  {
    label: "products",
    sql: `SELECT count(*)::int AS n FROM public.product_lines WHERE id = $1 OR product_name LIKE $2`,
    params: [`PL-${PREFIX.toLowerCase()}-avail`, `${PREFIX}%`],
  },
]

export async function runChecks(ctx) {
  const db = ctx.db
  const pass = ctx.pass
  const fail = ctx.fail
  const asUser = ctx.asUser

  // Dedicated product so live inventory does not inflate available_count.
  const productId = `PL-${PREFIX.toLowerCase()}-avail`
  await db.query(
    `INSERT INTO public.product_lines (id, product_name, vendor, is_active)
     VALUES ($1, $2, 'General', true)
     ON CONFLICT (id) DO UPDATE SET is_active = true`,
    [productId, `${PREFIX} Availability Kit`],
  )

  // Seed two sale In Stock kits + one rental + one Pending Inspection (must not count).
  for (const [serial, status, pool] of [
    [`${PREFIX}-S1`, "In Stock", "sale"],
    [`${PREFIX}-S2`, "In Stock", "sale"],
    [`${PREFIX}-R1`, "In Stock", "rental"],
    [`${PREFIX}-P1`, "Pending Inspection", "sale"],
  ]) {
    await db.query(
      `INSERT INTO public.inventory_items (
         id, product_id, serial_number, status, stock_pool, location, date_added
       ) VALUES (
         gen_random_uuid(), $1, $2, $3, $4, 'Warehouse A', current_date::text
       )`,
      [productId, serial, status, pool]
    )
  }

  const roles = ["admin", "sales", "accounts", "technicians", "viewer"]
  for (const role of roles) {
    const uid = await ctx.createFixtureUser(role, `harness-087-${role}@test.local`)
    const rows = await asUser(uid, async () => {
      const res = await db.query(
        `SELECT * FROM public.stock_availability(NULL) WHERE product_id = $1`,
        [productId]
      )
      return res.rows
    })
    const row = rows[0]
    const cols = row ? Object.keys(row).sort() : []
    const expectedCols = [
      "available_count",
      "is_low",
      "product_id",
      "product_name",
      "reorder_level",
      "vendor",
    ]
    const noSerials =
      cols.join(",") === expectedCols.join(",") &&
      !cols.some((c) => /serial|location|client|price|history/i.test(c))
    if (row && Number(row.available_count) === 2 && noSerials) {
      pass(`avail_${role}`, `count=${row.available_count}`)
    } else {
      fail(`avail_${role}`, JSON.stringify({ row, cols }))
    }
  }

  // Requester cannot pull serials through this function (column set only).
  {
    const salesId = await ctx.createFixtureUser("sales", "harness-087-sales-b@test.local")
    const leaked = await asUser(salesId, async () => {
      const res = await db.query(`SELECT * FROM public.stock_availability($1)`, [PREFIX])
      const keys = res.rows[0] ? Object.keys(res.rows[0]) : []
      return keys.some((k) => /serial|location|client|price/i.test(k))
    })
    if (!leaked) pass("no_serial_columns", "counts only")
    else fail("no_serial_columns", "leaked sensitive columns")
  }

  // Anonymous / no JWT refused
  {
    await db.query(`SELECT set_config('request.jwt.claim.sub', '', true)`)
    await db.query(`SELECT set_config('request.jwt.claims', '', true)`)
    const err = await ctx.raises(
      `SELECT * FROM public.stock_availability(NULL) LIMIT 1`,
      [],
      "signed-in staff only"
    )
    if (!err) pass("anon_refused", "refused")
    else fail("anon_refused", err)
  }
}

const isMain = process.argv[1] && process.argv[1].includes("verify-087-rh1-stock-availability")
if (isMain) {
  runVerifyCli({ markers: MARKERS, timeoutMs: 300_000, label: "087-rh1" }, runChecks)
}
