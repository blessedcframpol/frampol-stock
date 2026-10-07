/**
 * Verify 20261001160000_client_transaction_resolution.sql.
 *
 * Runs inside the rollback harness: BEGIN … ROLLBACK, never commits.
 * Usage: node scripts/verify-065-client-transaction-resolution.mjs
 */
import { createRequire } from "module"
import { withHarness } from "./verify-harness.mjs"

const require = createRequire(import.meta.url)

// Distinct from leftover verify-065-* residue still in production (A1 blocked cleanup).
const PREFIX = "harness-065-"
const EMAIL_PREFIX = "harness-065-"
const KUDZANAI = "CLT-1776236425866-d56cys2"
const KIM_LAURENCE = [
  ["CLT-1785948975137-km4wqki", "2026-08-05"],
  ["CLT-1789642904701-g8hxxzr", "2026-09-16"],
]
const FORTUNATE_SALES = [
  "TXN-1779863170957-1-wa47150",
  "TXN-1777488626361-1-oqe1qb3",
  "TXN-1777487783890-1-66d5sui",
  "TXN-1778077044872-1-laxya0h",
  "TXN-1779783989850-1-9v0gvlt",
  "TXN-1780391654029-1-tj6bpvb",
]
const DATE = "2026-01-15T00:00:00.000Z"

const SALE_COUNT_SQL = `
  SELECT
    resolution.resolved_client_id AS client_id,
    count(DISTINCT resolution.batch_key)::integer AS orders,
    count(*)::integer AS units
  FROM public.client_transaction_resolution AS resolution
  JOIN public.active_transactions AS transactions
    ON transactions.id = resolution.transaction_id
  WHERE transactions.type = 'Sale'
    AND resolution.resolved_client_id IS NOT NULL
  GROUP BY resolution.resolved_client_id
`

export const MARKERS = [
  {
    label: "transactions",
    sql: `SELECT count(*)::int AS n FROM public.transactions
          WHERE id LIKE $1 OR serial_number LIKE $1 OR batch_id LIKE $1`,
    params: [`${PREFIX}%`],
  },
  {
    label: "clients",
    sql: `SELECT count(*)::int AS n FROM public.clients WHERE id LIKE $1`,
    params: [`CLT-${PREFIX}%`],
  },
  {
    label: "users",
    sql: `SELECT count(*)::int AS n FROM auth.users WHERE email LIKE $1`,
    params: [`${EMAIL_PREFIX}%`],
  },
]

function indexCounts(rows) {
  const byId = new Map()
  for (const row of rows) {
    byId.set(row.client_id, { orders: Number(row.orders), units: Number(row.units) })
  }
  return byId
}

function changedClients(before, after) {
  const changed = []
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const left = before.get(id)
    const right = after.get(id)
    if (!left || !right || left.orders !== right.orders || left.units !== right.units) changed.push(id)
  }
  return changed
}

export async function runChecks(ctx) {
  const { db, pass, fail } = ctx

  const ready = await db.query(
    `SELECT
       to_regclass('public.client_transaction_resolution') IS NOT NULL AS view_ready,
       to_regprocedure('public.client_transactions(text)') IS NOT NULL AS rows_ready,
       to_regprocedure('public.client_sale_dispatch_counts()') IS NOT NULL AS counts_ready,
       to_regprocedure('public.client_last_activity()') IS NOT NULL AS activity_ready`,
  )
  if (
    !ready.rows[0]?.view_ready ||
    !ready.rows[0]?.rows_ready ||
    !ready.rows[0]?.counts_ready ||
    !ready.rows[0]?.activity_ready
  ) {
    throw new Error(
      "Apply supabase/migrations/20261001160000_client_transaction_resolution.sql before running this script.",
    )
  }

  async function saleCounts() {
    const counted = await db.query(SALE_COUNT_SQL)
    return indexCounts(counted.rows)
  }

  const startCounts = await saleCounts()
  const live = await db.query(
    `SELECT client_id, orders, units, reliable
     FROM public.client_sale_dispatch_counts()
     ORDER BY client_id`,
  )
  const liveCounts = indexCounts(live.rows)
  const mismatches = []
  for (const id of new Set([...startCounts.keys(), ...liveCounts.keys()])) {
    const expected = startCounts.get(id)
    const actual = liveCounts.get(id)
    const row = live.rows.find((item) => item.client_id === id)
    if (
      !expected ||
      !actual ||
      expected.orders !== actual.orders ||
      expected.units !== actual.units ||
      row?.reliable !== true
    ) {
      mismatches.push(id)
    }
  }
  const orders = [...startCounts.values()].reduce((sum, row) => sum + row.orders, 0)
  const units = [...startCounts.values()].reduce((sum, row) => sum + row.units, 0)
  if (mismatches.length === 0) {
    pass(
      "snapshot",
      `${startCounts.size} clients, ${orders} orders, ${units} units match client_sale_dispatch_counts()`,
    )
  } else {
    fail("snapshot", `${mismatches.length} clients differ; sample ${mismatches.slice(0, 5).join(", ")}`)
  }

  const parity = await db.query(
    `SELECT fn.client_id
     FROM public.client_sale_dispatch_counts() AS fn
     CROSS JOIN LATERAL (
       SELECT count(DISTINCT rows.batch_key)::integer AS orders, count(*)::integer AS units
       FROM public.client_transactions(fn.client_id) AS rows
       WHERE rows.type = 'Sale'
     ) AS sale
     WHERE fn.orders IS DISTINCT FROM sale.orders
        OR fn.units IS DISTINCT FROM sale.units`,
  )
  if (parity.rows.length === 0) {
    pass("sale_rows_match_counts", "every client's sale batches from client_transactions() match the function")
  } else {
    fail("sale_rows_match_counts", parity.rows.slice(0, 5).map((row) => row.client_id).join(", "))
  }

  const kudz = live.rows.find((row) => row.client_id === KUDZANAI)
  const kudzRows = await db.query(`SELECT id, type, batch_key FROM public.client_transactions($1)`, [KUDZANAI])
  const kudzSales = kudzRows.rows.filter((row) => row.type === "Sale")
  const kudzOrders = new Set(kudzSales.map((row) => row.batch_key)).size
  const fortunateOnTab = kudzRows.rows.filter((row) => FORTUNATE_SALES.includes(row.id))
  if (kudz && kudz.orders === kudzOrders && kudz.units === kudzSales.length && fortunateOnTab.length === 0) {
    pass("kudzanai", `${kudz.orders} orders / ${kudz.units} units, and none of the six Fortunate sales`)
  } else {
    fail(
      "kudzanai",
      `function ${kudz?.orders}/${kudz?.units}; tab sales ${kudzSales.length} in ${kudzOrders} batches; fortunate ${fortunateOnTab.length}`,
    )
  }

  const kimIds = KIM_LAURENCE.map(([id]) => id)
  const kimIndependent = await db.query(
    `SELECT resolution.resolved_client_id AS client_id, max(left(transactions.date, 10)) AS last_activity_date
     FROM public.client_transaction_resolution AS resolution
     JOIN public.active_transactions AS transactions ON transactions.id = resolution.transaction_id
     WHERE resolution.resolved_client_id = ANY($1::text[])
     GROUP BY resolution.resolved_client_id
     ORDER BY client_id`,
    [kimIds],
  )
  const kim = await db.query(
    `SELECT client_id, last_activity_date
     FROM public.client_last_activity()
     WHERE client_id = ANY($1::text[])
     ORDER BY client_id`,
    [kimIds],
  )
  const kimGot = kim.rows.map((row) => `${row.client_id}=${row.last_activity_date}`).join(", ")
  const kimExpected = kimIndependent.rows.map((row) => `${row.client_id}=${row.last_activity_date}`).join(", ")
  if (kim.rows.length === kimIds.length && kimGot === kimExpected) {
    pass("kim_laurence", "each Kim Laurence Group row matches its own active transactions")
  } else {
    fail("kim_laurence", `expected ${kimExpected}; got ${kimGot}`)
  }

  await db.query(
    `INSERT INTO public.clients (id, name, company, email, phone, address, sites)
     VALUES
       ('CLT-harness-065-acme', 'Buyer', 'Acme', 'harness-065-acme@test.local', '000', 'Verify', '[{"address":"Verify"}]'),
       ('CLT-harness-065-twin-a', 'Twin A', 'Verify Twin', 'harness-065-twin-a@test.local', '000', 'Verify', '[{"address":"Verify"}]'),
       ('CLT-harness-065-twin-b', 'Twin B', 'Verify Twin', 'harness-065-twin-b@test.local', '000', 'Verify', '[{"address":"Verify"}]'),
       ('CLT-harness-065-text', 'Text Target', 'Text Target Co', 'harness-065-text@test.local', '000', 'Verify', '[{"address":"Verify"}]'),
       ('CLT-harness-065-owner', 'Owner', 'Owner Co', 'harness-065-owner@test.local', '000', 'Verify', '[{"address":"Verify"}]')`,
  )
  await db.query(
    `INSERT INTO public.transactions (id, type, serial_number, item_name, client, date, client_id, invoice_number, batch_id)
     VALUES
       ('TXN-harness-065-substr', 'Sale', 'harness-065-substr', 'Verify kit', 'Someone - Acme Holdings', $1, NULL, '100', NULL),
       ('TXN-harness-065-ambig', 'Sale', 'harness-065-ambig', 'Verify kit', 'Verify Twin', $1, NULL, '100', NULL),
       ('TXN-harness-065-dangle', 'Sale', 'harness-065-dangle', 'Verify kit', 'Text Target', $1, 'CLT-harness-065-missing', '100', NULL),
       ('TXN-harness-065-poc', 'POC Out', 'harness-065-poc', 'Verify kit', 'Owner - Owner Co', $1, 'CLT-harness-065-owner', NULL, 'harness-065-poc'),
       ('TXN-harness-065-return', 'POC Return', 'harness-065-return', 'Verify kit', 'Someone else', $1, 'CLT-harness-065-owner', NULL, NULL)`,
    [DATE],
  )

  const held = await db.query(`SELECT client_id, orders, units FROM public.client_sale_dispatch_counts()`)
  const heldCounts = indexCounts(held.rows)
  const heldBad = changedClients(startCounts, heldCounts).filter(
    (id) => startCounts.has(id) && !id.includes("harness-065-"),
  )
  if (heldBad.length === 0) {
    pass("snapshot_unchanged_by_fixtures", "existing clients keep their sale counts")
  } else {
    fail("snapshot_unchanged_by_fixtures", `${heldBad.length} changed: ${heldBad.slice(0, 5).join(", ")}`)
  }

  const substring = await db.query(
    `SELECT method, unresolved_reason, resolved_client_id
     FROM public.client_transaction_resolution
     WHERE transaction_id = 'TXN-harness-065-substr'`,
  )
  const acmeTab = await db.query(
    `SELECT id FROM public.client_transactions('CLT-harness-065-acme') WHERE id = 'TXN-harness-065-substr'`,
  )
  const sub = substring.rows[0]
  if (
    sub?.method === "unresolved" &&
    sub?.unresolved_reason === "no_match" &&
    sub?.resolved_client_id == null &&
    acmeTab.rows.length === 0
  ) {
    pass("substring", "Acme does not receive Someone - Acme Holdings")
  } else {
    fail("substring", JSON.stringify(sub))
  }

  const ambiguous = await db.query(
    `SELECT method, unresolved_reason, resolved_client_id
     FROM public.client_transaction_resolution
     WHERE transaction_id = 'TXN-harness-065-ambig'`,
  )
  const twinTab = await db.query(
    `SELECT id FROM public.client_transactions('CLT-harness-065-twin-a') WHERE id = 'TXN-harness-065-ambig'
     UNION ALL
     SELECT id FROM public.client_transactions('CLT-harness-065-twin-b') WHERE id = 'TXN-harness-065-ambig'`,
  )
  const amb = ambiguous.rows[0]
  if (
    amb?.method === "unresolved" &&
    amb?.unresolved_reason === "ambiguous_text" &&
    amb?.resolved_client_id == null &&
    twinTab.rows.length === 0
  ) {
    pass("ambiguous_text", "a text matching two directory keys is on nobody's tab")
  } else {
    fail("ambiguous_text", JSON.stringify({ amb, twins: twinTab.rows.length }))
  }

  const dangling = await db.query(
    `SELECT method, unresolved_reason, resolved_client_id
     FROM public.client_transaction_resolution
     WHERE transaction_id = 'TXN-harness-065-dangle'`,
  )
  const textTab = await db.query(
    `SELECT id FROM public.client_transactions('CLT-harness-065-text') WHERE id = 'TXN-harness-065-dangle'`,
  )
  const dang = dangling.rows[0]
  if (
    dang?.method === "unresolved" &&
    dang?.unresolved_reason === "dangling_client_id" &&
    dang?.resolved_client_id == null &&
    textTab.rows.length === 0
  ) {
    pass("dangling_client_id", "CLT-harness-065-missing is not re-matched to Text Target")
  } else {
    fail("dangling_client_id", JSON.stringify(dang))
  }

  const ownerRows = await db.query(
    `SELECT id, type FROM public.client_transactions('CLT-harness-065-owner') ORDER BY id`,
  )
  const ownerIds = ownerRows.rows.map((row) => `${row.type}:${row.id}`).sort()
  if (ownerIds.join(",") === "POC Out:TXN-harness-065-poc,POC Return:TXN-harness-065-return") {
    pass("non_sale", "POC Out and POC Return resolve by client_id and appear on the tab")
  } else {
    fail("non_sale", ownerIds.join(", ") || "(none)")
  }

  // RLS: viewer + sales can read; anon cannot. Done via SET LOCAL ROLE, not Auth HTTP.
  const viewerId = await ctx.createFixtureUser("viewer", `${EMAIL_PREFIX}viewer@test.local`)
  const salesId = await ctx.createFixtureUser("sales", `${EMAIL_PREFIX}sales@test.local`)

  let viewerOk = false
  let salesOk = false
  await ctx.asUser(viewerId, async () => {
    const viewerCounts = await db.query(`SELECT * FROM public.client_sale_dispatch_counts()`)
    const viewerRows = await db.query(`SELECT * FROM public.client_transactions($1)`, [KUDZANAI])
    const kudzanaiNow = viewerCounts.rows.find((row) => row.client_id === KUDZANAI)
    const viewerSaleCount = viewerRows.rows.filter((row) => row.type === "Sale").length
    viewerOk = Boolean(kudzanaiNow) && viewerSaleCount === kudzanaiNow.units
  })

  await ctx.asUser(salesId, async () => {
    const salesRows = await db.query(`SELECT * FROM public.client_transactions($1)`, [KUDZANAI])
    const salesView = await db.query(
      `SELECT transaction_id FROM public.client_transaction_resolution
       WHERE transaction_id = $1`,
      [FORTUNATE_SALES[0]],
    )
    const kudzanaiNow = (await db.query(`SELECT * FROM public.client_sale_dispatch_counts()`)).rows.find(
      (row) => row.client_id === KUDZANAI,
    )
    const salesSaleCount = salesRows.rows.filter((row) => row.type === "Sale").length
    salesOk =
      Boolean(kudzanaiNow) &&
      salesSaleCount === kudzanaiNow.units &&
      salesView.rows[0]?.transaction_id === FORTUNATE_SALES[0]
  })

  let anonBlocked = false
  await db.query(`SET LOCAL ROLE anon`)
  try {
    const anonErr = await ctx.raises(`SELECT * FROM public.client_sale_dispatch_counts()`, [], "")
    const anonRowsErr = await ctx.raises(`SELECT * FROM public.client_transactions($1)`, [KUDZANAI], "")
    // raises returns null when needle found; empty needle means any error counts as blocked
    anonBlocked = anonErr === null || anonErr.startsWith("expected") === false
    // Prefer: both calls throw
    const a = await (async () => {
      const sp = "sp_anon_a"
      await db.query(`SAVEPOINT ${sp}`)
      try {
        await db.query(`SELECT * FROM public.client_sale_dispatch_counts()`)
        await db.query(`ROLLBACK TO SAVEPOINT ${sp}`)
        return false
      } catch {
        await db.query(`ROLLBACK TO SAVEPOINT ${sp}`)
        return true
      }
    })()
    const b = await (async () => {
      const sp = "sp_anon_b"
      await db.query(`SAVEPOINT ${sp}`)
      try {
        await db.query(`SELECT * FROM public.client_transactions($1)`, [KUDZANAI])
        await db.query(`ROLLBACK TO SAVEPOINT ${sp}`)
        return false
      } catch {
        await db.query(`ROLLBACK TO SAVEPOINT ${sp}`)
        return true
      }
    })()
    anonBlocked = a && b
  } finally {
    await db.query(`RESET ROLE`)
  }

  if (viewerOk && salesOk && anonBlocked) {
    pass("rls", "viewer and sales can read; anon cannot execute")
  } else {
    fail("rls", JSON.stringify({ viewerOk, salesOk, anonBlocked }))
  }
}

async function main() {
  const { ok, failed, passed } = await withHarness(
    { markers: MARKERS, timeoutMs: 120_000, label: "verify-065" },
    runChecks,
  )
  console.log(ok ? `\n${passed} passed` : `\n${failed} failed`)
  process.exitCode = ok ? 0 : 1
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-065-client-transaction-resolution.mjs")
if (isMain) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
