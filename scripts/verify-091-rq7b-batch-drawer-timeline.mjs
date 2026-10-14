/**
 * RQ7b — batch_movement_history RPC for shared movement batch drawer.
 *
 *   node scripts/rehearse-migration.mjs supabase/migrations/20261013081238_rq7b_batch_drawer_timeline.sql scripts/verify-091-rq7b-batch-drawer-timeline.mjs
 *   node scripts/verify-091-rq7b-batch-drawer-timeline.mjs
 */
import { withHarness } from "./verify-harness.mjs"

const PREFIX = "H3091"
const NOTES = "harness-091"

export const MARKERS = [
  {
    label: "transactions",
    sql: `SELECT count(*)::int AS n FROM public.transactions WHERE batch_id LIKE $1 OR id LIKE $1`,
    params: [`%${PREFIX}%`],
  },
  {
    label: "items",
    sql: `SELECT count(*)::int AS n FROM public.inventory_items WHERE serial_number LIKE $1`,
    params: [`${PREFIX}%`],
  },
  {
    label: "users",
    sql: `SELECT count(*)::int AS n FROM auth.users WHERE email LIKE $1`,
    params: [`harness-091-%`],
  },
]

function stamp() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

export async function runChecks(ctx) {
  const { db, pass, fail } = ctx
  await db.query(`SET LOCAL statement_timeout = '120s'`)

  const fn = await db.query(
    `SELECT 1 FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'batch_movement_history'`,
  )
  if (fn.rows.length === 1) pass("fn_exists", "batch_movement_history")
  else fail("fn_exists", "missing")

  const batchId = `BATCH-${PREFIX}-${stamp()}`
  const serial = `${PREFIX}-${stamp()}`
  const adminId = await ctx.createFixtureUser("admin", `harness-091-admin@test.local`)

  const product = await db.query(
    `SELECT id FROM public.product_lines WHERE is_active IS TRUE ORDER BY product_name LIMIT 1`,
  )
  const productId = product.rows[0].id

  await db.query(
    `INSERT INTO public.inventory_items (
       id, product_id, serial_number, status, stock_pool, location, date_added
     ) VALUES (
       gen_random_uuid(), $1, $2, 'In Stock', 'sale', 'Warehouse A', current_date::text
     )`,
    [productId, serial],
  )

  const txnId = `TXN-${PREFIX}-${stamp()}`
  await db.query(
    `INSERT INTO public.transactions (
       id, batch_id, serial_number, type, date, client, item_name, created_by
     ) VALUES ($1, $2, $3, 'Inbound', '2026-10-13T00:00:00.000Z', 'Harness', 'Product', $4)`,
    [txnId, batchId, serial, adminId],
  )

  const { rows } = await db.query(`SELECT public.batch_movement_history($1) AS timeline`, [batchId])
  const timeline = rows[0]?.timeline
  if (!Array.isArray(timeline)) fail("timeline_shape", "not array")
  else pass("timeline_shape", `${timeline.length} rows`)

  const titles = timeline.map((row) => row?.title).filter(Boolean)
  if (titles.some((t) => t === "Issued")) pass("issued_event", "present")
  else fail("issued_event", titles.join(", ") || "empty")
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-091-rq7b-batch-drawer-timeline.mjs")
if (isMain) {
  await withHarness({ markers: MARKERS, timeoutMs: 300_000, label: "091-rq7b" }, runChecks)
}
