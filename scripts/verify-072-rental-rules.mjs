/**
 * Rental return, Starlink-only rental group, and bulk change group.
 * Fixture kits are removed in finally. Live rented kits are not changed.
 *
 * Usage: node scripts/verify-072-rental-rules.mjs
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"

const require = createRequire(import.meta.url)
const { Client } = require("pg")
const { createClient } = require("@supabase/supabase-js")

const PREFIX = "P1072"
const DATE = "2026-10-05T00:00:00.000Z"
const REASON = "P1 amendment group change"
const REVERSE_REASON = "P1 amendment reverse return"

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
  const adminEmail = "verify-072-admin@test.local"
  const techEmail = "verify-072-technicians@test.local"
  const star = await db.query(
    `SELECT id, product_name FROM public.product_lines WHERE vendor = 'Starlink' AND is_active ORDER BY id LIMIT 1`,
  )
  const other = await db.query(
    `SELECT id, product_name, vendor FROM public.product_lines WHERE vendor IS DISTINCT FROM 'Starlink' AND is_active ORDER BY id LIMIT 1`,
  )
  let adminId = null

  async function cleanup() {
    await db.query(`ALTER TABLE public.stock_pool_changes DISABLE TRIGGER tr_stock_pool_changes_append_only`)
    try {
      await db.query(`DELETE FROM public.stock_pool_changes WHERE serial_number LIKE $1`, [`${PREFIX}%`])
    } finally {
      await db.query(`ALTER TABLE public.stock_pool_changes ENABLE TRIGGER tr_stock_pool_changes_append_only`)
    }
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
    await db.query(`DELETE FROM public.batch_restores WHERE batch_id LIKE $1`, [`BATCH-${PREFIX}%`])
    await db.query(`DELETE FROM public.batch_reversals WHERE batch_id LIKE $1`, [`BATCH-${PREFIX}%`])
    await db.query(`DELETE FROM public.transactions WHERE id LIKE $1 OR serial_number LIKE $2 OR batch_id LIKE $3`, [
      `TXN-${PREFIX}%`,
      `${PREFIX}%`,
      `BATCH-${PREFIX}%`,
    ])
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
          to_location: "Warehouse A",
        },
      ]),
    ])
    return { itemId }
  }

  async function move(serial, productId, productName, type, status, location, extra = {}) {
    const current = await db.query(
      `SELECT id FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
      [serial],
    )
    const txnId = nextId("TXN")
    const batchId = nextId("BATCH")
    await db.query(`SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`, [
      JSON.stringify([
        {
          id: current.rows[0].id,
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
          metadata:
            type === "Rental Return" || type === "Decommissioned"
              ? { reason_category: "Client cancelled", reason_text: "Recorded reason for the return" }
              : null,
        },
      ]),
    ])
    return { batchId }
  }

  async function read(serial) {
    const row = await db.query(
      `SELECT status, stock_pool FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
      [serial],
    )
    return row.rows[0] ?? null
  }

  const liveBefore = await db.query(
    `SELECT i.serial_number, i.status, i.stock_pool
     FROM public.inventory_items i
     WHERE i.deleted_at IS NULL AND i.status = 'Rented'
     ORDER BY i.serial_number`,
  )

  try {
    await cleanup()
    const resultStatus = await db.query(`SELECT public.movement_result_status('Rented', 'Rental Return') AS status`)
    if (resultStatus.rows[0].status === "Pending Inspection") {
      pass("rental_return_result", "Rental Return results in Pending Inspection")
    } else {
      fail("rental_return_result", resultStatus.rows[0].status)
    }
    const pairs = await db.query(
      `SELECT
         public.reversal_pair_allowed('Pending Inspection', 'Rental Return', 'Rented') AS pending,
         public.reversal_pair_allowed('In Stock', 'Rental Return', 'Rented') AS legacy,
         public.reversal_pair_allowed('Sold', 'Rental Return', 'Rented') AS sold`,
    )
    if (pairs.rows[0].pending && pairs.rows[0].legacy && !pairs.rows[0].sold) {
      pass("rental_return_inverse", "Reverse restores Rented from Pending Inspection or an older In Stock return")
    } else {
      fail("rental_return_inverse", JSON.stringify(pairs.rows[0]))
    }

    const ever = await db.query(
      `SELECT count(*)::int AS n
       FROM public.inventory_items i
       JOIN public.product_lines p ON p.id = i.product_id
       WHERE COALESCE(p.vendor, '') <> 'Starlink'
         AND (
           i.status = 'Rented'
           OR i.stock_pool = 'rental'
           OR EXISTS (
             SELECT 1 FROM public.transactions t
             WHERE t.serial_number = i.serial_number AND t.type IN ('Rentals', 'Rental Return')
           )
         )`,
    )
    if (ever.rows[0].n === 0) pass("no_non_starlink_rental", "no non-Starlink kit has been rented")
    else fail("no_non_starlink_rental", String(ever.rows[0].n))

    for (const email of [adminEmail, techEmail]) {
      const existing = await db.query(`SELECT id FROM auth.users WHERE email = $1`, [email])
      if (existing.rows[0]) await service.auth.admin.deleteUser(existing.rows[0].id)
    }
    const adminCreated = await service.auth.admin.createUser({ email: adminEmail, email_confirm: true })
    if (adminCreated.error) throw new Error(adminCreated.error.message)
    adminId = adminCreated.data.user.id
    const techCreated = await service.auth.admin.createUser({ email: techEmail, email_confirm: true })
    if (techCreated.error) throw new Error(techCreated.error.message)
    const techId = techCreated.data.user.id
    await db.query(`UPDATE public.profiles SET role = 'admin'::public.app_role, active = true WHERE id = $1`, [adminId])
    await db.query(`UPDATE public.profiles SET role = 'technicians'::public.app_role, active = true WHERE id = $1`, [techId])
    await setUser(db, adminId)

    const starProduct = star.rows[0]
    const otherProduct = other.rows[0]
    const starKit = await inbound(`${PREFIX}-STAR`, starProduct.id, starProduct.product_name)
    const otherKit = await inbound(`${PREFIX}-OTHER`, otherProduct.id, otherProduct.product_name)
    const second = await inbound(`${PREFIX}-STAR2`, starProduct.id, starProduct.product_name)

    const otherRent = await raises(
      db,
      `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
      [
        JSON.stringify([
          {
            id: otherKit.itemId,
            product_id: otherProduct.id,
            serial_number: `${PREFIX}-OTHER`,
            status: "Rented",
            date_added: "2026-10-05",
            location: "Client Site",
          },
        ]),
        JSON.stringify([
          {
            id: nextId("TXN"),
            type: "Rentals",
            serial_number: `${PREFIX}-OTHER`,
            item_name: otherProduct.product_name,
            date: DATE,
            client: "P1 Holder",
            batch_id: nextId("BATCH"),
          },
        ]),
      ],
      "only for Starlink",
    )
    if (otherRent) fail("rentals_starlink_only", otherRent)
    else pass("rentals_starlink_only", `${otherProduct.vendor} cannot be rented`)

    const otherPool = await raises(
      db,
      `SELECT public.change_stock_pool($1, 'rental', $2)`,
      [otherKit.itemId, REASON],
      "only for Starlink",
    )
    if (otherPool) fail("pool_starlink_only", otherPool)
    else pass("pool_starlink_only", "a non-Starlink kit cannot join the rental group")

    const rolled = await raises(
      db,
      `SELECT public.change_stock_pools($1::text[], 'rental', $2)`,
      [[starKit.itemId, otherKit.itemId, second.itemId], REASON],
      "only for Starlink",
    )
    const afterRoll = await db.query(
      `SELECT count(*)::int AS changed
       FROM public.inventory_items
       WHERE id = ANY($1::text[]) AND stock_pool <> 'sale'`,
      [[starKit.itemId, otherKit.itemId, second.itemId]],
    )
    const rollHistory = await db.query(
      `SELECT count(*)::int AS n FROM public.stock_pool_changes WHERE inventory_item_id = ANY($1::text[])`,
      [[starKit.itemId, otherKit.itemId, second.itemId]],
    )
    if (!rolled && afterRoll.rows[0].changed === 0 && rollHistory.rows[0].n === 0) {
      pass("bulk_all_or_nothing", "one non-Starlink kit rolls the whole group change back")
    } else {
      fail("bulk_all_or_nothing", JSON.stringify({ rolled, changed: afterRoll.rows[0].changed, history: rollHistory.rows[0].n }))
    }

    await setUser(db, techId)
    const tech = await raises(
      db,
      `SELECT public.change_stock_pools($1::text[], 'rental', $2)`,
      [[starKit.itemId], REASON],
      "admin only",
    )
    if (tech) fail("bulk_admin_only", tech)
    else pass("bulk_admin_only", "a technician cannot change group")

    await setUser(db, adminId)
    await db.query(`SELECT public.change_stock_pools($1::text[], 'rental', $2)`, [[starKit.itemId, second.itemId], REASON])
    const history = await db.query(
      `SELECT inventory_item_id, from_pool, to_pool, reason
       FROM public.stock_pool_changes
       WHERE inventory_item_id = ANY($1::text[])
       ORDER BY inventory_item_id`,
      [[starKit.itemId, second.itemId]],
    )
    if (
      history.rows.length === 2 &&
      history.rows.every((row) => row.from_pool === "sale" && row.to_pool === "rental" && row.reason === REASON)
    ) {
      pass("bulk_one_row_each", "two kits, one reason, one history row each")
    } else {
      fail("bulk_one_row_each", JSON.stringify(history.rows))
    }

    const rented = await move(`${PREFIX}-STAR`, starProduct.id, starProduct.product_name, "Rentals", "Rented", "Client Site", {
      client: "P1 Holder",
      assigned_to: "P1 Holder",
      poc_out_date: "2026-10-05",
      return_date: "2026-11-05",
    })
    const out = await read(`${PREFIX}-STAR`)
    const whileOut = await db.query(`SELECT public.change_stock_pool($1, 'demo', $2)`, [starKit.itemId, REASON])
    void whileOut
    const tagged = await read(`${PREFIX}-STAR`)
    if (out?.status === "Rented" && out?.stock_pool === "rental" && tagged?.status === "Rented" && tagged?.stock_pool === "demo") {
      pass("rented_can_change_group", "a rented Starlink kit can change group while it is out")
    } else {
      fail("rented_can_change_group", JSON.stringify({ out, tagged }))
    }
    await db.query(`SELECT public.change_stock_pool($1, 'rental', $2)`, [starKit.itemId, REASON])

    const returned = await move(
      `${PREFIX}-STAR`,
      starProduct.id,
      starProduct.product_name,
      "Rental Return",
      "Pending Inspection",
      "Warehouse A",
    )
    const back = await read(`${PREFIX}-STAR`)
    if (back?.status === "Pending Inspection" && back?.stock_pool === "rental") {
      pass("return_pending_keeps_rental", "Rental Return is pending inspection and stays rental")
    } else {
      fail("return_pending_keeps_rental", JSON.stringify(back))
    }
    await db.query(`SELECT public.reverse_quick_scan_batch($1, $2, 'Client Site', '[]'::jsonb, '[]'::jsonb)`, [
      returned.batchId,
      REVERSE_REASON,
    ])
    const reversed = await read(`${PREFIX}-STAR`)
    if (reversed?.status === "Rented" && reversed?.stock_pool === "rental") {
      pass("reverse_return_restores_rented", "reversing the return puts the kit back on rental")
    } else {
      fail("reverse_return_restores_rented", JSON.stringify(reversed))
    }
    void rented
  } catch (error) {
    fail("verifier", error instanceof Error ? error.message : String(error))
  } finally {
    try {
      await cleanup()
      const opened = await db.query(
        `SELECT count(*)::int AS n FROM public.inventory_items WHERE serial_number LIKE $1 OR id LIKE $2`,
        [`${PREFIX}%`, `ITEM-${PREFIX}%`],
      )
      const users = await db.query(`SELECT count(*)::int AS n FROM auth.users WHERE email = ANY($1::text[])`, [
        [adminEmail, techEmail],
      ])
      const liveAfter = await db.query(
        `SELECT i.serial_number, i.status, i.stock_pool
         FROM public.inventory_items i
         WHERE i.deleted_at IS NULL AND i.status = 'Rented'
         ORDER BY i.serial_number`,
      )
      const same = JSON.stringify(liveBefore.rows) === JSON.stringify(liveAfter.rows)
      if (opened.rows[0].n === 0 && users.rows[0].n === 0) pass("zero_residue", "fixture kits and users are gone")
      else fail("zero_residue", JSON.stringify({ opened: opened.rows[0].n, users: users.rows[0].n }))
      if (same) pass("live_rented_unchanged", `${liveAfter.rows.length} rented kits unchanged`)
      else fail("live_rented_unchanged", JSON.stringify({ before: liveBefore.rows, after: liveAfter.rows }))
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
