/**
 * Bulk resolve overdue kits. Fixture kits and users are removed in finally.
 *
 * Usage: node scripts/verify-076-bulk-resolve-holdings.mjs
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"

const require = createRequire(import.meta.url)
const { Client } = require("pg")
const { createClient } = require("@supabase/supabase-js")

const PREFIX = "OB1076"
const HOLDER = "OB1076 Holder"
const INVOICE = "OB1076-INV-1"
const ZERO_REASON = "Complimentary kit, not invoiced"
const RETURN_REASON = "Client ended the rental early"
const REVERSE_REASON = "OB1 verify reversal reason"

const USERS = [
  ["verify-076-admin@test.local", "admin"],
  ["verify-076-tech@test.local", "technicians"],
  ["verify-076-sales@test.local", "sales"],
]

function loadEnvLocal() {
  const envPath = path.join(process.cwd(), ".env.local")
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value
  }
}

const results = {}
function pass(name, reason) {
  results[name] = { result: "PASS", reason }
  console.log(`PASS  ${name} — ${reason}`)
}
function fail(name, reason) {
  results[name] = { result: "FAIL", reason }
  console.log(`FAIL  ${name} — ${reason}`)
}

async function raises(db, sql, params, needle) {
  try {
    await db.query(sql, params)
    return `expected ${needle}`
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return message.includes(needle) ? null : message
  }
}

async function setUser(db, userId) {
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [userId])
  await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: userId, role: "authenticated" }),
  ])
}

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

async function snapshot(db) {
  const sales = await db.query(
    `SELECT count(*)::int AS clients, COALESCE(sum(orders), 0)::int AS orders, COALESCE(sum(units), 0)::int AS units
     FROM public.client_sale_dispatch_counts()`,
  )
  const low = await db.query(
    `SELECT count(*) FILTER (WHERE is_low)::int AS low, COALESCE(sum(in_stock_count), 0)::int AS available
     FROM public.low_stock_products`,
  )
  return {
    clients: sales.rows[0].clients,
    orders: sales.rows[0].orders,
    units: sales.rows[0].units,
    low: low.rows[0].low,
    available: low.rows[0].available,
  }
}

async function main() {
  loadEnvLocal()
  const db = new Client({
    connectionString: process.env.SUPABASE_DB_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  })
  await db.connect()
  const service = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const star = await db.query(
    `SELECT id, product_name FROM public.product_lines WHERE vendor = 'Starlink' AND is_active ORDER BY id LIMIT 1`,
  )
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
  const ids = {}

  const serials = {
    ret: `${PREFIX}-POC-RET`,
    sold: `${PREFIX}-POC-SOLD`,
    zero: `${PREFIX}-POC-ZERO`,
    rentRet: `${PREFIX}-RENT-RET`,
    rentSold: `${PREFIX}-RENT-SOLD`,
    future: `${PREFIX}-FUTURE`,
  }

  async function cleanup() {
    await db.query(`ALTER TABLE public.kit_case_events DISABLE TRIGGER tr_kit_case_events_append_only`)
    try {
      await db.query(
        `DELETE FROM public.kit_case_events WHERE case_id IN (
           SELECT kc.id FROM public.kit_cases kc
           JOIN public.inventory_items item ON item.id = kc.inventory_item_id
           WHERE item.serial_number LIKE $1
         )`,
        [`${PREFIX}%`],
      )
    } finally {
      await db.query(`ALTER TABLE public.kit_case_events ENABLE TRIGGER tr_kit_case_events_append_only`)
    }
    await db.query(
      `DELETE FROM public.kit_cases WHERE inventory_item_id IN (
         SELECT id FROM public.inventory_items WHERE serial_number LIKE $1
       )`,
      [`${PREFIX}%`],
    )
    await db.query(
      `DELETE FROM public.batch_restores
       WHERE batch_id LIKE $1
          OR batch_id IN (SELECT batch_id FROM public.transactions WHERE serial_number LIKE $2)`,
      [`BATCH-${PREFIX}%`, `${PREFIX}%`],
    )
    await db.query(
      `DELETE FROM public.batch_reversals
       WHERE batch_id LIKE $1
          OR batch_id IN (SELECT batch_id FROM public.transactions WHERE serial_number LIKE $2)`,
      [`BATCH-${PREFIX}%`, `${PREFIX}%`],
    )
    await db.query(
      `DELETE FROM public.batch_invoices
       WHERE batch_id LIKE $1
          OR invoice_number LIKE $2
          OR batch_id IN (
            SELECT coalesce(nullif(btrim(batch_id), ''), id)
            FROM public.transactions
            WHERE serial_number LIKE $3 OR id LIKE $4 OR batch_id LIKE $1
          )`,
      [`BATCH-${PREFIX}%`, `${PREFIX}%`, `${PREFIX}%`, `TXN-${PREFIX}%`],
    )
    await db.query(
      `DELETE FROM public.transactions
       WHERE serial_number LIKE $1 OR id LIKE $2 OR batch_id LIKE $3`,
      [`${PREFIX}%`, `TXN-${PREFIX}%`, `BATCH-${PREFIX}%`],
    )
    await db.query(`DELETE FROM public.inventory_items WHERE serial_number LIKE $1 OR id LIKE $2`, [
      `${PREFIX}%`,
      `ITEM-${PREFIX}%`,
    ])
    const users = await db.query(`SELECT id::text AS id FROM auth.users WHERE email = ANY($1::text[])`, [
      USERS.map(([email]) => email),
    ])
    for (const row of users.rows) {
      const { error } = await service.auth.admin.deleteUser(row.id)
      if (error && !/not found/i.test(error.message)) throw error
    }
  }

  async function move(serial, type, status, location, extra = {}) {
    const current = await db.query(
      `SELECT id FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
      [serial],
    )
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
          id: nextId("TXN"),
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
  }

  async function inbound(serial) {
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
          id: nextId("TXN"),
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
    const result = await db.query(`SELECT public.bulk_resolve_holdings($1::jsonb) AS result`, [JSON.stringify(rows)])
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

  await cleanup()
  const started = await snapshot(db)

  try {
    for (const [email, role] of USERS) {
      const created = await service.auth.admin.createUser({ email, email_confirm: true })
      if (created.error) throw new Error(created.error.message)
      ids[role] = created.data.user.id
      const profile = await db.query(
        `UPDATE public.profiles SET role = $2::public.app_role, active = true WHERE id = $1`,
        [created.data.user.id, role],
      )
      if (profile.rowCount !== 1) throw new Error(`${role} profile was not updated`)
    }
    await setUser(db, ids.admin)

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

    await setUser(db, ids.sales)
    const denied = await raises(
      db,
      `SELECT public.bulk_resolve_holdings($1::jsonb)`,
      [JSON.stringify([returned(serials.ret, today, { return_pool: "sale" })])],
      "permission",
    )
    const afterDenied = await readItem(serials.ret)
    if (denied) fail("permissions", denied)
    else if (afterDenied?.status !== "POC") fail("permissions", JSON.stringify(afterDenied))
    else pass("permissions", "a sales user cannot resolve, and the kit stays on POC")

    await setUser(db, ids.technicians)
    const beforeDates = await txnCount()
    const tooEarly = await resolve([returned(serials.ret, beforeDispatch, { return_pool: "sale" })])
    const beforeLast = await resolve([returned(serials.ret, start, { return_pool: "sale" })])
    const tooLate = await resolve([returned(serials.ret, tomorrow, { return_pool: "sale" })])
    const noPool = await resolve([returned(serials.ret, today)])
    const notOverdue = await resolve([returned(serials.future, today, { return_pool: "sale" })])
    const stillPoc = await readItem(serials.ret)
    const dateMessages = [messagesFor(tooEarly, serials.ret), messagesFor(beforeLast, serials.ret), messagesFor(tooLate, serials.ret)]
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
        JSON.stringify({ tooEarly, beforeLast, tooLate, noPool, notOverdue, stillPoc, txns: await txnCount(), beforeDates }),
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
    const rentalDays = (Date.parse(`${today}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / 86400000 + 1
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
      soldInvoice.created_by === ids.technicians &&
      zero?.status === "Sold" &&
      zeroInvoice?.status === "not_invoiced" &&
      zeroInvoice.approval === "awaiting" &&
      zeroInvoice.entered_by === ids.technicians &&
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

    await setUser(db, ids.admin)
    let reverseError = null
    for (const batchId of batchIds) {
      try {
        await db.query(
          `SELECT public.reverse_quick_scan_batch($1, $2, NULL, '[]'::jsonb, '[]'::jsonb)`,
          [batchId, REVERSE_REASON],
        )
      } catch (error) {
        reverseError = `${batchId}: ${error instanceof Error ? error.message : String(error)}`
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
  } catch (error) {
    fail("fixtures", error instanceof Error ? error.message : String(error))
  } finally {
    await cleanup()
    const residue = await db.query(
      `SELECT
         (SELECT count(*)::int FROM public.transactions WHERE serial_number LIKE $1 OR id LIKE $2) AS txns,
         (SELECT count(*)::int FROM public.inventory_items WHERE serial_number LIKE $1) AS items,
         (SELECT count(*)::int FROM public.kit_cases kc
            JOIN public.inventory_items item ON item.id = kc.inventory_item_id
            WHERE item.serial_number LIKE $1) AS cases,
         (SELECT count(*)::int FROM public.batch_invoices WHERE invoice_number LIKE $3) AS invoices,
         (SELECT count(*)::int FROM auth.users WHERE email = ANY($4::text[])) AS users`,
      [`${PREFIX}%`, `TXN-${PREFIX}%`, `${PREFIX}%`, USERS.map(([email]) => email)],
    )
    const left = residue.rows[0]
    if (left.txns === 0 && left.items === 0 && left.cases === 0 && left.invoices === 0 && left.users === 0) {
      pass("residue", "no fixture rows left")
    } else fail("residue", JSON.stringify(left))
    const after = await snapshot(db)
    if (
      after.clients === started.clients &&
      after.orders === started.orders &&
      after.units === started.units &&
      after.low === started.low &&
      after.available === started.available
    ) {
      pass("live_totals", `${after.clients} clients / ${after.orders} orders / ${after.units} units; low ${after.low}; available ${after.available}`)
    } else fail("live_totals", JSON.stringify({ started, after }))
  }

  await Promise.race([db.end(), new Promise((resolve) => setTimeout(resolve, 2000))])
  process.exit(Object.values(results).some((row) => row.result === "FAIL") ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
