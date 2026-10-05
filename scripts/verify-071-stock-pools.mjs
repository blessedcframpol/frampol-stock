/**
 * Stock pools. Fixture kits are removed in finally. Live kits stay sale.
 *
 * Usage: node scripts/verify-071-stock-pools.mjs
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"

const require = createRequire(import.meta.url)
const { Client } = require("pg")
const { createClient } = require("@supabase/supabase-js")

const PREFIX = "P1071"
const DATE = "2026-10-05T00:00:00.000Z"
const REASON = "P1 verify group change"
const SHORT = "too short"
const REVERSE_REASON = "P1 verify reverse pool"
const RESTORE_REASON = "P1 verify restore pool"

function loadEnvLocal() {
  const envPath = path.join(process.cwd(), ".env.local")
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
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

async function snapshot(db) {
  const sales = await db.query(
    `SELECT count(*)::int AS clients, COALESCE(sum(orders), 0)::int AS orders, COALESCE(sum(units), 0)::int AS units
     FROM public.client_sale_dispatch_counts()`
  )
  const low = await db.query(
    `SELECT count(*) FILTER (WHERE is_low)::int AS low, COALESCE(sum(in_stock_count), 0)::int AS available
     FROM public.low_stock_products`
  )
  const marked = await db.query(
    `SELECT count(*)::int AS n
     FROM public.inventory_items
     WHERE deleted_at IS NULL
       AND stock_pool <> 'sale'
       AND serial_number NOT LIKE $1`,
    [`${PREFIX}%`]
  )
  return {
    clients: sales.rows[0].clients,
    orders: sales.rows[0].orders,
    units: sales.rows[0].units,
    low: low.rows[0].low,
    available: low.rows[0].available,
    marked: marked.rows[0].n,
  }
}

async function main() {
  loadEnvLocal()
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
  if (!dbUrl) throw new Error("SUPABASE_DB_URL is not set")
  const db = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
  await db.connect()
  const service = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const adminEmail = "verify-071-admin@test.local"
  const techEmail = "verify-071-technicians@test.local"
  const product = await db.query(`SELECT id, product_name FROM public.product_lines WHERE is_active ORDER BY id LIMIT 1`)
  const productId = product.rows[0].id
  const productName = product.rows[0].product_name
  let adminId = null
  let techId = null
  let started = null

  async function cleanup() {
    await db.query(`ALTER TABLE public.stock_pool_changes DISABLE TRIGGER tr_stock_pool_changes_append_only`)
    try {
      await db.query(`DELETE FROM public.stock_pool_changes WHERE serial_number LIKE $1`, [`${PREFIX}%`])
    } finally {
      await db.query(`ALTER TABLE public.stock_pool_changes ENABLE TRIGGER tr_stock_pool_changes_append_only`)
    }
    await db.query(`DELETE FROM public.batch_restores WHERE batch_id LIKE $1`, [`BATCH-${PREFIX}%`])
    await db.query(`DELETE FROM public.batch_reversals WHERE batch_id LIKE $1`, [`BATCH-${PREFIX}%`])
    await db.query(
      `DELETE FROM public.transactions WHERE id LIKE $1 OR serial_number LIKE $2 OR batch_id LIKE $3`,
      [`TXN-${PREFIX}%`, `${PREFIX}%`, `BATCH-${PREFIX}%`]
    )
    await db.query(`DELETE FROM public.inventory_items WHERE id LIKE $1 OR serial_number LIKE $2`, [
      `ITEM-${PREFIX}%`,
      `${PREFIX}%`,
    ])
    for (const email of [adminEmail, techEmail]) {
      const users = await db.query(`SELECT id::text AS id FROM auth.users WHERE email = $1`, [email])
      for (const row of users.rows) {
        const { error } = await service.auth.admin.deleteUser(row.id)
        if (error && !/not found/i.test(error.message)) throw error
      }
    }
  }

  async function inbound(serial) {
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
          date_added: "2026-10-05",
          location: "Warehouse A",
        },
      ]),
      JSON.stringify([
        {
          id: txnId,
          type: "Inbound",
          serial_number: serial,
          item_name: productName,
          date: DATE,
          client: "Internal",
          batch_id: batchId,
          to_location: "Warehouse A",
        },
      ]),
    ])
    return { itemId, txnId, batchId }
  }

  async function readPool(serial) {
    const row = await db.query(
      `SELECT id, stock_pool, status FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
      [serial]
    )
    return row.rows[0] ?? null
  }

  async function move(serial, type, status, location, extra = {}) {
    const current = await readPool(serial)
    const txnId = nextId("TXN")
    const batchId = nextId("BATCH")
    await db.query(`SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`, [
      JSON.stringify([
        {
          id: current.id,
          product_id: productId,
          serial_number: serial,
          status,
          date_added: "2026-10-05",
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
          date: DATE,
          client: extra.client ?? "Internal",
          batch_id: batchId,
          to_location: location,
          return_pool: extra.return_pool ?? null,
        },
      ]),
    ])
    return { txnId, batchId }
  }

  try {
    await cleanup()
    const before = await snapshot(db)
    started = before
    if (before.marked !== 0) {
      fail("live_kits_stay_sale", `${before.marked} live kits are not sale before the test`)
    } else {
      pass("live_kits_stay_sale", "every live kit is sale")
    }

    for (const email of [adminEmail, techEmail]) {
      const existing = await db.query(`SELECT id FROM auth.users WHERE email = $1`, [email])
      if (existing.rows[0]) await service.auth.admin.deleteUser(existing.rows[0].id)
    }
    const adminCreated = await service.auth.admin.createUser({ email: adminEmail, email_confirm: true })
    if (adminCreated.error) throw new Error(adminCreated.error.message)
    adminId = adminCreated.data.user.id
    const techCreated = await service.auth.admin.createUser({ email: techEmail, email_confirm: true })
    if (techCreated.error) throw new Error(techCreated.error.message)
    techId = techCreated.data.user.id
    await db.query(`UPDATE public.profiles SET role = 'admin'::public.app_role, active = true WHERE id = $1`, [adminId])
    await db.query(
      `UPDATE public.profiles SET role = 'technicians'::public.app_role, active = true WHERE id = $1`,
      [techId]
    )
    await setUser(db, adminId)

    const fresh = await inbound(`${PREFIX}-SALE`)
    const freshRow = await readPool(`${PREFIX}-SALE`)
    const freshTxn = await db.query(
      `SELECT previous_stock_pool, after_stock_pool FROM public.transactions WHERE id = $1`,
      [fresh.txnId]
    )
    if (freshRow?.stock_pool === "sale" && freshTxn.rows[0]?.after_stock_pool === "sale" && freshTxn.rows[0]?.previous_stock_pool == null) {
      pass("new_kit_is_sale", `${PREFIX}-SALE is sale; the inbound after-image is sale`)
    } else {
      fail("new_kit_is_sale", JSON.stringify({ freshRow, image: freshTxn.rows[0] }))
    }

    const rentalKit = await inbound(`${PREFIX}-RENT`)
    const short = await raises(
      db,
      `SELECT public.change_stock_pool($1, 'rental', $2)`,
      [rentalKit.itemId, SHORT],
      "at least 15"
    )
    if (short) fail("reason_required", short)
    else pass("reason_required", "a short reason is rejected")

    await setUser(db, techId)
    const tech = await raises(
      db,
      `SELECT public.change_stock_pool($1, 'rental', $2)`,
      [rentalKit.itemId, REASON],
      "admin only"
    )
    if (tech) fail("admin_only", tech)
    else pass("admin_only", "a technician cannot change group")

    await setUser(db, adminId)
    await db.query(`SELECT public.change_stock_pool($1, 'rental', $2)`, [rentalKit.itemId, REASON])
    const history = await db.query(
      `SELECT from_pool, to_pool, reason, changed_by::text AS changed_by
       FROM public.stock_pool_changes WHERE inventory_item_id = $1`,
      [rentalKit.itemId]
    )
    const rented = await readPool(`${PREFIX}-RENT`)
    if (
      rented?.stock_pool === "rental" &&
      history.rows.length === 1 &&
      history.rows[0].from_pool === "sale" &&
      history.rows[0].to_pool === "rental" &&
      history.rows[0].changed_by === adminId
    ) {
      pass("change_writes_history", "sale → rental recorded")
    } else {
      fail("change_writes_history", JSON.stringify({ rented, history: history.rows }))
    }

    const saleRejected = await raises(
      db,
      `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
      [
        JSON.stringify([
          {
            id: rentalKit.itemId,
            product_id: productId,
            serial_number: `${PREFIX}-RENT`,
            status: "Sold",
            date_added: "2026-10-05",
            location: "Delivered",
          },
        ]),
        JSON.stringify([
          {
            id: nextId("TXN"),
            type: "Sale",
            serial_number: `${PREFIX}-RENT`,
            item_name: productName,
            date: DATE,
            client: "Internal",
            batch_id: nextId("BATCH"),
          },
        ]),
      ],
      "sellable kit"
    )
    if (saleRejected) fail("sale_rejects_rental", saleRejected)
    else pass("sale_rejects_rental", "Sale of a rental kit is rejected")

    const demoKit = await inbound(`${PREFIX}-DEMO`)
    await db.query(`SELECT public.change_stock_pool($1, 'demo', $2)`, [demoKit.itemId, REASON])
    const demoSale = await raises(
      db,
      `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
      [
        JSON.stringify([
          {
            id: demoKit.itemId,
            product_id: productId,
            serial_number: `${PREFIX}-DEMO`,
            status: "Sold",
            date_added: "2026-10-05",
            location: "Delivered",
          },
        ]),
        JSON.stringify([
          {
            id: nextId("TXN"),
            type: "Sale",
            serial_number: `${PREFIX}-DEMO`,
            item_name: productName,
            date: DATE,
            client: "Internal",
            batch_id: nextId("BATCH"),
          },
        ]),
      ],
      "sellable kit"
    )
    if (demoSale) fail("sale_rejects_demo", demoSale)
    else pass("sale_rejects_demo", "Sale of a demo kit is rejected")

    await db.query(`SELECT public.change_stock_pool($1, 'sale', $2)`, [rentalKit.itemId, REASON])
    const rentedOut = await move(`${PREFIX}-RENT`, "Rentals", "Rented", "Client Site", {
      client: "P1 Holder",
      assigned_to: "P1 Holder",
      poc_out_date: "2026-10-05",
      return_date: "2026-11-05",
    })
    const out = await readPool(`${PREFIX}-RENT`)
    const outImage = await db.query(
      `SELECT previous_stock_pool, after_stock_pool FROM public.transactions WHERE id = $1`,
      [rentedOut.txnId]
    )
    if (out?.stock_pool === "rental" && outImage.rows[0]?.previous_stock_pool === "sale" && outImage.rows[0]?.after_stock_pool === "rental") {
      pass("rentals_sets_rental", "Rentals turns a sale kit into rental")
    } else {
      fail("rentals_sets_rental", JSON.stringify({ out, image: outImage.rows[0] }))
    }

    await db.query(`SELECT public.reverse_quick_scan_batch($1, $2, 'Warehouse A', '[]'::jsonb, '[]'::jsonb)`, [
      rentedOut.batchId,
      REVERSE_REASON,
    ])
    const reversed = await readPool(`${PREFIX}-RENT`)
    if (reversed?.status === "In Stock" && reversed?.stock_pool === "sale") {
      pass("reverse_restores_pool", "reversing Rentals puts the kit back in sale")
    } else {
      fail("reverse_restores_pool", JSON.stringify(reversed))
    }
    await db.query(`SELECT public.restore_batch($1, $2)`, [rentedOut.batchId, RESTORE_REASON])
    const restored = await readPool(`${PREFIX}-RENT`)
    if (restored?.status === "Rented" && restored?.stock_pool === "rental") {
      pass("restore_restores_pool", "restoring Rentals puts the kit back in rental")
    } else {
      fail("restore_restores_pool", JSON.stringify(restored))
    }

    await move(`${PREFIX}-RENT`, "Rental Return", "Pending Inspection", "Warehouse A")
    const back = await readPool(`${PREFIX}-RENT`)
    if (back?.status === "Pending Inspection" && back?.stock_pool === "rental") {
      pass("rental_return_keeps_rental", "Rental Return leaves the kit rental and pending inspection")
    } else {
      fail("rental_return_keeps_rental", JSON.stringify(back))
    }

    const rentalPoc = await raises(
      db,
      `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
      [
        JSON.stringify([
          {
            id: rentalKit.itemId,
            product_id: productId,
            serial_number: `${PREFIX}-RENT`,
            status: "POC",
            date_added: "2026-10-05",
            location: "Client Site",
          },
        ]),
        JSON.stringify([
          {
            id: nextId("TXN"),
            type: "POC Out",
            serial_number: `${PREFIX}-RENT`,
            item_name: productName,
            date: DATE,
            client: "P1 Holder",
            batch_id: nextId("BATCH"),
          },
        ]),
      ],
      "not allowed from the rental"
    )
    if (rentalPoc) fail("poc_out_rejects_rental", rentalPoc)
    else pass("poc_out_rejects_rental", "POC Out is not allowed from rental")

    await db.query(`SELECT public.change_stock_pool($1, 'sale', $2)`, [demoKit.itemId, REASON])
    await move(`${PREFIX}-DEMO`, "POC Out", "POC", "Client Site", {
      client: "P1 Holder",
      poc_out_date: "2026-10-05",
    })
    const whileOut = await raises(
      db,
      `SELECT public.change_stock_pool($1, 'demo', $2)`,
      [demoKit.itemId, REASON],
      "only an In Stock"
    )
    if (whileOut) fail("change_only_in_stock", whileOut)
    else pass("change_only_in_stock", "a POC kit cannot change group")

    const missingChoice = await raises(
      db,
      `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
      [
        JSON.stringify([
          {
            id: demoKit.itemId,
            product_id: productId,
            serial_number: `${PREFIX}-DEMO`,
            status: "In Stock",
            date_added: "2026-10-05",
            location: "Warehouse A",
          },
        ]),
        JSON.stringify([
          {
            id: nextId("TXN"),
            type: "POC Return",
            serial_number: `${PREFIX}-DEMO`,
            item_name: productName,
            date: DATE,
            client: "Internal",
            batch_id: nextId("BATCH"),
            to_location: "Warehouse A",
          },
        ]),
      ],
      "must choose"
    )
    if (missingChoice) fail("poc_return_requires_choice", missingChoice)
    else pass("poc_return_requires_choice", "POC Return without a group is rejected")

    await move(`${PREFIX}-DEMO`, "POC Return", "In Stock", "Warehouse A", { return_pool: "demo" })
    const demoBack = await readPool(`${PREFIX}-DEMO`)
    if (demoBack?.status === "In Stock" && demoBack?.stock_pool === "demo") {
      pass("poc_return_sets_demo", "POC Return sets the chosen demo group")
    } else {
      fail("poc_return_sets_demo", JSON.stringify(demoBack))
    }

    const demoRent = await raises(
      db,
      `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
      [
        JSON.stringify([
          {
            id: demoKit.itemId,
            product_id: productId,
            serial_number: `${PREFIX}-DEMO`,
            status: "Rented",
            date_added: "2026-10-05",
            location: "Client Site",
          },
        ]),
        JSON.stringify([
          {
            id: nextId("TXN"),
            type: "Rentals",
            serial_number: `${PREFIX}-DEMO`,
            item_name: productName,
            date: DATE,
            client: "P1 Holder",
            batch_id: nextId("BATCH"),
          },
        ]),
      ],
      "not allowed from the demo"
    )
    if (demoRent) fail("rentals_rejects_demo", demoRent)
    else pass("rentals_rejects_demo", "Rentals is not allowed from demo")

    const saleKit = await inbound(`${PREFIX}-SELL`)
    await move(`${PREFIX}-SELL`, "POC Out", "POC", "Client Site", { client: "P1 Holder", poc_out_date: "2026-10-05" })
    await move(`${PREFIX}-SELL`, "Sale", "Sold", "Delivered", { client: "P1 Holder" })
    const sold = await readPool(`${PREFIX}-SELL`)
    if (sold?.status === "Sold" && sold?.stock_pool === "sale") {
      pass("convert_to_sale", "converting a POC kit to a sale does not ask for a group")
    } else {
      fail("convert_to_sale", JSON.stringify(sold))
    }
  } catch (error) {
    fail("verifier", error instanceof Error ? error.message : String(error))
  } finally {
    try {
      await cleanup()
      const after = await snapshot(db)
      const opened = await db.query(
        `SELECT count(*)::int AS n FROM public.inventory_items WHERE serial_number LIKE $1 OR id LIKE $2`,
        [`${PREFIX}%`, `ITEM-${PREFIX}%`]
      )
      const txns = await db.query(
        `SELECT count(*)::int AS n FROM public.transactions WHERE serial_number LIKE $1 OR id LIKE $2`,
        [`${PREFIX}%`, `TXN-${PREFIX}%`]
      )
      const changes = await db.query(
        `SELECT count(*)::int AS n FROM public.stock_pool_changes WHERE serial_number LIKE $1`,
        [`${PREFIX}%`]
      )
      const users = await db.query(`SELECT count(*)::int AS n FROM auth.users WHERE email = ANY($1::text[])`, [
        [adminEmail, techEmail],
      ])
      if (opened.rows[0].n === 0 && txns.rows[0].n === 0 && changes.rows[0].n === 0 && users.rows[0].n === 0 && after.marked === 0) {
        pass("zero_residue", "no verify-071 kits, transactions, group changes, or users")
      } else {
        fail("zero_residue", JSON.stringify({ opened: opened.rows[0].n, txns: txns.rows[0].n, changes: changes.rows[0].n, users: users.rows[0].n, marked: after.marked }))
      }
      const same =
        started &&
        after.clients === started.clients &&
        after.orders === started.orders &&
        after.units === started.units &&
        after.low === started.low &&
        after.available === started.available &&
        after.marked === 0
      if (same) {
        pass(
          "live_totals_unchanged",
          `${after.clients} clients / ${after.orders} orders / ${after.units} units; low ${after.low}; available ${after.available}`
        )
      } else {
        fail("live_totals_unchanged", JSON.stringify({ started, after }))
      }
    } catch (error) {
      fail("zero_residue", error instanceof Error ? error.message : String(error))
    }
    await Promise.race([db.end(), new Promise((resolve) => setTimeout(resolve, 2000))])
  }

  const failed = Object.values(results).some((row) => row.result === "FAIL")
  console.log(JSON.stringify(results, null, 2))
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
