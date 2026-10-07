/**
 * Convert a rental to a sale. Fixture kits are removed in finally.
 *
 * Usage: node scripts/verify-074-rental-to-sale.mjs
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"

const require = createRequire(import.meta.url)
const { Client } = require("pg")
const { createClient } = require("@supabase/supabase-js")
const { prepareVerifyEnv } = require("./verify-env.cjs")

const PREFIX = "RS1074"
const HOLDER = "RS1074 Holder"
const INVOICE = "RS1074-INV"
const REVERSE_REASON = "RS1 verify reversal reason"
const RESTORE_REASON = "RS1 verify restore reason"

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
  prepareVerifyEnv()
  const db = new Client({
    connectionString: process.env.SUPABASE_DB_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  })
  await db.connect()
  const service = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const adminEmail = "verify-074-admin@test.local"
  const star = await db.query(
    `SELECT id, product_name FROM public.product_lines WHERE vendor = 'Starlink' AND is_active ORDER BY id LIMIT 1`,
  )
  const other = await db.query(
    `SELECT id, product_name FROM public.product_lines WHERE vendor IS DISTINCT FROM 'Starlink' AND is_active ORDER BY id LIMIT 1`,
  )
  const client = await db.query(`SELECT id FROM public.clients ORDER BY id LIMIT 1`)
  const days = await db.query(
    `SELECT to_char((now() AT TIME ZONE 'Africa/Harare')::date, 'YYYY-MM-DD') AS today,
            to_char((now() AT TIME ZONE 'Africa/Harare')::date - 4, 'YYYY-MM-DD') AS start,
            to_char((now() AT TIME ZONE 'Africa/Harare')::date - 2, 'YYYY-MM-DD') AS ending,
            to_char((now() AT TIME ZONE 'Africa/Harare')::date + 1, 'YYYY-MM-DD') AS tomorrow,
            to_char((now() AT TIME ZONE 'Africa/Harare')::date + 20, 'YYYY-MM-DD') AS due`,
  )
  const { today, start, ending, tomorrow, due } = days.rows[0]
  const clientId = client.rows[0].id
  const starId = star.rows[0].id
  const starName = star.rows[0].product_name
  const otherId = other.rows[0].id
  let adminId = null

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
          OR batch_id IN (
            SELECT coalesce(nullif(btrim(batch_id), ''), id)
            FROM public.transactions
            WHERE serial_number LIKE $2 OR id LIKE $3 OR batch_id LIKE $1
          )`,
      [`BATCH-${PREFIX}%`, `${PREFIX}%`, `TXN-${PREFIX}%`],
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
    const users = await db.query(`SELECT id::text AS id FROM auth.users WHERE email = $1`, [adminEmail])
    for (const row of users.rows) {
      const { error } = await service.auth.admin.deleteUser(row.id)
      if (error && !/not found/i.test(error.message)) throw error
    }
  }

  async function move(serial, productId, productName, type, status, location, extra = {}) {
    const current = await db.query(
      `SELECT id FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
      [serial],
    )
    const txnId = extra.txnId ?? nextId("TXN")
    const batchId = extra.batchId ?? nextId("BATCH")
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
    return { txnId, batchId }
  }

  async function inbound(serial, productId, productName) {
    const itemId = nextId("ITEM")
    const txnId = nextId("TXN")
    const batchId = nextId("BATCH")
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
    return { itemId }
  }

  await cleanup()
  const started = await snapshot(db)

  try {
    const created = await service.auth.admin.createUser({ email: adminEmail, email_confirm: true })
    if (created.error) throw new Error(created.error.message)
    adminId = created.data.user.id
    const profile = await db.query(
      `UPDATE public.profiles SET role = 'admin'::public.app_role, active = true WHERE id = $1`,
      [adminId],
    )
    if (profile.rowCount !== 1) throw new Error("admin profile was not updated")
    await setUser(db, adminId)

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
      invoice_number: "RS1074-RENT",
    })

    const earlyEnd = await raises(
      db,
      `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
      [
        JSON.stringify([
          {
            id: (await db.query(`SELECT id FROM public.inventory_items WHERE serial_number = $1`, [serial])).rows[0].id,
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

    const futureEnd = await raises(
      db,
      `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
      [
        JSON.stringify([
          {
            id: (await db.query(`SELECT id FROM public.inventory_items WHERE serial_number = $1`, [serial])).rows[0].id,
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

    const earlySale = await raises(
      db,
      `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
      [
        JSON.stringify([
          {
            id: (await db.query(`SELECT id FROM public.inventory_items WHERE serial_number = $1`, [serial])).rows[0].id,
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
    const notRented = await raises(
      db,
      `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
      [
        JSON.stringify([
          {
            id: (await db.query(`SELECT id FROM public.inventory_items WHERE serial_number = $1`, [plain])).rows[0].id,
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
    const notStarlink = await raises(
      db,
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
         (SELECT count(*)::int FROM auth.users WHERE email = $3) AS users`,
      [`${PREFIX}%`, `TXN-${PREFIX}%`, adminEmail],
    )
    const left = residue.rows[0]
    if (left.txns === 0 && left.items === 0 && left.cases === 0 && left.users === 0) {
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
