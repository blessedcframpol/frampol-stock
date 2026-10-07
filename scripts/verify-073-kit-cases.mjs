/**
 * Kit cases: decommission and rental-return intake, inspection outcomes, reverse and restore.
 * Fixture kits are removed in finally. The UCG and the RMA Hold Mini are not changed.
 *
 * verify-072 is the rental-group check. This is the next check.
 *
 * Usage: node scripts/verify-073-kit-cases.mjs
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"

const require = createRequire(import.meta.url)
const { Client } = require("pg")
const { createClient } = require("@supabase/supabase-js")
const { prepareVerifyEnv } = require("./verify-env.cjs")

const PREFIX = "K1073"
const DATE = "2026-10-05T00:00:00.000Z"
const REASON = "Recorded reason for the return"
const CATEGORY = "Client cancelled"
const COMMENTS = "Checked the kit before choosing an outcome"
const REVERSE_REASON = "K1 verify reverse inspection"
const RESTORE_REASON = "K1 verify restore inspection"

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
  const adminEmail = "verify-073-admin@test.local"
  const techEmail = "verify-073-technicians@test.local"
  const star = await db.query(
    `SELECT id, product_name FROM public.product_lines WHERE vendor = 'Starlink' AND is_active ORDER BY id LIMIT 1`,
  )
  const other = await db.query(
    `SELECT id, product_name, vendor FROM public.product_lines WHERE vendor IS DISTINCT FROM 'Starlink' AND is_active ORDER BY id LIMIT 1`,
  )
  const client = await db.query(`SELECT id FROM public.clients ORDER BY id LIMIT 1`)

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
      `DELETE FROM public.batch_restores WHERE batch_id IN (
         SELECT batch_id FROM public.transactions WHERE serial_number LIKE $1
       )`,
      [`${PREFIX}%`],
    )
    await db.query(
      `DELETE FROM public.batch_reversals WHERE batch_id IN (
         SELECT batch_id FROM public.transactions WHERE serial_number LIKE $1
       )`,
      [`${PREFIX}%`],
    )
    await db.query(`DELETE FROM public.transactions WHERE serial_number LIKE $1 OR id LIKE $2`, [
      `${PREFIX}%`,
      `TXN-${PREFIX}%`,
    ])
    await db.query(`DELETE FROM public.inventory_items WHERE serial_number LIKE $1 OR id LIKE $2`, [
      `${PREFIX}%`,
      `ITEM-${PREFIX}%`,
    ])
    for (const email of [adminEmail, techEmail]) {
      const users = await db.query(`SELECT id::text AS id FROM auth.users WHERE email = $1`, [email])
      for (const row of users.rows) {
        const { error } = await service.auth.admin.deleteUser(row.id)
        if (error && !/not found/i.test(error.message)) throw error
      }
    }
  }

  function intakeMeta() {
    return { reason_category: CATEGORY, reason_text: REASON }
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
        },
      ]),
    ])
    return { itemId }
  }

  async function move(serial, productId, productName, type, status, location, extra = {}) {
    const current = await db.query(
      `SELECT id, client, assigned_to, stock_pool FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
      [serial],
    )
    const txnId = nextId("TXN")
    const batchId = nextId("BATCH")
    const keep = type === "Decommissioned" || type === "Rental Return"
    await db.query(`SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`, [
      JSON.stringify([
        {
          id: current.rows[0].id,
          product_id: productId,
          serial_number: serial,
          status,
          date_added: "2026-10-05",
          location,
          client: keep ? current.rows[0].client : (extra.client ?? null),
          assigned_to: keep ? current.rows[0].assigned_to : (extra.assigned_to ?? null),
        },
      ]),
      JSON.stringify([
        {
          id: txnId,
          type,
          serial_number: serial,
          item_name: productName,
          date: DATE,
          client: extra.client ?? current.rows[0].client ?? "Internal",
          batch_id: batchId,
          to_location: location,
          metadata: extra.metadata ?? null,
        },
      ]),
    ])
    return { batchId, itemId: current.rows[0].id }
  }

  async function read(serial) {
    const row = await db.query(
      `SELECT id, status, stock_pool, client, assigned_to, location, poc_out_date, return_date
       FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
      [serial],
    )
    return row.rows[0] ?? null
  }

  async function openCase(serial) {
    const row = await db.query(
      `SELECT kc.id, kc.stage, kc.outcome, kc.client_id, kc.reason_category, src.type AS source_type
       FROM public.kit_cases kc
       JOIN public.inventory_items item ON item.id = kc.inventory_item_id
       JOIN public.transactions src ON src.id = kc.source_transaction_id
       WHERE item.serial_number = $1
       ORDER BY kc.opened_at DESC
       LIMIT 1`,
      [serial],
    )
    return row.rows[0] ?? null
  }

  const started = await snapshot(db)
  const ucgBefore = await db.query(
    `SELECT id, serial_number, status, stock_pool, location, client, assigned_to, poc_out_date, return_date, product_id, deleted_at
     FROM public.inventory_items WHERE serial_number = '0CEA14E98B2D' AND deleted_at IS NULL`,
  )
  const miniBefore = await db.query(
    `SELECT id, status, stock_pool, location, client FROM public.inventory_items WHERE serial_number = 'KIT4M04887043KBG' AND deleted_at IS NULL`,
  )

  try {
    await cleanup()
    const adminCreated = await service.auth.admin.createUser({ email: adminEmail, email_confirm: true })
    if (adminCreated.error) throw new Error(adminCreated.error.message)
    const techCreated = await service.auth.admin.createUser({ email: techEmail, email_confirm: true })
    if (techCreated.error) throw new Error(techCreated.error.message)
    const adminId = adminCreated.data.user.id
    const techId = techCreated.data.user.id
    await db.query(`UPDATE public.profiles SET role = 'admin'::public.app_role, active = true WHERE id = $1`, [adminId])
    await db.query(`UPDATE public.profiles SET role = 'technicians'::public.app_role, active = true WHERE id = $1`, [techId])
    await setUser(db, adminId)

    const starProduct = star.rows[0]
    const otherProduct = other.rows[0]
    const clientId = client.rows[0].id
    const holder = "K1073 Holder"

    const missing = await inbound(`${PREFIX}-MISS`, starProduct.id, starProduct.product_name)
    await move(`${PREFIX}-MISS`, starProduct.id, starProduct.product_name, "Sale", "Sold", "Delivered", { client: holder, assigned_to: holder })
    const missingReason = await raises(
      db,
      `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
      [
        JSON.stringify([{
          id: missing.itemId,
          product_id: starProduct.id,
          serial_number: `${PREFIX}-MISS`,
          status: "Pending Inspection",
          date_added: "2026-10-05",
          location: "Warehouse A",
          client: holder,
          assigned_to: holder,
        }]),
        JSON.stringify([{
          id: nextId("TXN"),
          type: "Decommissioned",
          serial_number: `${PREFIX}-MISS`,
          item_name: starProduct.product_name,
          date: DATE,
          client: holder,
          batch_id: nextId("BATCH"),
        }]),
      ],
      "typed reason",
    )
    if (missingReason) fail("intake_requires_reason", missingReason)
    else pass("intake_requires_reason", "Decommissioned without a category and reason is rejected")

    const decSerial = `${PREFIX}-DEC`
    await inbound(decSerial, starProduct.id, starProduct.product_name)
    await move(decSerial, starProduct.id, starProduct.product_name, "Sale", "Sold", "Delivered", { client: holder, assigned_to: holder })
    await move(decSerial, starProduct.id, starProduct.product_name, "Decommissioned", "Pending Inspection", "Warehouse A", { metadata: intakeMeta(), client: holder })
    const dec = await read(decSerial)
    const decCase = await openCase(decSerial)
    if (dec?.status === "Pending Inspection" && dec.stock_pool === "sale" && dec.client === holder && dec.assigned_to === holder && decCase?.stage === "open" && decCase.source_type === "Decommissioned") {
      pass("decommission_opens_case", "Decommissioned opens a case and keeps the holder and group")
    } else {
      fail("decommission_opens_case", JSON.stringify({ dec, decCase }))
    }

    const rentSerial = `${PREFIX}-RENT`
    await inbound(rentSerial, starProduct.id, starProduct.product_name)
    await move(rentSerial, starProduct.id, starProduct.product_name, "Rentals", "Rented", "Client Site", { client: holder, assigned_to: holder })
    await move(rentSerial, starProduct.id, starProduct.product_name, "Rental Return", "Pending Inspection", "Warehouse A", { metadata: intakeMeta(), client: holder })
    const rent = await read(rentSerial)
    const rentCase = await openCase(rentSerial)
    if (rent?.status === "Pending Inspection" && rent.stock_pool === "rental" && rent.client === holder && rentCase?.source_type === "Rental Return" && rentCase.stage === "open") {
      pass("rental_return_opens_case", "Rental Return opens a case, stays rental, and keeps the holder")
    } else {
      fail("rental_return_opens_case", JSON.stringify({ rent, rentCase }))
    }

    const unknown = `${PREFIX}-NEW`
    const unknownItem = nextId("ITEM")
    const unknownTxn = nextId("TXN")
    await db.query(`SELECT public.apply_stock_movement('[]'::jsonb, $1::jsonb, $2::jsonb)`, [
      JSON.stringify([{
        id: unknownItem,
        product_id: starProduct.id,
        serial_number: unknown,
        status: "Pending Inspection",
        date_added: "2026-10-05",
        location: "Warehouse A",
        client: holder,
      }]),
      JSON.stringify([{
        id: unknownTxn,
        type: "Decommissioned",
        serial_number: unknown,
        item_name: starProduct.product_name,
        date: DATE,
        client: holder,
        client_id: clientId,
        batch_id: nextId("BATCH"),
        metadata: intakeMeta(),
      }]),
    ])
    const created = await read(unknown)
    const createdCase = await openCase(unknown)
    if (created?.status === "Pending Inspection" && created.poc_out_date == null && created.return_date == null && createdCase?.client_id === clientId) {
      pass("unknown_serial_client", "An unknown serial records the return date, links a client, and opens a case")
    } else {
      fail("unknown_serial_client", JSON.stringify({ created, createdCase }))
    }

    const noClient = await raises(
      db,
      `SELECT public.apply_stock_movement('[]'::jsonb, $1::jsonb, $2::jsonb)`,
      [
        JSON.stringify([{
          id: nextId("ITEM"),
          product_id: starProduct.id,
          serial_number: `${PREFIX}-NOCLIENT`,
          status: "Pending Inspection",
          date_added: "2026-10-05",
          location: "Warehouse A",
        }]),
        JSON.stringify([{
          id: nextId("TXN"),
          type: "Decommissioned",
          serial_number: `${PREFIX}-NOCLIENT`,
          item_name: starProduct.product_name,
          date: DATE,
          batch_id: nextId("BATCH"),
          metadata: intakeMeta(),
        }]),
      ],
      "needs a client",
    )
    if (noClient) fail("unknown_serial_requires_client", noClient)
    else pass("unknown_serial_requires_client", "An unknown serial without a client is rejected")

    const otherSerial = `${PREFIX}-OTHER`
    await inbound(otherSerial, otherProduct.id, otherProduct.product_name)
    await move(otherSerial, otherProduct.id, otherProduct.product_name, "Sale", "Sold", "Delivered", { client: holder, assigned_to: holder })
    await move(otherSerial, otherProduct.id, otherProduct.product_name, "Decommissioned", "Pending Inspection", "Warehouse A", { metadata: intakeMeta(), client: holder })
    const otherCase = await openCase(otherSerial)
    const rentOutRejected = await raises(
      db,
      `SELECT public.complete_inspection($1, 'Pass', $2, 'B', 'Rent out', 'Warehouse A', NULL)`,
      [otherCase.id, COMMENTS],
      "only for Starlink",
    )
    if (rentOutRejected) fail("rent_out_starlink_only", rentOutRejected)
    else pass("rent_out_starlink_only", "Rent out is rejected for non-Starlink")

    const failResell = await raises(
      db,
      `SELECT public.complete_inspection($1, 'Fail', $2, 'C', 'Resell', NULL, NULL)`,
      [otherCase.id, COMMENTS],
      "Resell is rejected after a Fail",
    )
    if (failResell) fail("resell_after_fail", failResell)
    else pass("resell_after_fail", "Resell is rejected after a Fail")

    await db.query(`SELECT public.complete_inspection($1, 'Pass', $2, 'A', 'Resell', 'Warehouse A', NULL)`, [decCase.id, COMMENTS])
    const resold = await read(decSerial)
    const resoldCase = await openCase(decSerial)
    if (resold?.status === "In Stock" && resold.stock_pool === "sale" && resold.client == null && resoldCase?.stage === "closed" && resoldCase.outcome === "Resell") {
      pass("resell_outcome", "Resell returns the kit to In Stock in the sale group and clears the holder")
    } else {
      fail("resell_outcome", JSON.stringify({ resold, resoldCase }))
    }

    await db.query(`SELECT public.complete_inspection($1, 'Pass', $2, 'B', 'Rent out', 'Warehouse B', NULL)`, [rentCase.id, COMMENTS])
    const rentedOut = await read(rentSerial)
    const rentedCase = await openCase(rentSerial)
    if (rentedOut?.status === "In Stock" && rentedOut.stock_pool === "rental" && rentedOut.client == null && rentedOut.location === "Warehouse B" && rentedCase?.outcome === "Rent out") {
      pass("rent_out_outcome", "Rent out returns a Starlink kit to In Stock in the rental group")
    } else {
      fail("rent_out_outcome", JSON.stringify({ rentedOut, rentedCase }))
    }

    const vendorSerial = `${PREFIX}-RMA`
    await inbound(vendorSerial, otherProduct.id, otherProduct.product_name)
    await move(vendorSerial, otherProduct.id, otherProduct.product_name, "Sale", "Sold", "Delivered", { client: holder, assigned_to: holder })
    await move(vendorSerial, otherProduct.id, otherProduct.product_name, "Decommissioned", "Pending Inspection", "Warehouse A", { metadata: intakeMeta(), client: holder })
    const vendorCase = await openCase(vendorSerial)
    await db.query(`SELECT public.complete_inspection($1, 'Fail', $2, 'C', 'Return to vendor', NULL, NULL)`, [vendorCase.id, COMMENTS])
    const vendor = await read(vendorSerial)
    const vendorClosed = await openCase(vendorSerial)
    if (vendor?.status === "RMA Hold" && vendor.stock_pool === "sale" && vendor.client === holder && vendorClosed?.outcome === "Return to vendor" && vendorClosed.stage === "closed") {
      pass("return_to_vendor", "Return to vendor closes the case on RMA Hold and keeps the holder and group")
    } else {
      fail("return_to_vendor", JSON.stringify({ vendor, vendorClosed }))
    }

    const disposeSerial = `${PREFIX}-DISP`
    await inbound(disposeSerial, starProduct.id, starProduct.product_name)
    await move(disposeSerial, starProduct.id, starProduct.product_name, "Sale", "Sold", "Delivered", { client: holder, assigned_to: holder })
    await move(disposeSerial, starProduct.id, starProduct.product_name, "Decommissioned", "Pending Inspection", "Warehouse A", { metadata: intakeMeta(), client: holder })
    const disposeCase = await openCase(disposeSerial)
    await db.query(`SELECT public.complete_inspection($1, 'Fail', $2, 'C', 'Dispose', NULL, NULL)`, [disposeCase.id, COMMENTS])
    const disposed = await read(disposeSerial)
    const disposeClosed = await openCase(disposeSerial)
    if (disposed?.status === "Disposed" && disposed.stock_pool === "sale" && disposed.client === holder && disposeClosed?.outcome === "Dispose") {
      pass("dispose_outcome", "Dispose closes the case and keeps the holder and group")
    } else {
      fail("dispose_outcome", JSON.stringify({ disposed, disposeClosed }))
    }

    const cycleSerial = `${PREFIX}-CYCLE`
    await inbound(cycleSerial, starProduct.id, starProduct.product_name)
    await move(cycleSerial, starProduct.id, starProduct.product_name, "Sale", "Sold", "Delivered", { client: holder, assigned_to: holder })
    await move(cycleSerial, starProduct.id, starProduct.product_name, "Decommissioned", "Pending Inspection", "Warehouse A", { metadata: intakeMeta(), client: holder })
    const cycleCase = await openCase(cycleSerial)
    await db.query(`SELECT public.complete_inspection($1, 'Pass', $2, 'A', 'Resell', 'Warehouse A', NULL)`, [cycleCase.id, COMMENTS])
    const cycleTxn = await db.query(
      `SELECT batch_id FROM public.transactions WHERE serial_number = $1 AND type = 'Inspection Pass' ORDER BY created_at DESC LIMIT 1`,
      [cycleSerial],
    )
    await db.query(`SELECT public.reverse_quick_scan_batch($1, $2, NULL, '[]'::jsonb, '[]'::jsonb)`, [
      cycleTxn.rows[0].batch_id,
      REVERSE_REASON,
    ])
    const reopened = await read(cycleSerial)
    const reopenedCase = await openCase(cycleSerial)
    const reopenedEvent = await db.query(
      `SELECT count(*)::int AS n FROM public.kit_case_events WHERE case_id = $1 AND event_type = 'reopened'`,
      [cycleCase.id],
    )
    if (reopened?.status === "Pending Inspection" && reopened.stock_pool === "sale" && reopenedCase?.stage === "open" && reopenedEvent.rows[0].n === 1) {
      pass("reverse_reopens", "Reversing the inspection puts the kit back and reopens the case")
    } else {
      fail("reverse_reopens", JSON.stringify({ reopened, reopenedCase, events: reopenedEvent.rows[0] }))
    }
    await db.query(`SELECT public.restore_batch($1, $2)`, [cycleTxn.rows[0].batch_id, RESTORE_REASON])
    const restored = await read(cycleSerial)
    const restoredCase = await openCase(cycleSerial)
    const reclosed = await db.query(
      `SELECT count(*)::int AS n FROM public.kit_case_events WHERE case_id = $1 AND event_type = 're-closed'`,
      [cycleCase.id],
    )
    if (restored?.status === "In Stock" && restored.stock_pool === "sale" && restoredCase?.stage === "closed" && reclosed.rows[0].n === 1) {
      pass("restore_recloses", "Restore puts the outcome back and re-closes the case")
    } else {
      fail("restore_recloses", JSON.stringify({ restored, restoredCase, events: reclosed.rows[0] }))
    }

    await setUser(db, techId)
    const techRejected = await raises(
      db,
      `SELECT public.complete_inspection($1, 'Pass', $2, 'A', 'Resell', 'Warehouse A', NULL)`,
      [otherCase.id, COMMENTS],
      "admin only",
    )
    if (techRejected) fail("non_admin_rejected", techRejected)
    else pass("non_admin_rejected", "A technician cannot complete an inspection")
    await setUser(db, adminId)

    const append = await raises(
      db,
      `UPDATE public.kit_case_events SET reason = 'changed' WHERE case_id = $1`,
      [decCase.id],
      "cannot be changed",
    )
    if (append) fail("events_append_only", append)
    else pass("events_append_only", "Case events cannot be updated")

    const direct = await raises(
      db,
      `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
      [
        JSON.stringify([{
          id: (await read(unknown)).id,
          product_id: starProduct.id,
          serial_number: unknown,
          status: "In Stock",
          date_added: "2026-10-05",
          location: "Warehouse A",
        }]),
        JSON.stringify([{
          id: nextId("TXN"),
          type: "Inspection Pass",
          serial_number: unknown,
          item_name: starProduct.product_name,
          date: DATE,
          batch_id: nextId("BATCH"),
          inspection_pool: "sale",
        }]),
      ],
      "open case",
    )
    if (direct) fail("inspection_only_from_case", direct)
    else pass("inspection_only_from_case", "Inspection Pass outside the case is rejected")

    const ucgAfter = await db.query(
      `SELECT id, serial_number, status, stock_pool, location, client, assigned_to, poc_out_date, return_date, product_id, deleted_at
       FROM public.inventory_items WHERE serial_number = '0CEA14E98B2D' AND deleted_at IS NULL`,
    )
    const ucgCases = await db.query(
      `SELECT kc.stage, kc.reason_category, kc.reason_text, kc.source_transaction_id
       FROM public.kit_cases kc
       JOIN public.inventory_items item ON item.id = kc.inventory_item_id
       WHERE item.serial_number = '0CEA14E98B2D'`,
    )
    const ucgSame = JSON.stringify(ucgBefore.rows) === JSON.stringify(ucgAfter.rows)
    const oneOpen = ucgCases.rows.length === 1 && ucgCases.rows[0].stage === "open" && ucgCases.rows[0].reason_category === "Not recorded" && ucgCases.rows[0].reason_text === "Other"
    if (ucgSame && oneOpen) pass("ucg_unchanged", "The UCG has one open case and its kit row is unchanged")
    else fail("ucg_unchanged", JSON.stringify({ ucgSame, ucgCases: ucgCases.rows }))

    const miniAfter = await db.query(
      `SELECT id, status, stock_pool, location, client FROM public.inventory_items WHERE serial_number = 'KIT4M04887043KBG' AND deleted_at IS NULL`,
    )
    if (JSON.stringify(miniBefore.rows) === JSON.stringify(miniAfter.rows)) pass("mini_unchanged", "The RMA Hold Mini is unchanged")
    else fail("mini_unchanged", JSON.stringify({ before: miniBefore.rows, after: miniAfter.rows }))

    const remediation = await db.query(`SELECT count(*)::int AS n FROM public.remediation_cases`)
    if (remediation.rows[0].n === 0) pass("remediation_untouched", "remediation_cases still has no rows")
    else fail("remediation_untouched", String(remediation.rows[0].n))
  } catch (error) {
    fail("verifier", error instanceof Error ? error.message : String(error))
  } finally {
    try {
      await cleanup()
      const left = await db.query(
        `SELECT count(*)::int AS n FROM public.inventory_items WHERE serial_number LIKE $1`,
        [`${PREFIX}%`],
      )
      const cases = await db.query(
        `SELECT count(*)::int AS n FROM public.kit_cases kc
         JOIN public.inventory_items item ON item.id = kc.inventory_item_id
         WHERE item.serial_number LIKE $1`,
        [`${PREFIX}%`],
      )
      const users = await db.query(`SELECT count(*)::int AS n FROM auth.users WHERE email = ANY($1::text[])`, [
        [adminEmail, techEmail],
      ])
      if (left.rows[0].n === 0 && cases.rows[0].n === 0 && users.rows[0].n === 0) pass("zero_residue", "fixture kits, cases, and users are gone")
      else fail("zero_residue", JSON.stringify({ items: left.rows[0].n, cases: cases.rows[0].n, users: users.rows[0].n }))
      const after = await snapshot(db)
      if (
        after.clients === started.clients &&
        after.orders === started.orders &&
        after.units === started.units &&
        after.low === started.low &&
        after.available === started.available
      ) {
        pass("live_totals", `${after.clients} clients / ${after.orders} orders / ${after.units} units; low ${after.low}; available ${after.available}`)
      } else {
        fail("live_totals", JSON.stringify({ started, after }))
      }
    } catch (error) {
      fail("cleanup", error instanceof Error ? error.message : String(error))
    }
    const failed = Object.values(results).some((row) => row.result === "FAIL")
    await Promise.race([db.end(), new Promise((resolve) => setTimeout(resolve, 2000))])
    process.exit(failed ? 1 : 0)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
