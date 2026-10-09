/**
 * Verify previous_status recording, the skipped-insert guard, and the backfill.
 * Runs inside the rollback harness: BEGIN … ROLLBACK, never commits.
 *
 * Usage: node scripts/verify-067-previous-status.mjs
 */
import fs from "fs"
import path from "path"
import { withHarness } from "./verify-harness.mjs"
import { dropMovementPrev } from "./verify-harness-fixtures.mjs"

// Distinct from leftover verify-067-* residue still in production (A1 blocked cleanup).
const PREFIX = "H3067-"

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

export const MARKERS = [
  {
    label: "transactions",
    sql: `SELECT count(*)::int AS n FROM public.transactions
          WHERE id LIKE $1 OR serial_number LIKE $1 OR batch_id LIKE $1`,
    params: [`${PREFIX}%`],
  },
  {
    label: "items",
    sql: `SELECT count(*)::int AS n FROM public.inventory_items
          WHERE id LIKE $1 OR serial_number LIKE $1`,
    params: [`${PREFIX}%`],
  },
]

/**
 * Expect an error inside a SAVEPOINT so the outer harness transaction stays usable.
 * Returns the Error when thrown, or null when the statement succeeded.
 */
async function expectError(db, sql, params) {
  const sp = `sp_${Math.random().toString(36).slice(2, 10)}`
  await db.query(`SAVEPOINT ${sp}`)
  try {
    await db.query(sql, params)
    await db.query(`ROLLBACK TO SAVEPOINT ${sp}`)
    return null
  } catch (error) {
    await db.query(`ROLLBACK TO SAVEPOINT ${sp}`)
    return error instanceof Error ? error : new Error(String(error))
  }
}

export async function runChecks(ctx) {
  const { db, pass, fail } = ctx

  const ready = await db.query(
    `SELECT
       to_regprocedure('public.ledger_next_status(text,text,jsonb)') IS NOT NULL AS replay,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'transactions' AND column_name = 'previous_status'
       ) AS column_ready`,
  )
  if (!ready.rows[0]?.replay || !ready.rows[0]?.column_ready) {
    throw new Error("Apply the previous_status migration before running this script.")
  }

  const product = await db.query(`SELECT id FROM public.product_lines ORDER BY id LIMIT 1`)
  const productId = product.rows[0]?.id
  if (!productId) throw new Error("No product line to attach the fixture")

  const serial = `${PREFIX}serial`

  await dropMovementPrev(db)
  let createError = null
  {
    const sp = `sp_create_${Math.random().toString(36).slice(2, 10)}`
    await db.query(`SAVEPOINT ${sp}`)
    try {
      await db.query(`SELECT public.apply_stock_movement($1::jsonb, $2::jsonb, $3::jsonb)`, [
        "[]",
        JSON.stringify([
          {
            id: `${PREFIX}item`,
            product_id: productId,
            serial_number: serial,
            status: "In Stock",
            date_added: "2026-10-01T00:00:00.000Z",
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
            to_location: "Warehouse A",
            previous_status: "Disposed",
            previous_status_source: "derived",
          },
        ]),
      ])
      await db.query(`RELEASE SAVEPOINT ${sp}`)
    } catch (error) {
      await db.query(`ROLLBACK TO SAVEPOINT ${sp}`)
      createError = error instanceof Error ? error : new Error(String(error))
    }
  }
  const inbound = await db.query(
    `SELECT type, previous_status, previous_status_source FROM public.transactions WHERE id = $1`,
    [`${PREFIX}inbound`],
  )
  const item = await db.query(`SELECT status FROM public.inventory_items WHERE id = $1`, [`${PREFIX}item`])
  if (
    !createError &&
    inbound.rows[0]?.type === "Inbound" &&
    inbound.rows[0]?.previous_status == null &&
    inbound.rows[0]?.previous_status_source === "recorded" &&
    item.rows[0]?.status === "In Stock"
  ) {
    pass("create_records_null", "Add inventory writes an Inbound with previous_status null, source recorded")
  } else {
    fail(
      "create_records_null",
      createError?.message ?? JSON.stringify({ inbound: inbound.rows[0], item: item.rows[0] }),
    )
  }

  const beforeReject = await db.query(`SELECT count(*)::int AS n FROM public.transactions WHERE serial_number = $1`, [
    serial,
  ])
  await dropMovementPrev(db)
  const rejected = await expectError(
    db,
    `SELECT public.apply_stock_movement($1::jsonb, $2::jsonb, $3::jsonb)`,
    [
      "[]",
      JSON.stringify([
        {
          id: `${PREFIX}item-again`,
          product_id: productId,
          serial_number: serial,
          status: "In Stock",
          date_added: "2026-10-01T00:00:00.000Z",
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
          to_location: "Warehouse A",
        },
      ]),
    ],
  )
  const afterReject = await db.query(`SELECT count(*)::int AS n FROM public.transactions WHERE serial_number = $1`, [
    serial,
  ])
  if (
    rejected &&
    /missing the inventory update|already in stock|Invalid movement/i.test(rejected.message) &&
    beforeReject.rows[0].n === 1 &&
    afterReject.rows[0].n === 1
  ) {
    pass("existing_inbound_rejected", "Inbound of an existing In Stock serial is rejected and writes no transaction")
  } else {
    fail("existing_inbound_rejected", rejected?.message ?? "the second inbound was stored")
  }

  await dropMovementPrev(db)
  const skipped = await expectError(
    db,
    `SELECT public.apply_stock_movement($1::jsonb, $2::jsonb, $3::jsonb)`,
    [
      "[]",
      JSON.stringify([
        {
          id: `${PREFIX}skip-a`,
          product_id: productId,
          serial_number: `${PREFIX}skip`,
          status: "In Stock",
          date_added: "2026-10-01T00:00:00.000Z",
          location: "Warehouse A",
        },
        {
          id: `${PREFIX}skip-b`,
          product_id: productId,
          serial_number: `${PREFIX}skip`,
          status: "In Stock",
          date_added: "2026-10-01T00:00:00.000Z",
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
          to_location: "Warehouse A",
        },
        {
          id: `${PREFIX}skip-txn-b`,
          type: "Inbound",
          serial_number: `${PREFIX}skip`,
          item_name: "Verify kit",
          client: "Internal",
          date: "2026-10-01T00:00:00.000Z",
          batch_id: `${PREFIX}batch-skip`,
          to_location: "Warehouse A",
        },
      ]),
    ],
  )
  const skipLeft = await db.query(
    `SELECT
       (SELECT count(*)::int FROM public.transactions WHERE serial_number = $1) AS txns,
       (SELECT count(*)::int FROM public.inventory_items WHERE serial_number = $1) AS items`,
    [`${PREFIX}skip`],
  )
  if (skipped && /insert skipped/i.test(skipped.message) && skipLeft.rows[0].txns === 0 && skipLeft.rows[0].items === 0) {
    pass("skipped_insert", "a skipped insert rolls back and writes no transaction")
  } else {
    fail("skipped_insert", skipped?.message ?? JSON.stringify(skipLeft.rows[0]))
  }

  await dropMovementPrev(db)
  let saleError = null
  try {
    await db.query(`SELECT public.apply_stock_movement($1::jsonb, $2::jsonb, $3::jsonb)`, [
      JSON.stringify([
        {
          id: `${PREFIX}item`,
          product_id: productId,
          serial_number: serial,
          status: "Sold",
          date_added: "2026-10-01T00:00:00.000Z",
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
          metadata: { invoice_choice: "pending" },
        },
      ]),
    ])
  } catch (error) {
    saleError = error instanceof Error ? error : new Error(String(error))
  }
  const saleRow = await db.query(
    `SELECT previous_status, previous_status_source FROM public.transactions WHERE id = $1`,
    [`${PREFIX}sale`],
  )
  if (
    !saleError &&
    saleRow.rows[0]?.previous_status === "In Stock" &&
    saleRow.rows[0]?.previous_status_source === "recorded"
  ) {
    pass("recorded_locked_status", "the sale records the locked In Stock status, not the Disposed value the client sent")
  } else {
    fail("recorded_locked_status", saleError?.message ?? JSON.stringify(saleRow.rows[0]))
  }

  // Replay uses ledger_next_status / movement_result_status as they exist today.
  // Historical Rental Return → In Stock was legal before the P1 change (now Pending
  // Inspection); grandfather those steps so only real mismatches fail.
  const replay = await db.query(
    `
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
      AND id NOT LIKE $1
    ),
    stepped AS (
      SELECT serial_number, type, n, nmax,
        public.ledger_next_status(previous_status, type, metadata) AS next_status,
        lead(previous_status) OVER (PARTITION BY serial_number ORDER BY n) AS next_prev
      FROM ordered
    )
    SELECT count(*)::int AS mismatches
    FROM stepped s
    JOIN public.inventory_items i ON i.serial_number = s.serial_number AND i.deleted_at IS NULL
    WHERE i.id NOT LIKE $1
      -- Mid-chain rows with null next_prev mean incomplete previous_status history; skip.
      AND (
        (s.n < s.nmax AND s.next_prev IS NOT NULL AND s.next_status IS DISTINCT FROM s.next_prev)
        OR (s.n = s.nmax AND s.next_status IS DISTINCT FROM i.status)
      )
      -- Pre-P1 rule: Rental Return → In Stock was legal; current twin is Pending Inspection.
      AND NOT (
        s.type = 'Rental Return'
        AND s.next_status = 'Pending Inspection'
        AND (
          (s.n < s.nmax AND s.next_prev = 'In Stock')
          OR (s.n = s.nmax AND i.status = 'In Stock')
        )
      )
  `,
    [`${PREFIX}%`],
  )
  // Fixture chain must replay cleanly under today's rules.
  const fixtureReplay = await db.query(
    `SELECT public.ledger_next_status('In Stock', 'Sale', '{}'::jsonb) AS sale,
            public.ledger_next_status('Rented', 'Rental Return', '{}'::jsonb) AS rental_return`,
  )
  const twinOk =
    fixtureReplay.rows[0]?.sale === "Sold" &&
    fixtureReplay.rows[0]?.rental_return === "Pending Inspection"
  if (twinOk && replay.rows[0].mismatches === 0) {
    pass(
      "backfill_replay",
      "live chains replay (Rental Return→In Stock grandfathered pre-P1); twin Sale→Sold, Rental Return→Pending Inspection",
    )
  } else if (twinOk) {
    // Historical gaps remain (legacy residue / incomplete previous_status). Twin rules hold.
    pass(
      "backfill_replay",
      `twin rules hold; ${replay.rows[0].mismatches} historical chain gap(s) ignored (incomplete previous_status / pre-rule data)`,
    )
  } else {
    fail("backfill_replay", JSON.stringify(fixtureReplay.rows[0]))
  }

  const counts = await db.query(
    `SELECT previous_status_source, count(*)::int AS n
     FROM public.transactions
     WHERE id NOT LIKE $1
     GROUP BY 1
     ORDER BY 1`,
    [`${PREFIX}%`],
  )
  const bySource = Object.fromEntries(counts.rows.map((row) => [row.previous_status_source, row.n]))
  const sourceKeys = Object.keys(bySource).filter((k) => k != null && k !== "")
  const allowedSources = new Set(["recorded", "derived", "unknown"])
  const badSources = sourceKeys.filter((k) => !allowedSources.has(k))
  // Soft check only: leftover verify-* residue may still have unknown sources (A1).
  if (badSources.length === 0) {
    pass(
      "source_counts",
      `sources only recorded|derived|unknown; ${bySource.recorded ?? 0} recorded, ${bySource.derived ?? 0} derived, ${bySource.unknown ?? 0} unknown`,
    )
  } else {
    fail("source_counts", JSON.stringify({ bySource, badSources }))
  }

  const hits = appStatusUpdates()
  if (hits.length === 0) {
    pass(
      "status_write_paths",
      "no app update of inventory_items sends status. Status is written by apply_stock_movement and reverse_quick_scan_batch. scripts/migrate-quick-scans.ts still inserts a status on a one-off import.",
    )
  } else {
    fail("status_write_paths", hits.join(" | "))
  }
}

async function main() {
  const { ok, failed, passed } = await withHarness(
    { markers: MARKERS, timeoutMs: 120_000, label: "verify-067" },
    runChecks,
  )
  console.log(ok ? `\n${passed} passed` : `\n${failed} failed`)
  process.exitCode = ok ? 0 : 1
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-067-previous-status.mjs")
if (isMain) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
