/**
 * Invoice states. Fixture kits and users are removed in finally.
 *
 * Usage: node scripts/verify-075-batch-invoices.mjs
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"

const require = createRequire(import.meta.url)
const { Client } = require("pg")
const { createClient } = require("@supabase/supabase-js")

const PREFIX = "INV075"
const REASON = "Complimentary kit, not invoiced"
const CHANGE_REASON = "Corrected the invoice number"
const REJECT_REASON = "Return this batch to pending"

const USERS = [
  ["verify-075-admin-a@test.local", "admin"],
  ["verify-075-admin-b@test.local", "admin"],
  ["verify-075-accounts@test.local", "accounts"],
  ["verify-075-tech@test.local", "technicians"],
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

function sameTotals(left, right) {
  return left.clients === right.clients && left.orders === right.orders && left.units === right.units && left.low === right.low && left.available === right.available
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
  const product = await db.query(
    `SELECT id, product_name FROM public.product_lines WHERE is_active ORDER BY id LIMIT 1`,
  )
  const productId = product.rows[0].id
  const productName = product.rows[0].product_name
  const today = (await db.query(
    `SELECT to_char((now() AT TIME ZONE 'Africa/Harare')::date, 'YYYY-MM-DD') AS today`,
  )).rows[0].today
  const ids = {}

  async function cleanup() {
    await db.query(
      `DELETE FROM public.batch_invoices
       WHERE batch_id LIKE $1
          OR batch_id IN (
            SELECT coalesce(nullif(btrim(batch_id), ''), id)
            FROM public.transactions
            WHERE serial_number LIKE $2 OR id LIKE $3
          )`,
      [`BATCH-${PREFIX}%`, `${PREFIX}%`, `TXN-${PREFIX}%`],
    )
    await db.query(
      `DELETE FROM public.transactions WHERE serial_number LIKE $1 OR id LIKE $2 OR batch_id LIKE $3`,
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

  async function inbound(serial) {
    const itemId = nextId("ITEM")
    await db.query(`SELECT public.apply_stock_movement('[]'::jsonb, $1::jsonb, $2::jsonb)`, [
      JSON.stringify([{
        id: itemId,
        product_id: productId,
        serial_number: serial,
        status: "In Stock",
        date_added: today,
        location: "Warehouse A",
        stock_pool: "sale",
      }]),
      JSON.stringify([{
        id: nextId("TXN"),
        type: "Inbound",
        serial_number: serial,
        item_name: productName,
        date: iso(today),
        client: "Internal",
        batch_id: nextId("BATCH"),
        to_location: "Warehouse A",
      }]),
    ])
  }

  async function sell(serial, actorId, extra) {
    const current = await db.query(
      `SELECT id FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
      [serial],
    )
    const txnId = nextId("TXN")
    const batchId = nextId("BATCH")
    await db.query(`SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`, [
      JSON.stringify([{
        id: current.rows[0].id,
        product_id: productId,
        serial_number: serial,
        status: "Sold",
        date_added: today,
        location: "Delivered",
        client: `${PREFIX} Holder`,
        stock_pool: "sale",
      }]),
      JSON.stringify([{
        id: txnId,
        type: "Sale",
        serial_number: serial,
        item_name: productName,
        date: iso(today),
        client: `${PREFIX} Holder`,
        invoice_number: extra.invoice_number ?? null,
        batch_id: batchId,
        created_by: actorId,
        metadata: extra.metadata,
      }]),
    ])
    return batchId
  }

  async function itemStatus(serial) {
    const row = await db.query(
      `SELECT status FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
      [serial],
    )
    return row.rows[0]?.status ?? null
  }

  async function invoiceRow(batchId) {
    const row = await db.query(`SELECT * FROM public.batch_invoices WHERE batch_id = $1`, [batchId])
    return row.rows[0] ?? null
  }

  await cleanup()
  const started = await snapshot(db)

  try {
    for (const [email, role] of USERS) {
      const created = await service.auth.admin.createUser({ email, email_confirm: true })
      if (created.error) throw new Error(created.error.message)
      ids[role === "admin" ? (email.includes("admin-a") ? "adminA" : "adminB") : role] = created.data.user.id
      await db.query(`UPDATE public.profiles SET role = $2::public.app_role, active = true WHERE id = $1`, [
        created.data.user.id,
        role,
      ])
    }
    const adminA = ids.adminA
    const adminB = ids.adminB
    const accounts = ids.accounts
    const tech = ids.technicians

    const backfill = await db.query(`
      SELECT
        count(*) FILTER (WHERE t.type = 'Sale' AND b.status = 'legacy_unreviewed')::int AS legacy_rows,
        count(*) FILTER (WHERE t.type = 'Sale' AND b.status = 'pending' AND b.legacy)::int AS pending_rows
      FROM public.active_transactions AS t
      JOIN public.batch_invoices AS b
        ON b.batch_id = coalesce(nullif(btrim(t.batch_id), ''), t.id)
      WHERE t.serial_number NOT LIKE $1
    `, [`${PREFIX}%`])
    const legacyRows = backfill.rows[0].legacy_rows
    const pendingRows = backfill.rows[0].pending_rows
    if (legacyRows === 217 && pendingRows === 253) {
      pass("backfill", "217 legacy_unreviewed sale rows and 253 pending legacy sale rows")
    } else {
      fail("backfill", `legacy ${legacyRows}, pending legacy ${pendingRows}`)
    }

    const serials = ["NUM", "PEND", "ZERO", "REJ", "CHG", "BAD", "BLANK", "SHORT"].map((name) => `${PREFIX}-${name}`)
    for (const serial of serials) await inbound(serial)

    await setUser(db, adminA)
    const numbered = await sell(`${PREFIX}-NUM`, adminA, {
      invoice_number: `${PREFIX}-1`,
      metadata: { invoice_choice: "number" },
    })
    const pending = await sell(`${PREFIX}-PEND`, adminA, {
      metadata: { invoice_choice: "pending" },
    })
    const zero = await sell(`${PREFIX}-ZERO`, adminA, {
      metadata: { invoice_choice: "not_invoiced", invoice_reason: REASON },
    })
    const numberedRow = await invoiceRow(numbered)
    const pendingRow = await invoiceRow(pending)
    const zeroRow = await invoiceRow(zero)
    const saleCount = await db.query(
      `SELECT count(*)::int AS n FROM public.transactions WHERE batch_id = $1 AND type = 'Sale'`,
      [numbered],
    )
    if (
      saleCount.rows[0].n === 1 &&
      numberedRow?.status === "invoiced" &&
      numberedRow.invoice_number === `${PREFIX}-1` &&
      pendingRow?.status === "pending" &&
      zeroRow?.status === "not_invoiced" &&
      zeroRow.approval === "awaiting" &&
      (await itemStatus(`${PREFIX}-NUM`)) === "Sold" &&
      (await itemStatus(`${PREFIX}-PEND`)) === "Sold" &&
      (await itemStatus(`${PREFIX}-ZERO`)) === "Sold"
    ) {
      pass("states", "number, pending, and 00000 each write one sale and the kit is sold immediately")
    } else {
      fail("states", JSON.stringify({ numberedRow, pendingRow, zeroRow, sales: saleCount.rows[0].n }))
    }

    const cases = await db.query(
      `SELECT count(*)::int AS n FROM public.kit_cases kc
       JOIN public.inventory_items item ON item.id = kc.inventory_item_id
       WHERE item.serial_number LIKE $1`,
      [`${PREFIX}%`],
    )
    if (cases.rows[0].n === 0) pass("no_case", "converting the invoice does not open a case")
    else fail("no_case", `${cases.rows[0].n} cases`)

    const placeholderMoves = [
      ["0000", "placeholder"],
      ["-", "placeholder"],
      ["N/A", "placeholder"],
      ["00000", "at least 15"],
    ]
    let placeholderOk = true
    for (const [number, needle] of placeholderMoves) {
      const message = await raises(
        db,
        `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
        [
          JSON.stringify([{
            id: (await db.query(`SELECT id FROM public.inventory_items WHERE serial_number = $1`, [`${PREFIX}-BAD`])).rows[0].id,
            product_id: productId,
            serial_number: `${PREFIX}-BAD`,
            status: "Sold",
            date_added: today,
            location: "Delivered",
            stock_pool: "sale",
          }]),
          JSON.stringify([{
            id: nextId("TXN"),
            type: "Sale",
            serial_number: `${PREFIX}-BAD`,
            item_name: productName,
            date: iso(today),
            client: `${PREFIX} Holder`,
            invoice_number: number,
            batch_id: nextId("BATCH"),
            created_by: adminA,
            metadata: number === "00000" ? { invoice_choice: "not_invoiced", invoice_reason: "short" } : { invoice_choice: "number" },
          }]),
        ],
        needle,
      )
      if (message) placeholderOk = false
    }
    const blankMessage = await raises(
      db,
      `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
      [
        JSON.stringify([{
          id: (await db.query(`SELECT id FROM public.inventory_items WHERE serial_number = $1`, [`${PREFIX}-BLANK`])).rows[0].id,
          product_id: productId,
          serial_number: `${PREFIX}-BLANK`,
          status: "Sold",
          date_added: today,
          location: "Delivered",
          stock_pool: "sale",
        }]),
        JSON.stringify([{
          id: nextId("TXN"),
          type: "Sale",
          serial_number: `${PREFIX}-BLANK`,
          item_name: productName,
          date: iso(today),
          client: `${PREFIX} Holder`,
          batch_id: nextId("BATCH"),
          created_by: adminA,
        }]),
      ],
      "Invoice pending",
    )
    if (placeholderOk && !blankMessage && (await itemStatus(`${PREFIX}-BAD`)) === "In Stock" && (await itemStatus(`${PREFIX}-BLANK`)) === "In Stock") {
      pass("placeholders", "placeholders, a short 00000 reason, and a blank invoice are rejected and stock stays")
    } else {
      fail("placeholders", blankMessage || "a placeholder was accepted")
    }

    const self = await raises(db, `SELECT public.approve_batch_invoice($1)`, [zero], "cannot approve an invoice you entered")
    if (!self) pass("self_approve", "the admin who entered 00000 cannot approve it")
    else fail("self_approve", self)

    const beforeApproval = await snapshot(db)
    const soldBefore = await itemStatus(`${PREFIX}-ZERO`)
    await setUser(db, adminB)
    await db.query(`SELECT public.approve_batch_invoice($1)`, [zero])
    const approved = await invoiceRow(zero)
    const afterApproval = await snapshot(db)
    if (
      approved?.approval === "approved" &&
      approved.approved_by === adminB &&
      soldBefore === "Sold" &&
      (await itemStatus(`${PREFIX}-ZERO`)) === "Sold" &&
      sameTotals(beforeApproval, afterApproval)
    ) {
      pass("approved", "another admin approves 00000 and the kit and live totals stay put")
    } else {
      fail("approved", JSON.stringify({ approved, soldBefore, beforeApproval, afterApproval }))
    }

    await setUser(db, adminA)
    const rejectedBatch = await sell(`${PREFIX}-REJ`, adminA, {
      metadata: { invoice_choice: "not_invoiced", invoice_reason: REASON },
    })
    await setUser(db, adminB)
    await db.query(`SELECT public.reject_batch_invoice($1, $2)`, [rejectedBatch, REJECT_REASON])
    const rejected = await invoiceRow(rejectedBatch)
    if (rejected?.status === "pending" && rejected.approval == null && (await itemStatus(`${PREFIX}-REJ`)) === "Sold") {
      pass("rejected", "rejection returns the batch to pending and leaves the kit sold")
    } else {
      fail("rejected", JSON.stringify(rejected))
    }

    await setUser(db, accounts)
    await db.query(`SELECT public.set_batch_invoice($1, 'number', $2, '')`, [rejectedBatch, `${PREFIX}-2`])
    const firstNumber = await invoiceRow(rejectedBatch)
    const shortChange = await raises(
      db,
      `SELECT public.set_batch_invoice($1, 'number', $2, 'too short')`,
      [rejectedBatch, `${PREFIX}-3`],
      "at least 15",
    )
    await db.query(`SELECT public.set_batch_invoice($1, 'number', $2, $3)`, [rejectedBatch, `${PREFIX}-3`, CHANGE_REASON])
    const changed = await invoiceRow(rejectedBatch)
    const events = await db.query(
      `SELECT new_status, new_invoice_number, reason FROM public.batch_invoice_events
       WHERE batch_id = $1 ORDER BY created_at`,
      [rejectedBatch],
    )
    const last = events.rows[events.rows.length - 1]
    if (
      firstNumber?.invoice_number === `${PREFIX}-2` &&
      !shortChange &&
      changed?.invoice_number === `${PREFIX}-3` &&
      last?.new_invoice_number === `${PREFIX}-3` &&
      last?.reason === CHANGE_REASON
    ) {
      pass("change_number", "the first number needs no reason; changing it needs a reason and writes history")
    } else {
      fail("change_number", JSON.stringify({ firstNumber, shortChange, changed, last, events: events.rows }))
    }

    await setUser(db, tech)
    const techBlocked = await raises(
      db,
      `SELECT public.set_batch_invoice($1, 'number', $2, $3)`,
      [numbered, `${PREFIX}-9`, CHANGE_REASON],
      "Only admin or accounts",
    )
    await setUser(db, accounts)
    const accountsApprove = await raises(db, `SELECT public.approve_batch_invoice($1)`, [zero], "Only an admin")
    if (!techBlocked && !accountsApprove) pass("roles", "a technician cannot change an invoice and accounts cannot approve")
    else fail("roles", techBlocked || accountsApprove || "role check missed")
  } catch (error) {
    fail("verify", error instanceof Error ? error.message : String(error))
  } finally {
    await cleanup()
    const residue = await db.query(
      `SELECT
         (SELECT count(*)::int FROM public.inventory_items WHERE serial_number LIKE $1) AS items,
         (SELECT count(*)::int FROM public.transactions WHERE serial_number LIKE $1 OR id LIKE $2) AS txns,
         (SELECT count(*)::int FROM public.batch_invoices WHERE batch_id LIKE $3) AS invoices,
         (SELECT count(*)::int FROM public.batch_invoice_events e
            WHERE NOT EXISTS (SELECT 1 FROM public.batch_invoices b WHERE b.batch_id = e.batch_id)) AS orphan_events`,
      [`${PREFIX}%`, `TXN-${PREFIX}%`, `BATCH-${PREFIX}%`],
    )
    const row = residue.rows[0]
    if (row.items === 0 && row.txns === 0 && row.invoices === 0 && row.orphan_events === 0) {
      pass("residue", "no fixture items, transactions, or invoices left")
    } else {
      fail("residue", JSON.stringify(row))
    }
    const ended = await snapshot(db)
    if (sameTotals(started, ended)) {
      pass("live_totals", `${ended.clients} clients / ${ended.orders} orders / ${ended.units} units, low ${ended.low}, available ${ended.available}`)
    } else {
      fail("live_totals", `started ${JSON.stringify(started)} ended ${JSON.stringify(ended)}`)
    }
    await Promise.race([db.end(), new Promise((resolve) => setTimeout(resolve, 2000))])
    const failed = Object.values(results).some((row) => row.result === "FAIL")
    process.exit(failed ? 1 : 0)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
