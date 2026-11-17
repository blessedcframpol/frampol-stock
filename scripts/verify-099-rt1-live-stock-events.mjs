/**
 * RT1 — live_stock_events: one statement-level event per batch, RLS read, prune window.
 *
 *   node scripts/verify-099-rt1-live-stock-events.mjs
 */
import { runVerifyCli } from "./verify-harness.mjs"

const PREFIX = "H3099"
const NOTES = "harness-099"

export const MARKERS = [
  {
    label: "live_stock_events",
    sql: `SELECT count(*)::int AS n FROM public.live_stock_events WHERE batch_id LIKE $1`,
    params: [`${PREFIX}%`],
  },
  {
    label: "transactions",
    sql: `SELECT count(*)::int AS n FROM public.transactions WHERE notes LIKE $1`,
    params: [`${NOTES}%`],
  },
]

function stamp() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

export async function runChecks(ctx) {
  const { db, pass, fail, asUser } = ctx
  await db.query(`SET LOCAL statement_timeout = '120s'`)

  const table = await db.query(
    `SELECT to_regclass('public.live_stock_events') IS NOT NULL AS ok`,
  )
  if (!table.rows[0]?.ok) {
    fail("table_exists", "live_stock_events missing — apply RT1 migration")
    return
  }
  pass("table_exists")

  const pub = await db.query(
    `SELECT 1 AS ok
     FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'live_stock_events'`,
  )
  if (pub.rows.length < 1) {
    fail("realtime_publication", "live_stock_events not in supabase_realtime")
  } else {
    pass("realtime_publication")
  }

  const trig = await db.query(
    `SELECT 1 AS ok
     FROM pg_trigger
     WHERE tgname = 'transactions_live_stock_events_stmt'
       AND NOT tgisinternal`,
  )
  if (trig.rows.length < 1) {
    fail("statement_trigger", "transactions_live_stock_events_stmt missing")
  } else {
    pass("statement_trigger")
  }

  const adminId = await ctx.createFixtureUser("admin", `harness-099-admin@test.local`)
  const salesId = await ctx.createFixtureUser("sales", `harness-099-sales@test.local`)

  const rls = await asUser(salesId, async () => {
    const res = await db.query(`SELECT count(*)::int AS n FROM public.live_stock_events`)
    return res.rows[0]?.n ?? null
  })
  if (typeof rls !== "number") {
    fail("rls_select_authenticated", "authenticated SELECT denied")
  } else {
    pass("rls_select_authenticated")
  }

  const products = await db.query(
    `SELECT id FROM public.product_lines
     WHERE is_active IS TRUE AND lower(coalesce(vendor, '')) <> 'fortinet'
     ORDER BY product_name LIMIT 1`,
  )
  if (products.rows.length < 1) throw new Error("need one non-Fortinet product")
  const productId = products.rows[0].id

  const batchId = `${PREFIX}-batch-${stamp()}`
  const serials = Array.from({ length: 50 }, (_, i) => `${PREFIX}-S${String(i).padStart(2, "0")}-${stamp()}`)
  for (const serial of serials) {
    await db.query(
      `INSERT INTO public.inventory_items (
         id, product_id, serial_number, status, stock_pool, location, date_added
       ) VALUES (
         gen_random_uuid(), $1, $2, 'In Stock', 'sale', 'Warehouse A', current_date::text
       )`,
      [productId, serial],
    )
  }

  await db.query(`DELETE FROM public.live_stock_events WHERE batch_id = $1`, [batchId])

  const bizDate = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`
  const values = serials
    .map(
      (_, i) =>
        `(gen_random_uuid(), 'Inbound', $${i + 4}, 'Harness Product', 'Internal', $3, $1, $2)`,
    )
    .join(",\n")
  await db.query(
    `INSERT INTO public.transactions (
       id, type, serial_number, item_name, client, date, batch_id, notes
     ) VALUES ${values}`,
    [batchId, `${NOTES} inbound-50`, bizDate, ...serials],
  )

  const events = await db.query(
    `SELECT count(*)::int AS n, min(movement_type) AS movement_type
     FROM public.live_stock_events
     WHERE batch_id = $1`,
    [batchId],
  )
  const eventCount = events.rows[0]?.n ?? 0
  if (eventCount !== 1) {
    fail("one_event_per_batch", `expected 1 event for 50-serial insert, got ${eventCount}`)
  } else {
    pass("one_event_per_batch")
  }
  if (events.rows[0]?.movement_type !== "Inbound") {
    fail("movement_type", `expected Inbound, got ${events.rows[0]?.movement_type}`)
  } else {
    pass("movement_type")
  }

  // Second batch of 1 → another single event (still 1:1 with batches).
  const batch2 = `${PREFIX}-batch2-${stamp()}`
  const serial2 = `${PREFIX}-solo-${stamp()}`
  await db.query(
    `INSERT INTO public.inventory_items (
       id, product_id, serial_number, status, stock_pool, location, date_added
     ) VALUES (
       gen_random_uuid(), $1, $2, 'In Stock', 'sale', 'Warehouse A', current_date::text
     )`,
    [productId, serial2],
  )
  await db.query(
    `INSERT INTO public.transactions (
       id, type, serial_number, item_name, client, date, batch_id, notes
     ) VALUES (
       gen_random_uuid(), 'Sale', $1, 'Harness Product', 'Client', $4, $2, $3
     )`,
    [serial2, batch2, `${NOTES} sale-1`, bizDate],
  )
  const one = await db.query(
    `SELECT count(*)::int AS n FROM public.live_stock_events WHERE batch_id = $1`,
    [batch2],
  )
  if (one.rows[0]?.n !== 1) {
    fail("one_event_single", `expected 1, got ${one.rows[0]?.n}`)
  } else {
    pass("one_event_single")
  }

  // Prune older than 1 day.
  await db.query(
    `INSERT INTO public.live_stock_events (batch_id, movement_type, created_at)
     VALUES ($1, 'Sale', now() - interval '2 days')`,
    [`${PREFIX}-old-${stamp()}`],
  )
  await db.query(
    `INSERT INTO public.transactions (
       id, type, serial_number, item_name, client, date, batch_id, notes
     ) VALUES (
       gen_random_uuid(), 'Inbound', $1, 'Harness Product', 'Internal', $4, $2, $3
     )`,
    [`${PREFIX}-prune-${stamp()}`, `${PREFIX}-prune-batch-${stamp()}`, `${NOTES} prune-kick`, bizDate],
  )
  // Ensure prune ran (old row gone). The trigger deletes created_at < now()-1 day.
  const oldLeft = await db.query(
    `SELECT count(*)::int AS n FROM public.live_stock_events
     WHERE batch_id LIKE $1 AND created_at < now() - interval '1 day'`,
    [`${PREFIX}-old-%`],
  )
  if ((oldLeft.rows[0]?.n ?? 0) > 0) {
    fail("prune_1_day", "old live_stock_events rows not pruned")
  } else {
    pass("prune_1_day")
  }

  void adminId
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-099-rt1-live-stock-events.mjs")
if (isMain) {
  runVerifyCli({ markers: MARKERS, timeoutMs: 180_000, label: "099-rt1" }, runChecks)
}
