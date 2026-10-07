/**
 * Calls public.movement_result_status for every status × type, then converts a
 * POC to a Sale and extends a holding through the RPCs. Removes verify-p33b-*
 * rows and users in finally.
 *
 * Requires .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
 *   SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL or DATABASE_URL
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"
import { createClient } from "@supabase/supabase-js"
import { ITEM_STATUSES, MOVEMENT_TYPES, movementResult } from "../lib/movement-transitions.mjs"

const require = createRequire(import.meta.url)
const { prepareVerifyEnv } = require("./verify-env.cjs")
const EMAIL_PREFIX = "verify-p33b-"
const ROLES = ["admin", "sales", "accounts", "technicians", "viewer"]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function addDays(ymd, days) {
  const [year, month, day] = ymd.split("-").map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

async function main() {
  prepareVerifyEnv()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
  assert(url, "Missing NEXT_PUBLIC_SUPABASE_URL")
  assert(anonKey, "Missing NEXT_PUBLIC_SUPABASE_ANON_KEY")
  assert(serviceKey, "Missing SUPABASE_SERVICE_ROLE_KEY")
  assert(dbUrl, "Missing SUPABASE_DB_URL or DATABASE_URL")

  const pg = require("pg")
  const db = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
  await db.connect()
  const service = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const clients = {}
  const serials = []

  async function deleteFixtureUsers() {
    const { rows } = await db.query(`SELECT id::text AS id FROM public.profiles WHERE email LIKE $1`, [
      `${EMAIL_PREFIX}%`,
    ])
    for (const row of rows) {
      const { error } = await service.auth.admin.deleteUser(row.id)
      if (error && !/not found/i.test(error.message)) throw new Error(error.message)
    }
  }

  async function deleteFixtures() {
    if (serials.length === 0) {
      const { rows } = await db.query(
        `SELECT serial_number FROM public.inventory_items WHERE serial_number LIKE 'VERIFY-P33B-%'`
      )
      for (const row of rows) serials.push(row.serial_number)
    }
    if (serials.length > 0) {
      await db.query(`DELETE FROM public.transactions WHERE serial_number = ANY($1::text[])`, [serials])
      await db.query(
        `DELETE FROM public.holding_extensions WHERE serial_number = ANY($1::text[])`,
        [serials]
      )
      await db.query(`DELETE FROM public.inventory_items WHERE serial_number = ANY($1::text[])`, [serials])
    }
  }

  async function createUser(role) {
    const email = `${EMAIL_PREFIX}${role}@test.local`
    const { data, error } = await service.auth.admin.createUser({ email, email_confirm: true })
    if (error) throw new Error(`createUser(${email}): ${error.message}`)
    await db.query(
      `UPDATE public.profiles SET role = $2::public.app_role, active = true WHERE id = $1`,
      [data.user.id, role]
    )
    const client = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
    const { data: link, error: linkError } = await service.auth.admin.generateLink({ type: "magiclink", email })
    if (linkError) throw new Error(linkError.message)
    const { error: signInError } = await client.auth.verifyOtp({
      token_hash: link.properties.hashed_token,
      type: "magiclink",
    })
    if (signInError) throw new Error(signInError.message)
    clients[role] = client
    return data.user.id
  }

  async function pairResult(status, type) {
    await db.query("BEGIN")
    try {
      const { rows } = await db.query(`SELECT public.movement_result_status($1, $2) AS status`, [status, type])
      await db.query("COMMIT")
      return rows[0].status
    } catch (error) {
      await db.query("ROLLBACK")
      return { raised: error.message }
    }
  }

  try {
    await deleteFixtures()
    await deleteFixtureUsers()
    for (const role of ROLES) await createUser(role)

    let mismatches = 0
    for (const status of ITEM_STATUSES) {
      for (const type of MOVEMENT_TYPES) {
        const expected = movementResult(status, type)
        const actual = await pairResult(status, type)
        const raised = typeof actual === "object"
        if (expected == null) {
          if (!raised || !String(actual.raised).includes("Invalid movement")) {
            mismatches += 1
            console.log(`FAIL  ${type} from ${status} — ${JSON.stringify(actual)}`)
          }
        } else if (actual !== expected) {
          mismatches += 1
          console.log(`FAIL  ${type} from ${status} — expected ${expected}, got ${JSON.stringify(actual)}`)
        }
      }
    }
    assert(mismatches === 0, `${mismatches} matrix pairs disagreed`)
    console.log(`PASS  matrix — ${ITEM_STATUSES.length * MOVEMENT_TYPES.length} pairs`)

    const { rows: products } = await db.query(
      `SELECT id FROM public.product_lines WHERE is_active ORDER BY id LIMIT 1`
    )
    assert(products[0], "No product line to attach the fixture")
    const productId = products[0].id
    const today = new Date().toISOString().slice(0, 10)
    const overdue = addDays(today, -10)
    const dueSoon = addDays(today, 6)
    const saleSerial = `VERIFY-P33B-SALE-${Date.now()}`
    const extendSerial = `VERIFY-P33B-EXT-${Date.now()}`
    serials.push(saleSerial, extendSerial)

    await db.query(
      `INSERT INTO public.inventory_items (
         id, product_id, serial_number, status, date_added, location, client, assigned_to, poc_out_date, return_date
       ) VALUES
       ($1, $2, $3, 'POC', $4, 'Client Site', 'Acme Holder', 'Acme Holder', '2026-06-01', $5),
       ($6, $2, $7, 'POC', $4, 'Client Site', 'Extend Holder', 'Extend Holder', '2026-06-01', $5)`,
      [`item-${saleSerial}`, productId, saleSerial, today, overdue, `item-${extendSerial}`, extendSerial]
    )

    const saleItem = (
      await db.query(`SELECT * FROM public.inventory_items WHERE serial_number = $1`, [saleSerial])
    ).rows[0]
    const { error: badSale } = await clients.technicians.rpc("apply_stock_movement", {
      p_inventory_upserts: [{ ...saleItem, status: "Sold" }],
      p_inventory_inserts: [],
      p_transactions: [
        {
          id: `txn-bad-${saleSerial}`,
          type: "Rentals",
          serial_number: saleSerial,
          item_name: "Fixture",
          client: "Acme Holder",
          date: `${today}T00:00:00.000Z`,
          created_by: null,
        },
      ],
    })
    assert(badSale && /Invalid movement/i.test(badSale.message), `Rentals from POC should raise, got ${badSale?.message}`)
    console.log("PASS  invalid transition via apply_stock_movement")

    const { rows: beforeSale } = await db.query(
      `SELECT count(*)::int AS n FROM public.inventory_items WHERE deleted_at IS NULL AND status = 'POC'`
    )
    const { error: saleError } = await clients.technicians.rpc("apply_stock_movement", {
      p_inventory_upserts: [
        {
          ...saleItem,
          status: "Sold",
          location: "Client Site",
          return_date: null,
          client: "Acme Holder",
          poc_out_date: "2026-06-01",
        },
      ],
      p_inventory_inserts: [],
      p_transactions: [
        {
          id: `txn-${saleSerial}`,
          type: "Sale",
          serial_number: saleSerial,
          item_name: "Fixture",
          client: "Acme Holder",
          date: `${today}T00:00:00.000Z`,
          invoice_number: null,
          metadata: { converted_from: "POC", poc_out_date: "2026-06-01" },
          created_by: null,
        },
      ],
    })
    assert(!saleError, saleError?.message ?? "sale failed")

    const sold = (await db.query(`SELECT status, location, client, return_date, poc_out_date FROM public.inventory_items WHERE serial_number = $1`, [saleSerial])).rows[0]
    assert(sold.status === "Sold", `status ${sold.status}`)
    assert(sold.location === "Client Site", `converted location ${sold.location}`)
    assert(sold.client === "Acme Holder", `client ${sold.client}`)
    assert(sold.return_date == null, "return_date should be cleared")
    assert(sold.poc_out_date === "2026-06-01", `poc_out_date ${sold.poc_out_date}`)
    const txn = (
      await db.query(`SELECT type, metadata FROM public.transactions WHERE serial_number = $1 AND type = 'Sale'`, [saleSerial])
    ).rows[0]
    assert(txn.metadata.converted_from === "POC", "missing converted_from")
    assert(txn.metadata.poc_out_date === "2026-06-01", "missing poc_out_date")

    const { rows: afterPoc } = await db.query(
      `SELECT count(*)::int AS n FROM public.inventory_items WHERE deleted_at IS NULL AND status = 'POC'`
    )
    assert(afterPoc[0].n === beforeSale[0].n - 1, `POC count ${beforeSale[0].n} -> ${afterPoc[0].n}`)

    const { data: dispatched, error: dispatchedError } = await clients.technicians.rpc("dispatched_page", {
      p_limit: 10,
      p_offset: 0,
      p_movement: "Sale",
      p_search: saleSerial,
    })
    assert(!dispatchedError, dispatchedError?.message ?? "dispatched failed")
    const dispatchedText = JSON.stringify(dispatched)
    assert(dispatchedText.includes(saleSerial), "serial missing from Dispatched")
    assert(dispatchedText.includes('"movement":"Sale"') || dispatchedText.includes('"movement": "Sale"'), "not a sale in Dispatched")
    console.log("PASS  POC → Sale")

    const { error: viewerExtend } = await clients.viewer.rpc("extend_holding", {
      p_item_id: `item-${extendSerial}`,
      p_new_date: dueSoon,
      p_reason: "viewer should fail",
    })
    assert(viewerExtend, "viewer extend should fail")
    const { error: salesExtend } = await clients.sales.rpc("extend_holding", {
      p_item_id: `item-${extendSerial}`,
      p_new_date: dueSoon,
      p_reason: "sales should fail",
    })
    assert(salesExtend, "sales extend should fail")

    const { error: extendError } = await clients.technicians.rpc("extend_holding", {
      p_item_id: `item-${extendSerial}`,
      p_new_date: dueSoon,
      p_reason: "Customer asked for another week",
    })
    assert(!extendError, extendError?.message ?? "extend failed")
    const extended = (
      await db.query(`SELECT return_date FROM public.inventory_items WHERE serial_number = $1`, [extendSerial])
    ).rows[0]
    assert(extended.return_date === dueSoon, `return_date ${extended.return_date}`)
    const audit = (
      await db.query(
        `SELECT previous_date, new_date, reason, holding_type FROM public.holding_extensions WHERE serial_number = $1`,
        [extendSerial]
      )
    ).rows[0]
    assert(audit.previous_date === overdue, `previous ${audit.previous_date}`)
    assert(audit.new_date === dueSoon, `new ${audit.new_date}`)
    assert(audit.holding_type === "POC", audit.holding_type)
    assert(overdue < today && dueSoon <= addDays(today, 14) && dueSoon >= today, "fixture should move overdue to due soon")
    console.log("PASS  extend holding")

    const stamp = Date.now()
    const stockSerial = `VERIFY-P33B-STOCK-${stamp}`
    const loanSerial = `VERIFY-P33B-LOAN-${stamp}`
    const pocTransferSerial = `VERIFY-P33B-XFER-POC-${stamp}`
    const rentTransferSerial = `VERIFY-P33B-XFER-RENT-${stamp}`
    const maintSerial = `VERIFY-P33B-MAINT-${stamp}`
    serials.push(stockSerial, loanSerial, pocTransferSerial, rentTransferSerial, maintSerial)
    await db.query(
      `INSERT INTO public.inventory_items (
         id, product_id, serial_number, status, date_added, location, client, assigned_to, return_date
       ) VALUES
       ($1, $2, $3, 'In Stock', $4, 'Warehouse A', NULL, NULL, NULL),
       ($5, $2, $6, 'In Stock', $4, 'Warehouse A', NULL, NULL, NULL),
       ($7, $2, $8, 'POC', $4, 'Client Site', 'Site Holder', 'Site Holder', $9),
       ($10, $2, $11, 'Rented', $4, 'Client Site', 'Rent Holder', 'Rent Holder', $9),
       ($12, $2, $13, 'In Stock', $4, 'Warehouse A', NULL, NULL, NULL)`,
      [
        `item-${stockSerial}`, productId, stockSerial, today,
        `item-${loanSerial}`, loanSerial,
        `item-${pocTransferSerial}`, pocTransferSerial, overdue,
        `item-${rentTransferSerial}`, rentTransferSerial,
        `item-${maintSerial}`, maintSerial,
      ]
    )

    async function loadItem(serial) {
      const { rows } = await db.query(`SELECT * FROM public.inventory_items WHERE serial_number = $1`, [serial])
      return rows[0]
    }
    async function applyMove(itemRow, type, status, location) {
      return clients.technicians.rpc("apply_stock_movement", {
        p_inventory_upserts: [{ ...itemRow, status, location: location ?? itemRow.location }],
        p_inventory_inserts: [],
        p_transactions: [
          {
            id: `txn-${type}-${itemRow.serial_number}`,
            type,
            serial_number: itemRow.serial_number,
            item_name: "Fixture",
            client: itemRow.client ?? "Verify Client",
            date: `${today}T00:00:00.000Z`,
            from_location: type === "Transfer" ? itemRow.location : null,
            to_location: type === "Transfer" ? location : null,
            created_by: null,
          },
        ],
      })
    }

    const stockItem = await loadItem(stockSerial)
    const { error: stockSaleError } = await applyMove(stockItem, "Sale", "Sold", "Delivered")
    assert(!stockSaleError, stockSaleError?.message ?? "normal sale failed")
    const stockSold = await loadItem(stockSerial)
    assert(stockSold.status === "Sold" && stockSold.location === "Delivered", `normal sale location ${stockSold.location}`)
    console.log("PASS  normal Sale location Delivered")

    const loanItem = await loadItem(loanSerial)
    const { error: loanError } = await applyMove(loanItem, "Remediation Loaner Issue", "Sold", "Delivered")
    assert(!loanError, loanError?.message ?? "loaner issue failed")
    const loaned = await loadItem(loanSerial)
    assert(loaned.status === "Sold", `loaner status ${loaned.status}`)
    const { error: loanReturnError } = await applyMove(loaned, "Sale Return", "RMA Hold", "Warehouse A")
    assert(!loanReturnError, loanReturnError?.message ?? "loaner return failed")
    const loanReturned = await loadItem(loanSerial)
    assert(loanReturned.status === "RMA Hold", `loaner return status ${loanReturned.status}`)
    const { error: loanAgain } = await applyMove(loanReturned, "Remediation Loaner Issue", "Sold", "Delivered")
    assert(loanAgain && /Invalid movement/i.test(loanAgain.message), `loaner from RMA Hold should raise, got ${loanAgain?.message}`)
    console.log("PASS  loaner issue and return")

    for (const [serial, movement] of [
      [pocTransferSerial, "POC Out"],
      [rentTransferSerial, "Rentals"],
    ]) {
      const before = await loadItem(serial)
      const { error } = await applyMove(before, "Transfer", before.status, "Warehouse B")
      assert(!error, error?.message ?? `transfer ${serial} failed`)
      const after = await loadItem(serial)
      assert(after.status === before.status, `transfer changed status ${before.status} -> ${after.status}`)
      assert(after.location === "Warehouse B", `transfer location ${after.location}`)
      const { data: page, error: pageError } = await clients.technicians.rpc("dispatched_page", {
        p_limit: 5,
        p_offset: 0,
        p_movement: movement,
        p_search: serial,
      })
      assert(!pageError, pageError?.message ?? "dispatched failed")
      assert(JSON.stringify(page).includes(serial), `${serial} left Dispatched`)
      const { rows: stillOut } = await db.query(
        `SELECT count(*)::int AS n FROM public.inventory_items
         WHERE serial_number = $1 AND deleted_at IS NULL
           AND status IN ('POC', 'Rented')
           AND return_date IS NOT NULL AND return_date <> '' AND return_date < $2`,
        [serial, today]
      )
      assert(stillOut[0].n === 1, `${serial} left the overdue alert set`)
    }
    console.log("PASS  transfer from POC and Rented")

    await db.query("BEGIN")
    let blocked = null
    try {
      await db.query(`UPDATE public.inventory_items SET status = 'Maintenance' WHERE serial_number = $1`, [maintSerial])
    } catch (error) {
      blocked = error
    }
    await db.query("ROLLBACK")
    assert(blocked && /Invalid inventory status transition/i.test(blocked.message), blocked?.message ?? "ungated Maintenance write succeeded")

    const maintItem = await loadItem(maintSerial)
    const { error: fakeMaint } = await applyMove(maintItem, "Sale", "Maintenance", "Service Center")
    assert(fakeMaint && /Invalid movement/i.test(fakeMaint.message), `Sale cannot enter Maintenance, got ${fakeMaint?.message}`)

    await db.query("BEGIN")
    await db.query(`SELECT set_config('app.quick_scan_reversal', 'on', true)`)
    await db.query(`UPDATE public.inventory_items SET status = 'Maintenance' WHERE serial_number = $1`, [maintSerial])
    await db.query("COMMIT")
    const inMaintenance = await loadItem(maintSerial)
    assert(inMaintenance.status === "Maintenance", inMaintenance.status)
    const { error: backError } = await applyMove(inMaintenance, "Inbound", "In Stock", "Warehouse A")
    assert(!backError, backError?.message ?? "Inbound from Maintenance failed")
    const repaired = await loadItem(maintSerial)
    assert(repaired.status === "In Stock", `exit status ${repaired.status}`)
    console.log("PASS  Maintenance only via reversal")
  } finally {
    await deleteFixtures().catch((error) => console.error(error))
    await deleteFixtureUsers().catch((error) => console.error(error))
    const { rows: leftoverItems } = await db.query(
      `SELECT count(*)::int AS n FROM public.inventory_items WHERE serial_number LIKE 'VERIFY-P33B-%'`
    )
    const { rows: leftoverUsers } = await db.query(
      `SELECT count(*)::int AS n FROM public.profiles WHERE email LIKE $1`,
      [`${EMAIL_PREFIX}%`]
    )
    console.log(`residue items=${leftoverItems[0].n} users=${leftoverUsers[0].n}`)
    assert(leftoverItems[0].n === 0 && leftoverUsers[0].n === 0, "fixture residue remains")
    await db.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
