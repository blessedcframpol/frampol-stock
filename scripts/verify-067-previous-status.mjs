/**
 * Verify previous_status recording, the skipped-insert guard, and the backfill.
 * Does not apply migrations.
 *
 * Requires in .env.local:
 *   SUPABASE_DB_URL (or DATABASE_URL)
 *
 * Usage: node scripts/verify-067-previous-status.mjs
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"

const require = createRequire(import.meta.url)
const { prepareVerifyEnv } = require("./verify-env.cjs")
const PREFIX = "verify-067-"

function pass(results, name, reason) {
  results[name] = { result: "PASS", reason }
  console.log(`PASS  ${name} — ${reason}`)
}

function fail(results, name, reason) {
  results[name] = { result: "FAIL", reason }
  console.log(`FAIL  ${name} — ${reason}`)
}

async function expectError(fn) {
  try {
    await fn()
    return null
  } catch (error) {
    return error
  }
}

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === ".next") continue
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(full, acc)
    else acc.push(full)
  }
  return acc
}

/** App updates of inventory_items that still send status. */
function appStatusUpdates() {
  const hits = []
  for (const file of walk("app").concat(walk("components"), walk("lib"))) {
    if (!/\.(ts|tsx)$/.test(file)) continue
    const text = fs.readFileSync(file, "utf8")
    const re = /\.from\(\s*["']inventory_items["']\s*\)[\s\S]{0,400}?\.update\(([\s\S]{0,240}?)\)/g
    let match
    while ((match = re.exec(text))) {
      if (/\bstatus\b/.test(match[1]) || /inventoryItemToRow\(/.test(match[1])) {
        hits.push(`${file.replaceAll("\\", "/")}: ${match[0].replace(/\s+/g, " ").slice(0, 160)}`)
      }
    }
  }
  return hits
}

prepareVerifyEnv()
const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
if (!dbUrl) throw new Error("Missing SUPABASE_DB_URL or DATABASE_URL")

const pg = require("pg")
const db = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
await db.connect()
const results = {}

async function cleanup() {
  await db.query(`DELETE FROM public.transactions WHERE id LIKE $1 OR serial_number LIKE $1 OR batch_id LIKE $1`, [
    `${PREFIX}%`,
  ])
  await db.query(`DELETE FROM public.inventory_items WHERE id LIKE $1 OR serial_number LIKE $1`, [`${PREFIX}%`])
}

try {
  const ready = await db.query(
    `SELECT
       to_regprocedure('public.ledger_next_status(text,text,jsonb)') IS NOT NULL AS replay,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'transactions' AND column_name = 'previous_status'
       ) AS column_ready`
  )
  if (!ready.rows[0]?.replay || !ready.rows[0]?.column_ready) {
    throw new Error("Apply the previous_status migration before running this script.")
  }

  await cleanup()
  const product = await db.query(`SELECT id FROM public.product_lines ORDER BY id LIMIT 1`)
  const productId = product.rows[0]?.id
  if (!productId) throw new Error("No product line to attach the fixture")

  const serial = `${PREFIX}serial`
  const created = await expectError(() =>
    db.query(`SELECT public.apply_stock_movement($1::jsonb, $2::jsonb, $3::jsonb, NULL, NULL, NULL)`, [
      "[]",
      JSON.stringify([
        {
          id: `${PREFIX}item`,
          product_id: productId,
          serial_number: serial,
          status: "In Stock",
          date_added: "2026-10-01",
          location: "Warehouse A",
          previous_status: "Disposed",
        },
      ]),
      JSON.stringify([
        {
          id: `${PREFIX}inbound`,
          type: "Inbound",
          serial_number: serial,
          item_name: "Verify kit",
          client: "Internal",
          date: "2026-10-01T00:00:00.000Z",
          batch_id: `${PREFIX}batch-in`,
          previous_status: "Disposed",
          previous_status_source: "derived",
        },
      ]),
    ])
  )
  const inbound = await db.query(
    `SELECT type, previous_status, previous_status_source FROM public.transactions WHERE id = $1`,
    [`${PREFIX}inbound`]
  )
  const item = await db.query(`SELECT status FROM public.inventory_items WHERE id = $1`, [`${PREFIX}item`])
  if (
    !created &&
    inbound.rows[0]?.type === "Inbound" &&
    inbound.rows[0]?.previous_status == null &&
    inbound.rows[0]?.previous_status_source === "recorded" &&
    item.rows[0]?.status === "In Stock"
  ) {
    pass(results, "create_records_null", "Add inventory writes an Inbound with previous_status null, source recorded")
  } else {
    fail(results, "create_records_null", created?.message ?? JSON.stringify({ inbound: inbound.rows[0], item: item.rows[0] }))
  }

  const beforeReject = await db.query(`SELECT count(*)::int AS n FROM public.transactions WHERE serial_number = $1`, [serial])
  const rejected = await expectError(() =>
    db.query(`SELECT public.apply_stock_movement($1::jsonb, $2::jsonb, $3::jsonb, NULL, NULL, NULL)`, [
      "[]",
      JSON.stringify([
        {
          id: `${PREFIX}item-again`,
          product_id: productId,
          serial_number: serial,
          status: "In Stock",
          date_added: "2026-10-01",
          location: "Warehouse A",
        },
      ]),
      JSON.stringify([
        {
          id: `${PREFIX}inbound-again`,
          type: "Inbound",
          serial_number: serial,
          item_name: "Verify kit",
          client: "Internal",
          date: "2026-10-01T00:00:00.000Z",
          batch_id: `${PREFIX}batch-again`,
        },
      ]),
    ])
  )
  const afterReject = await db.query(`SELECT count(*)::int AS n FROM public.transactions WHERE serial_number = $1`, [serial])
  if (
    rejected &&
    /missing the inventory update|already in stock|Invalid movement/i.test(rejected.message) &&
    beforeReject.rows[0].n === 1 &&
    afterReject.rows[0].n === 1
  ) {
    pass(results, "existing_inbound_rejected", "Inbound of an existing In Stock serial is rejected and writes no transaction")
  } else {
    fail(results, "existing_inbound_rejected", rejected?.message ?? "the second inbound was stored")
  }

  const skipped = await expectError(() =>
    db.query(`SELECT public.apply_stock_movement($1::jsonb, $2::jsonb, $3::jsonb, NULL, NULL, NULL)`, [
      "[]",
      JSON.stringify([
        {
          id: `${PREFIX}skip-a`,
          product_id: productId,
          serial_number: `${PREFIX}skip`,
          status: "In Stock",
          date_added: "2026-10-01",
          location: "Warehouse A",
        },
        {
          id: `${PREFIX}skip-b`,
          product_id: productId,
          serial_number: `${PREFIX}skip`,
          status: "In Stock",
          date_added: "2026-10-01",
          location: "Warehouse A",
        },
      ]),
      JSON.stringify([
        {
          id: `${PREFIX}skip-txn-a`,
          type: "Inbound",
          serial_number: `${PREFIX}skip`,
          item_name: "Verify kit",
          client: "Internal",
          date: "2026-10-01T00:00:00.000Z",
          batch_id: `${PREFIX}batch-skip`,
        },
        {
          id: `${PREFIX}skip-txn-b`,
          type: "Inbound",
          serial_number: `${PREFIX}skip`,
          item_name: "Verify kit",
          client: "Internal",
          date: "2026-10-01T00:00:00.000Z",
          batch_id: `${PREFIX}batch-skip`,
        },
      ]),
    ])
  )
  const skipLeft = await db.query(
    `SELECT
       (SELECT count(*)::int FROM public.transactions WHERE serial_number = $1) AS txns,
       (SELECT count(*)::int FROM public.inventory_items WHERE serial_number = $1) AS items`,
    [`${PREFIX}skip`]
  )
  if (skipped && /insert skipped/i.test(skipped.message) && skipLeft.rows[0].txns === 0 && skipLeft.rows[0].items === 0) {
    pass(results, "skipped_insert", "a skipped insert rolls back and writes no transaction")
  } else {
    fail(results, "skipped_insert", skipped?.message ?? JSON.stringify(skipLeft.rows[0]))
  }

  const sale = await expectError(() =>
    db.query(`SELECT public.apply_stock_movement($1::jsonb, $2::jsonb, $3::jsonb, NULL, NULL, NULL)`, [
      JSON.stringify([
        {
          id: `${PREFIX}item`,
          product_id: productId,
          serial_number: serial,
          status: "Sold",
          date_added: "2026-10-01",
          location: "Delivered",
          client: "Internal",
        },
      ]),
      "[]",
      JSON.stringify([
        {
          id: `${PREFIX}sale`,
          type: "Sale",
          serial_number: serial,
          item_name: "Verify kit",
          client: "Internal",
          date: "2026-10-01T00:00:00.000Z",
          batch_id: `${PREFIX}batch-sale`,
          previous_status: "Disposed",
          previous_status_source: "unknown",
        },
      ]),
    ])
  )
  const saleRow = await db.query(
    `SELECT previous_status, previous_status_source FROM public.transactions WHERE id = $1`,
    [`${PREFIX}sale`]
  )
  if (
    !sale &&
    saleRow.rows[0]?.previous_status === "In Stock" &&
    saleRow.rows[0]?.previous_status_source === "recorded"
  ) {
    pass(results, "recorded_locked_status", "the sale records the locked In Stock status, not the Disposed value the client sent")
  } else {
    fail(results, "recorded_locked_status", sale?.message ?? JSON.stringify(saleRow.rows[0]))
  }

  const replay = await db.query(`
    WITH ordered AS (
      SELECT serial_number, type, metadata, previous_status,
        row_number() OVER (
          PARTITION BY serial_number
          ORDER BY coalesce(
            created_at,
            CASE
              WHEN id ~ '^TXN-[0-9]{10}'
                THEN to_timestamp((substring(id from '^TXN-([0-9]{10,})'))::bigint / 1000.0)
              ELSE NULL
            END,
            date::timestamptz
          ),
          id
        ) AS n,
        count(*) OVER (PARTITION BY serial_number) AS nmax
    FROM public.transactions
    WHERE type <> 'Reversal'
      AND NOT public.batch_is_currently_reversed(batch_id)
      AND id NOT LIKE '${PREFIX}%'
    ),
    stepped AS (
      SELECT serial_number, n, nmax,
        public.ledger_next_status(previous_status, type, metadata) AS next_status,
        lead(previous_status) OVER (PARTITION BY serial_number ORDER BY n) AS next_prev
      FROM ordered
    )
    SELECT count(*)::int AS mismatches
    FROM stepped s
    JOIN public.inventory_items i ON i.serial_number = s.serial_number AND i.deleted_at IS NULL
    WHERE i.id NOT LIKE '${PREFIX}%'
      AND (
        (s.n < s.nmax AND s.next_status IS DISTINCT FROM s.next_prev)
        OR (s.n = s.nmax AND s.next_status IS DISTINCT FROM i.status)
      )
  `)
  if (replay.rows[0].mismatches === 0) {
    pass(results, "backfill_replay", "every live serial with a movement replays to its current status")
  } else {
    fail(results, "backfill_replay", `${replay.rows[0].mismatches} live serials do not replay to their current status`)
  }

  const counts = await db.query(
    `SELECT previous_status_source, count(*)::int AS n
     FROM public.transactions
     WHERE id NOT LIKE $1
     GROUP BY 1
     ORDER BY 1`,
    [`${PREFIX}%`]
  )
  const bySource = Object.fromEntries(counts.rows.map((row) => [row.previous_status_source, row.n]))
  const late = await db.query(
    `SELECT txn.id, txn.previous_status_source
     FROM public.transactions AS txn
     WHERE txn.id NOT LIKE $1
       AND txn.created_at > (
         SELECT to_timestamp(version, 'YYYYMMDDHH24MISS')
         FROM supabase_migrations.schema_migrations
         WHERE name = 'apply_stock_movement_previous_status'
       )
       AND txn.previous_status_source IS DISTINCT FROM 'recorded'
     ORDER BY txn.created_at, txn.id
     LIMIT 5`,
    [`${PREFIX}%`]
  )
  if (bySource.derived === 2864 && bySource.unknown === 173 && late.rows.length === 0) {
    pass(
      results,
      "source_counts",
      `derived 2864, unknown 173, ${bySource.recorded ?? 0} recorded after I2a`
    )
  } else {
    fail(results, "source_counts", JSON.stringify({ bySource, late: late.rows }))
  }

  const hits = appStatusUpdates()
  if (hits.length === 0) {
    pass(
      results,
      "status_write_paths",
      "no app update of inventory_items sends status. Status is written by apply_stock_movement and reverse_quick_scan_batch. scripts/migrate-quick-scans.ts still inserts a status on a one-off import."
    )
  } else {
    fail(results, "status_write_paths", hits.join(" | "))
  }
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await cleanup()
  const residue = await db.query(
    `SELECT
       (SELECT count(*)::int FROM public.transactions WHERE id LIKE $1 OR serial_number LIKE $1 OR batch_id LIKE $1) AS txns,
       (SELECT count(*)::int FROM public.inventory_items WHERE id LIKE $1 OR serial_number LIKE $1) AS items`,
    [`${PREFIX}%`]
  )
  if (residue.rows[0].txns === 0 && residue.rows[0].items === 0) {
    pass(results, "residue", "no verify-067 rows left")
  } else {
    fail(results, "residue", JSON.stringify(residue.rows[0]))
    process.exitCode = 1
  }
  const failed = Object.values(results).some((row) => row.result === "FAIL")
  await Promise.race([db.end(), new Promise((resolve) => setTimeout(resolve, 2000))])
  process.exit(failed || process.exitCode ? 1 : 0)
}
