/**
 * Bulk resolve overdue kits — rollback harness (BEGIN…ROLLBACK, never commits).
 *
 * Usage: node scripts/verify-076-bulk-resolve-holdings.mjs
 */
import { withHarness } from "./verify-harness.mjs"
import { dropMovementPrev, stampTxn, setJwt } from "./verify-harness-fixtures.mjs"

const PREFIX = "H3076"
const HOLDER = "H3076 Holder"
const INVOICE = "H3076-INV-1"
const ZERO_REASON = "Complimentary kit, not invoiced"
const RETURN_REASON = "Client ended the rental early"
const REVERSE_REASON = "H3 verify reversal reason"

let seq = 0
function nextId(kind) {
  seq += 1
  return `${kind}-${PREFIX}-${seq}`
}

function iso(day) {
  return `${day}T00:00:00.000Z`
}

function messagesFor(result, serial) {
  const errors = Array.isArray(result?.errors) ? result.errors : []
  const row = errors.find((entry) => entry.serial === serial)
  return Array.isArray(row?.messages) ? row.messages.join(" | ") : ""
}

export const MARKERS = [
  {
    label: "transactions",
    sql: `SELECT count(*)::int AS n FROM public.transactions
          WHERE serial_number LIKE $1 OR id LIKE $2 OR batch_id LIKE $3`,
    params: [`${PREFIX}%`, `TXN-${PREFIX}%`, `BATCH-${PREFIX}%`],
  },
  {
    label: "items",
    sql: `SELECT count(*)::int AS n FROM public.inventory_items WHERE serial_number LIKE $1 OR id LIKE $2`,
    params: [`${PREFIX}%`, `ITEM-${PREFIX}%`],
  },
  {
    label: "kit_cases",
    sql: `SELECT count(*)::int AS n FROM public.kit_cases kc
          JOIN public.inventory_items item ON item.id = kc.inventory_item_id
          WHERE item.serial_number LIKE $1`,
    params: [`${PREFIX}%`],
  },
  {
    label: "batch_invoices",
    sql: `SELECT count(*)::int AS n FROM public.batch_invoices
          WHERE batch_id LIKE $1 OR invoice_number LIKE $2`,
    params: [`BATCH-${PREFIX}%`, `${PREFIX}%`],
  },
  {
    label: "users",
    sql: `SELECT count(*)::int AS n FROM auth.users WHERE email LIKE 'harness-076-%@test.local'`,
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
  if (!star.rows[0]) throw new Error("no active Starlink product")
  const days = await db.query(
    `SELECT to_char((now() AT TIME ZONE 'Africa/Harare')::date, 'YYYY-MM-DD') AS today,
            to_char((now() AT TIME ZONE 'Africa/Harare')::date - 11, 'YYYY-MM-DD') AS before_dispatch,
            to_char((now() AT TIME ZONE 'Africa/Harare')::date - 10, 'YYYY-MM-DD') AS start,
            to_char((now() AT TIME ZONE 'Africa/Harare')::date - 6, 'YYYY-MM-DD') AS mid,
            to_char((now() AT TIME ZONE 'Africa/Harare')::date - 2, 'YYYY-MM-DD') AS due,
            to_char((now() AT TIME ZONE 'Africa/Harare')::date + 1, 'YYYY-MM-DD') AS tomorrow`,
  )
  const { today, before_dispatch: beforeDispatch, start, mid, due, tomorrow } = days.rows[0]
  const productId = star.rows[0].id
  const productName = star.rows[0].product_name

  const adminId = await ctx.createFixtureUser("admin", "harness-076-admin@test.local")
  const techId = await ctx.createFixtureUser("technicians", "harness-076-tech@test.local")
  const salesId = await ctx.createFixtureUser("sales", "harness-076-sales@test.local")

  const serials = {
    ret: `${PREFIX}-POC-RET`,
    sold: `${PREFIX}-POC-SOLD`,
    zero: `${PREFIX}-POC-ZERO`,
    rentRet: `${PREFIX}-RENT-RET`,
    rentSold: `${PREFIX}-RENT-SOLD`,
    future: `${PREFIX}-FUTURE`,
  }

  const clock = { tick: 0, baseIso: iso(start) }

  async function move(serial, type, status, location, extra = {}) {
    const current = await db.query(
      `SELECT id FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
      [serial],
    )
    const txnId = nextId("TXN")
    await dropMovementPrev(db)
    await db.query(`SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`, [
      JSON.stringify([
        {
          id: current.rows[0].id,
          product_id: productId,
          serial_number: serial,
          status,
          date_added: start,
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
          batch_id: nextId("BATCH"),
          to_location: location,
        },
      ]),
    ])
    await stampTxn(db, clock, txnId)
  }

  async function inbound(serial) {
    const txnId = nextId("TXN")
    await dropMovementPrev(db)
    await db.query(`SELECT public.apply_stock_movement('[]'::jsonb, $1::jsonb, $2::jsonb)`, [
      JSON.stringify([
        {
          id: nextId("ITEM"),
          product_id: productId,
          serial_number: serial,
          status: "In Stock",
          date_added: start,
          location: "Warehouse A",
        },
      ]),
      JSON.stringify([
        {
          id: txnId,
          type: "Inbound",
          serial_number: serial,
          item_name: productName,
          date: iso(start),
          client: "Internal",
          batch_id: nextId("BATCH"),
          to_location: "Warehouse A",
        },
      ]),
    ])
    await stampTxn(db, clock, txnId)
  }

  async function readItem(serial) {
    const row = await db.query(
      `SELECT status, stock_pool, location, client, return_date, poc_out_date
       FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
      [serial],
    )
    return row.rows[0] ?? null
  }

  async function txnCount() {
    const row = await db.query(
      `SELECT count(*)::int AS n FROM public.transactions WHERE serial_number LIKE $1`,
      [`${PREFIX}%`],
    )
    return row.rows[0].n
  }

  async function resolve(rows) {
    await dropMovementPrev(db)
    const result = await db.query(`SELECT public.bulk_resolve_holdings($1::jsonb) AS result`, [
      JSON.stringify(rows),
    ])
    return result.rows[0].result
  }

  function returned(serial, date, extra = {}) {
    return {
      serial_number: serial,
      action: "returned",
      action_date: date,
      location: extra.location ?? "Warehouse A",
      return_pool: extra.return_pool,
      reason_category: extra.reason_category,
      reason_text: extra.reason_text,
    }
  }

  function sold(serial, date, extra = {}) {
    return {
      serial_number: serial,
      action: "sold",
      action_date: date,
      invoice_choice: extra.invoice_choice,
      invoice_number: extra.invoice_number,
      invoice_reason: extra.invoice_reason,
      rental_end: extra.rental_end,
    }
  }

  await setJwt(db, adminId)

  for (const serial of [serials.ret, serials.sold, serials.zero, serials.future]) {
    await inbound(serial)
    await move(serial, "POC Out", "POC", "Client Site", {
      date: iso(start),
      client: HOLDER,
      assigned_to: HOLDER,
      txnClient: HOLDER,
      poc_out_date: start,
      return_date: serial === serials.future ? tomorrow : due,
    })
  }
  await move(serials.ret, "Transfer", "POC", "Warehouse B", {
    date: iso(mid),
    client: HOLDER,
    assigned_to: HOLDER,
    txnClient: HOLDER,
    poc_out_date: start,
    return_date: due,
  })
  for (const serial of [serials.rentRet, serials.rentSold]) {
    await inbound(serial)
    await move(serial, "Rentals", "Rented", "Client Site", {
      date: iso(start),
      client: HOLDER,
      assigned_to: HOLDER,
      txnClient: HOLDER,
      poc_out_date: start,
      return_date: due,
    })
  }

  await dropMovementPrev(db)
  const denied = await ctx.asUser(salesId, async () =>
    ctx.raises(
      `SELECT public.bulk_resolve_holdings($1::jsonb)`,
      [JSON.stringify([returned(serials.ret, today, { return_pool: "sale" })])],
      "permission",
    ),
  )
  const afterDenied = await readItem(serials.ret)
  if (denied) fail("permissions", denied)
  else if (afterDenied?.status !== "POC") fail("permissions", JSON.stringify(afterDenied))
  else pass("permissions", "a sales user cannot resolve, and the kit stays on POC")

  await setJwt(db, techId)
  const beforeDates = await txnCount()
  const tooEarly = await resolve([returned(serials.ret, beforeDispatch, { return_pool: "sale" })])
  const beforeLast = await resolve([returned(serials.ret, start, { return_pool: "sale" })])
  const tooLate = await resolve([returned(serials.ret, tomorrow, { return_pool: "sale" })])
  const noPool = await resolve([returned(serials.ret, today)])
  const notOverdue = await resolve([returned(serials.future, today, { return_pool: "sale" })])
  const stillPoc = await readItem(serials.ret)
  const dateMessages = [
    messagesFor(tooEarly, serials.ret),
    messagesFor(beforeLast, serials.ret),
    messagesFor(tooLate, serials.ret),
  ]
  if (
    tooEarly?.ok === false &&
    dateMessages[0].includes("dispatch date") &&
    beforeLast?.ok === false &&
    dateMessages[1].includes("last movement") &&
    tooLate?.ok === false &&
    dateMessages[2].includes("dispatch date") &&
    noPool?.ok === false &&
    messagesFor(noPool, serials.ret).includes("sellable stock") &&
    notOverdue?.ok === false &&
    messagesFor(notOverdue, serials.future).includes("overdue") &&
    stillPoc?.status === "POC" &&
    (await txnCount()) === beforeDates
  ) {
    pass("dates_and_pool", "dates, the POC pool, and a kit that is not overdue are rejected with nothing written")
  } else {
    fail(
      "dates_and_pool",
      JSON.stringify({
        tooEarly,
        beforeLast,
        tooLate,
        noPool,
        notOverdue,
        stillPoc,
        txns: await txnCount(),
        beforeDates,
      }),
    )
  }

  const beforeBlock = await txnCount()
  const blocked = await resolve([
    returned(serials.ret, today, { return_pool: "sale" }),
    sold(serials.sold, tomorrow, { invoice_choice: "number", invoice_number: INVOICE }),
    sold(serials.zero, today, { invoice_choice: "not_invoiced", invoice_reason: ZERO_REASON }),
    returned(serials.rentRet, today, { reason_category: "Client cancelled", reason_text: RETURN_REASON }),
    sold(serials.rentSold, today, { invoice_choice: "pending", rental_end: today }),
  ])
  const untouched = [
    await readItem(serials.ret),
    await readItem(serials.sold),
    await readItem(serials.zero),
    await readItem(serials.rentRet),
    await readItem(serials.rentSold),
  ]
  const blockedMessages = messagesFor(blocked, serials.sold)
  if (
    blocked?.ok === false &&
    blockedMessages.includes("dispatch date") &&
    (blocked.errors ?? []).length === 1 &&
    untouched.map((row) => row?.status).join(",") === "POC,POC,POC,Rented,Rented" &&
    (await txnCount()) === beforeBlock
  ) {
    pass("invalid_blocks", "one invalid sale date blocks the whole submit and writes nothing")
  } else {
    fail("invalid_blocks", JSON.stringify({ blocked, untouched, txns: await txnCount(), beforeBlock }))
  }

  const resolved = await resolve([
    returned(serials.ret, today, { return_pool: "demo" }),
    sold(serials.sold, today, { invoice_choice: "number", invoice_number: INVOICE }),
    sold(serials.zero, today, { invoice_choice: "not_invoiced", invoice_reason: ZERO_REASON }),
    returned(serials.rentRet, today, {
      location: "Service Center",
      reason_category: "Client cancelled",
      reason_text: RETURN_REASON,
    }),
    sold(serials.rentSold, today, { invoice_choice: "pending", rental_end: today }),
  ])
  const batches = Array.isArray(resolved?.batches) ? resolved.batches : []
  const batchIds = batches.map((batch) => batch.batch_id)
  const uniqueBatches = new Set(batchIds)
  const batchRows = uniqueBatches.size
    ? await db.query(
        `SELECT batch_id, count(*)::int AS n, min(type) AS type
         FROM public.transactions WHERE batch_id = ANY($1::text[])
         GROUP BY batch_id`,
        [batchIds],
      )
    : { rows: [] }
  const ret = await readItem(serials.ret)
  const pocSold = await readItem(serials.sold)
  const zero = await readItem(serials.zero)
  const rentRet = await readItem(serials.rentRet)
  const rentSold = await readItem(serials.rentSold)
  const future = await readItem(serials.future)
  const invoices = uniqueBatches.size
    ? await db.query(
        `SELECT t.serial_number, t.metadata, t.created_by, bi.status, bi.approval, bi.invoice_number, bi.entered_by
         FROM public.transactions t
         LEFT JOIN public.batch_invoices bi ON bi.batch_id = t.batch_id
         WHERE t.batch_id = ANY($1::text[]) AND t.type = 'Sale'`,
        [batchIds],
      )
    : { rows: [] }
  const invoiceBySerial = new Map(invoices.rows.map((row) => [row.serial_number, row]))
  const soldInvoice = invoiceBySerial.get(serials.sold)
  const zeroInvoice = invoiceBySerial.get(serials.zero)
  const rentInvoice = invoiceBySerial.get(serials.rentSold)
  const openCase = await db.query(
    `SELECT kc.stage, kc.reason_category, kc.reason_text, kc.case_type
     FROM public.kit_cases kc
     JOIN public.inventory_items item ON item.id = kc.inventory_item_id
     WHERE item.serial_number = $1`,
    [serials.rentRet],
  )
  const rentalDays =
    (Date.parse(`${today}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / 86400000 + 1
  const oneEach = batchRows.rows.length === 5 && batchRows.rows.every((row) => row.n === 1)
  const caseRow = openCase.rows[0]
  if (
    resolved?.ok === true &&
    resolved.returned === 2 &&
    resolved.sold === 3 &&
    resolved.inspection === 1 &&
    resolved.awaiting_approval === 1 &&
    uniqueBatches.size === 5 &&
    oneEach &&
    ret?.status === "In Stock" &&
    ret.stock_pool === "demo" &&
    ret.location === "Warehouse A" &&
    ret.client == null &&
    pocSold?.status === "Sold" &&
    soldInvoice?.status === "invoiced" &&
    soldInvoice.invoice_number === INVOICE &&
    soldInvoice.metadata?.converted_from === "POC" &&
    soldInvoice.created_by === techId &&
    zero?.status === "Sold" &&
    zeroInvoice?.status === "not_invoiced" &&
    zeroInvoice.approval === "awaiting" &&
    zeroInvoice.entered_by === techId &&
    zeroInvoice.invoice_number == null &&
    rentRet?.status === "Pending Inspection" &&
    rentRet.stock_pool === "rental" &&
    rentRet.location === "Service Center" &&
    caseRow?.stage === "open" &&
    caseRow.case_type === "decommission" &&
    caseRow.reason_category === "Client cancelled" &&
    caseRow.reason_text === RETURN_REASON &&
    rentSold?.status === "Sold" &&
    rentSold.stock_pool === "rental" &&
    rentInvoice?.status === "pending" &&
    rentInvoice.metadata?.converted_from === "Rentals" &&
    rentInvoice.metadata?.rental_end === today &&
    Number(rentInvoice.metadata?.rental_days) === rentalDays &&
    future?.status === "POC"
  ) {
    pass("mixed", "one call returned, sold, opened a rental case, and recorded number, pending, and 00000 invoices")
  } else {
    fail(
      "mixed",
      JSON.stringify({
        resolved,
        ret,
        pocSold,
        zero,
        rentRet,
        rentSold,
        future,
        soldInvoice,
        zeroInvoice,
        rentInvoice,
        caseRow,
        batchRows: batchRows.rows,
        rentalDays,
      }),
    )
  }

  await setJwt(db, adminId)
  // Bulk batches share frozen now() with unstamped rows; push them past stamped setup.
  if (batchIds.length) {
    await db.query(
      `UPDATE public.transactions
       SET created_at = clock_timestamp()
       WHERE batch_id = ANY($1::text[])`,
      [batchIds],
    )
  }
  // Reverse only the bulk result batches, newest tip first.
  const tipBatches = await db.query(
    `SELECT batch_id,
            max(public.transaction_record_time(id, created_at, date)) AS rt
     FROM public.transactions
     WHERE batch_id = ANY($1::text[])
       AND type IS DISTINCT FROM 'Reversal'
       AND NOT public.batch_is_currently_reversed(batch_id)
     GROUP BY batch_id
     ORDER BY rt DESC, batch_id DESC`,
    [batchIds],
  )
  let reverseError = null
  for (const row of tipBatches.rows) {
    const sp = `sp_rev_${Math.random().toString(36).slice(2, 10)}`
    await db.query(`SAVEPOINT ${sp}`)
    try {
      await dropMovementPrev(db)
      await db.query(`SELECT public.reverse_quick_scan_batch($1, $2, NULL, '[]'::jsonb, '[]'::jsonb)`, [
        row.batch_id,
        REVERSE_REASON,
      ])
      await db.query(`RELEASE SAVEPOINT ${sp}`)
    } catch (error) {
      await db.query(`ROLLBACK TO SAVEPOINT ${sp}`)
      reverseError = `${row.batch_id}: ${error instanceof Error ? error.message : String(error)}`
      break
    }
  }
  const reversedFlags = batchIds.length
    ? await db.query(
        `SELECT batch_id, public.batch_is_currently_reversed(batch_id) AS reversed
         FROM unnest($1::text[]) AS batch_id`,
        [batchIds],
      )
    : { rows: [] }
  const restored = {
    ret: await readItem(serials.ret),
    sold: await readItem(serials.sold),
    zero: await readItem(serials.zero),
    rentRet: await readItem(serials.rentRet),
    rentSold: await readItem(serials.rentSold),
  }
  const allReversed =
    batchIds.length === 5 &&
    reversedFlags.rows.length === 5 &&
    reversedFlags.rows.every((row) => row.reversed === true)
  if (
    !reverseError &&
    allReversed &&
    restored.ret?.status === "POC" &&
    restored.ret.stock_pool === "sale" &&
    restored.sold?.status === "POC" &&
    restored.zero?.status === "POC" &&
    restored.rentRet?.status === "Rented" &&
    restored.rentRet.stock_pool === "rental" &&
    restored.rentSold?.status === "Rented" &&
    restored.rentSold.stock_pool === "rental"
  ) {
    pass("reverse", "each resulting batch reverses back to POC or Rented")
  } else {
    fail("reverse", JSON.stringify({ reverseError, reversedFlags: reversedFlags.rows, restored }))
  }
}

async function main() {
  const { ok, failed, passed } = await withHarness(
    { markers: MARKERS, timeoutMs: 300_000, label: "verify-076" },
    runChecks,
  )
  console.log(ok ? `\n${passed} passed` : `\n${failed} failed`)
  process.exitCode = ok ? 0 : 1
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-076-bulk-resolve-holdings.mjs")
if (isMain) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
