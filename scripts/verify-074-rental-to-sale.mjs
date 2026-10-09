/**
 * Convert a rental to a sale.
 * Runs inside the rollback harness: BEGIN … ROLLBACK, never commits.
 *
 * Usage: node scripts/verify-074-rental-to-sale.mjs
 */
import { withHarness } from "./verify-harness.mjs"
import { dropMovementPrev, stampTxn, bumpRestoreClock, setJwt } from "./verify-harness-fixtures.mjs"

// Distinct from leftover RS1074-* residue still in production.
const PREFIX = "H3074"
const HOLDER = "H3074 Holder"
const INVOICE = "H3074-INV"
const REVERSE_REASON = "RS1 verify reversal reason"
const RESTORE_REASON = "RS1 verify restore reason"

let seq = 0
function nextId(kind) {
  seq += 1
  return `${kind}-${PREFIX}-${seq}`
}

function iso(day) {
  return `${day}T00:00:00.000Z`
}

export const MARKERS = [
  {
    label: "transactions",
    sql: `SELECT count(*)::int AS n FROM public.transactions
          WHERE serial_number LIKE $1 OR id LIKE $2 OR batch_id LIKE $3`,
    params: [`${PREFIX}-%`, `TXN-${PREFIX}-%`, `BATCH-${PREFIX}-%`],
  },
  {
    label: "items",
    sql: `SELECT count(*)::int AS n FROM public.inventory_items
          WHERE serial_number LIKE $1 OR id LIKE $2`,
    params: [`${PREFIX}-%`, `ITEM-${PREFIX}-%`],
  },
  {
    label: "batch_reversals",
    sql: `SELECT count(*)::int AS n FROM public.batch_reversals WHERE batch_id LIKE $1`,
    params: [`BATCH-${PREFIX}-%`],
  },
  {
    label: "batch_restores",
    sql: `SELECT count(*)::int AS n FROM public.batch_restores WHERE batch_id LIKE $1`,
    params: [`BATCH-${PREFIX}-%`],
  },
  {
    label: "batch_invoices",
    sql: `SELECT count(*)::int AS n FROM public.batch_invoices WHERE batch_id LIKE $1`,
    params: [`BATCH-${PREFIX}-%`],
  },
  {
    label: "users",
    sql: `SELECT count(*)::int AS n FROM auth.users WHERE email LIKE 'harness-074-%@test.local'`,
    params: [],
  },
]

export async function runChecks(ctx) {
  const db = ctx.db
  const pass = (name, reason) => ctx.pass(name, reason)
  const fail = (name, reason) => ctx.fail(name, reason)

  const star = await db.query(
    `SELECT id, product_name FROM public.product_lines WHERE vendor = 'Starlink' AND is_active ORDER BY id LIMIT 1`,
  )
  const other = await db.query(
    `SELECT id, product_name FROM public.product_lines WHERE vendor IS DISTINCT FROM 'Starlink' AND is_active ORDER BY id LIMIT 1`,
  )
  const client = await db.query(`SELECT id FROM public.clients ORDER BY id LIMIT 1`)
  if (!star.rows[0]) throw new Error("no active Starlink product")
  if (!other.rows[0]) throw new Error("no active non-Starlink product")
  if (!client.rows[0]) throw new Error("no client for fixtures")

  const days = await db.query(
    `SELECT to_char((now() AT TIME ZONE 'Africa/Harare')::date, 'YYYY-MM-DD') AS today,
            to_char((now() AT TIME ZONE 'Africa/Harare')::date - 4, 'YYYY-MM-DD') AS start,
            to_char((now() AT TIME ZONE 'Africa/Harare')::date - 2, 'YYYY-MM-DD') AS ending,
            to_char((now() AT TIME ZONE 'Africa/Harare')::date + 1, 'YYYY-MM-DD') AS tomorrow,
            to_char((now() AT TIME ZONE 'Africa/Harare')::date + 20, 'YYYY-MM-DD') AS due`,
  )
  const { today, start, ending, tomorrow, due } = days.rows[0]
  const clock = { tick: 0, baseIso: iso(today) }
  const clientId = client.rows[0].id
  const starId = star.rows[0].id
  const starName = star.rows[0].product_name
  const otherId = other.rows[0].id

  const adminId = await ctx.createFixtureUser("admin", "harness-074-admin@test.local")
  await setJwt(db, adminId)

  async function move(serial, productId, productName, type, status, location, extra = {}) {
    const current = await db.query(
      `SELECT id FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
      [serial],
    )
    const txnId = extra.txnId ?? nextId("TXN")
    const batchId = extra.batchId ?? nextId("BATCH")
    await dropMovementPrev(db)
    await db.query(`SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`, [
      JSON.stringify([
        {
          id: current.rows[0].id,
          product_id: productId,
          serial_number: serial,
          status,
          date_added: today,
          location,
          client: extra.client ?? null,
          assigned_to: extra.assigned_to ?? null,
          poc_out_date: extra.poc_out_date ?? null,
          return_date: extra.return_date ?? null,
        },
      ]),
      JSON.stringify([
        {
          id: txnId,
          type,
          serial_number: serial,
          item_name: productName,
          date: extra.date,
          client: extra.txnClient ?? extra.client ?? "Internal",
          client_id: extra.client_id ?? null,
          invoice_number: extra.invoice_number ?? null,
          batch_id: batchId,
          to_location: location,
          metadata: extra.metadata ?? null,
        },
      ]),
    ])
    await stampTxn(db, clock, txnId)
    return { txnId, batchId }
  }

  async function inbound(serial, productId, productName) {
    const itemId = nextId("ITEM")
    const txnId = nextId("TXN")
    const batchId = nextId("BATCH")
    await dropMovementPrev(db)
    await db.query(`SELECT public.apply_stock_movement('[]'::jsonb, $1::jsonb, $2::jsonb)`, [
      JSON.stringify([
        {
          id: itemId,
          product_id: productId,
          serial_number: serial,
          status: "In Stock",
          date_added: today,
          location: "Warehouse A",
        },
      ]),
      JSON.stringify([
        {
          id: txnId,
          type: "Inbound",
          serial_number: serial,
          item_name: productName,
          date: iso(today),
          client: "Internal",
          batch_id: batchId,
          to_location: "Warehouse A",
        },
      ]),
    ])
    await stampTxn(db, clock, txnId)
    return { itemId }
  }

  const serial = `${PREFIX}-rent`
  await inbound(serial, starId, starName)
  await move(serial, starId, starName, "Rentals", "Rented", "Client Site", {
    date: iso(start),
    client: HOLDER,
    assigned_to: HOLDER,
    txnClient: HOLDER,
    client_id: clientId,
    poc_out_date: start,
    return_date: due,
    invoice_number: "H3074-RENT",
  })

  const itemIdFor = async (sn) =>
    (await db.query(`SELECT id FROM public.inventory_items WHERE serial_number = $1`, [sn])).rows[0].id

  await dropMovementPrev(db)
  const earlyEnd = await ctx.raises(
    `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
    [
      JSON.stringify([
        {
          id: await itemIdFor(serial),
          product_id: starId,
          serial_number: serial,
          status: "Sold",
          date_added: today,
          location: "Client Site",
          client: HOLDER,
          assigned_to: HOLDER,
          return_date: null,
        },
      ]),
      JSON.stringify([
        {
          id: nextId("TXN"),
          type: "Sale",
          serial_number: serial,
          item_name: starName,
          date: iso(start),
          client: HOLDER,
          client_id: clientId,
          invoice_number: INVOICE,
          batch_id: nextId("BATCH"),
          metadata: { converted_from: "Rentals", rental_end: start < ending ? "2020-01-01" : start },
        },
      ]),
    ],
    "between the rental start and today",
  )
  if (earlyEnd) fail("end_before_start", earlyEnd)
  else pass("end_before_start", "rental end before the rental start is rejected")

  await dropMovementPrev(db)
  const futureEnd = await ctx.raises(
    `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
    [
      JSON.stringify([
        {
          id: await itemIdFor(serial),
          product_id: starId,
          serial_number: serial,
          status: "Sold",
          date_added: today,
          location: "Client Site",
          client: HOLDER,
        },
      ]),
      JSON.stringify([
        {
          id: nextId("TXN"),
          type: "Sale",
          serial_number: serial,
          item_name: starName,
          date: iso(tomorrow),
          client: HOLDER,
          invoice_number: INVOICE,
          batch_id: nextId("BATCH"),
          metadata: { converted_from: "Rentals", rental_end: tomorrow },
        },
      ]),
    ],
    "between the rental start and today",
  )
  if (futureEnd) fail("end_after_today", futureEnd)
  else pass("end_after_today", "rental end after today is rejected")

  await dropMovementPrev(db)
  const earlySale = await ctx.raises(
    `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
    [
      JSON.stringify([
        {
          id: await itemIdFor(serial),
          product_id: starId,
          serial_number: serial,
          status: "Sold",
          date_added: today,
          location: "Client Site",
          client: HOLDER,
        },
      ]),
      JSON.stringify([
        {
          id: nextId("TXN"),
          type: "Sale",
          serial_number: serial,
          item_name: starName,
          date: iso(start),
          client: HOLDER,
          invoice_number: INVOICE,
          batch_id: nextId("BATCH"),
          metadata: { converted_from: "Rentals", rental_end: ending },
        },
      ]),
    ],
    "before the rental end date",
  )
  if (earlySale) fail("sale_before_end", earlySale)
  else pass("sale_before_end", "sale date before the rental end is rejected")

  const sold = await move(serial, starId, starName, "Sale", "Sold", "Client Site", {
    date: iso(ending),
    client: null,
    assigned_to: null,
    return_date: due,
    txnClient: HOLDER,
    client_id: clientId,
    invoice_number: INVOICE,
    metadata: { converted_from: "Rentals", rental_end: ending },
  })

  const item = await db.query(
    `SELECT status, stock_pool, client, assigned_to, return_date
     FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
    [serial],
  )
  const sale = await db.query(
    `SELECT type, invoice_number, metadata, previous_status, previous_client, previous_return_date,
            previous_stock_pool, after_status, after_client, after_return_date, after_stock_pool
     FROM public.transactions WHERE id = $1`,
    [sold.txnId],
  )
  const counts = await db.query(
    `SELECT
       (SELECT count(*)::int FROM public.transactions WHERE serial_number = $1 AND type = 'Sale') AS sales,
       (SELECT count(*)::int FROM public.transactions WHERE serial_number = $1 AND type = 'Rental Return') AS returns,
       (SELECT count(*)::int FROM public.kit_cases kc
          JOIN public.inventory_items item ON item.id = kc.inventory_item_id
          WHERE item.serial_number = $1) AS cases`,
    [serial],
  )
  const row = item.rows[0]
  const txn = sale.rows[0]
  const meta = txn?.metadata ?? {}
  const kitOk =
    row?.status === "Sold" &&
    row.stock_pool === "rental" &&
    row.client === HOLDER &&
    row.return_date == null &&
    counts.rows[0].sales === 1 &&
    counts.rows[0].returns === 0 &&
    counts.rows[0].cases === 0
  const periodOk =
    txn?.type === "Sale" &&
    txn.invoice_number === INVOICE &&
    meta.converted_from === "Rentals" &&
    meta.rental_start === start &&
    meta.rental_end === ending &&
    Number(meta.rental_days) === 3 &&
    txn.previous_status === "Rented" &&
    txn.previous_client === HOLDER &&
    txn.previous_return_date === due &&
    txn.previous_stock_pool === "rental" &&
    txn.after_status === "Sold" &&
    txn.after_client === HOLDER &&
    txn.after_return_date == null &&
    txn.after_stock_pool === "rental"
  if (kitOk && periodOk) pass("converted", `one Sale, ${meta.rental_days} rental days, no return and no case`)
  else fail("converted", JSON.stringify({ row, txn, counts: counts.rows[0] }))

  await setJwt(db, adminId)
  await db.query(`SELECT public.reverse_quick_scan_batch($1, $2, NULL, '[]'::jsonb, '[]'::jsonb)`, [
    sold.batchId,
    REVERSE_REASON,
  ])
  const reversed = await db.query(
    `SELECT status, stock_pool, client, return_date
     FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
    [serial],
  )
  const back = reversed.rows[0]
  if (back?.status === "Rented" && back.stock_pool === "rental" && back.client === HOLDER && back.return_date === due) {
    pass("reverse", "Rented, rental pool, client, and return date restored")
  } else fail("reverse", JSON.stringify(back))

  await db.query(`SELECT public.restore_batch($1, $2)`, [sold.batchId, RESTORE_REASON])
  await bumpRestoreClock(db, sold.batchId)
  const restored = await db.query(
    `SELECT status, stock_pool, client, return_date
     FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
    [serial],
  )
  const again = restored.rows[0]
  if (again?.status === "Sold" && again.client === HOLDER && again.return_date == null && again.stock_pool === "rental") {
    pass("restore", "the sale is active again")
  } else fail("restore", JSON.stringify(again))

  const plain = `${PREFIX}-stock`
  await inbound(plain, starId, starName)
  await dropMovementPrev(db)
  const notRented = await ctx.raises(
    `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
    [
      JSON.stringify([
        {
          id: await itemIdFor(plain),
          product_id: starId,
          serial_number: plain,
          status: "Sold",
          date_added: today,
          location: "Delivered",
          client: HOLDER,
        },
      ]),
      JSON.stringify([
        {
          id: nextId("TXN"),
          type: "Sale",
          serial_number: plain,
          item_name: starName,
          date: iso(today),
          client: HOLDER,
          invoice_number: INVOICE,
          batch_id: nextId("BATCH"),
          metadata: { converted_from: "Rentals", rental_end: today },
        },
      ]),
    ],
    "only for a rented kit",
  )
  if (notRented) fail("not_rented", notRented)
  else pass("not_rented", "an in-stock kit cannot use the rental conversion")

  const otherSerial = `${PREFIX}-other`
  const otherItem = nextId("ITEM")
  await db.query(
    `INSERT INTO public.inventory_items (id, product_id, serial_number, status, stock_pool, date_added, location, client, assigned_to, return_date)
     VALUES ($1, $2, $3, 'Rented', 'rental', $4, 'Client Site', $5, $5, $6)`,
    [otherItem, otherId, otherSerial, today, HOLDER, due],
  )
  await dropMovementPrev(db)
  const notStarlink = await ctx.raises(
    `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
    [
      JSON.stringify([
        {
          id: otherItem,
          product_id: otherId,
          serial_number: otherSerial,
          status: "Sold",
          date_added: today,
          location: "Client Site",
          client: HOLDER,
        },
      ]),
      JSON.stringify([
        {
          id: nextId("TXN"),
          type: "Sale",
          serial_number: otherSerial,
          item_name: other.rows[0].product_name,
          date: iso(today),
          client: HOLDER,
          invoice_number: INVOICE,
          batch_id: nextId("BATCH"),
          metadata: { converted_from: "Rentals", rental_end: today },
        },
      ]),
    ],
    "only for Starlink kits",
  )
  if (notStarlink) fail("not_starlink", notStarlink)
  else pass("not_starlink", "a rented kit that is not Starlink is rejected")
}

async function main() {
  const { ok, failed, passed } = await withHarness(
    { markers: MARKERS, timeoutMs: 180_000, label: "verify-074" },
    runChecks,
  )
  console.log(ok ? `\n${passed} passed` : `\n${failed} failed`)
  process.exitCode = ok ? 0 : 1
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-074-rental-to-sale.mjs")
if (isMain) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
