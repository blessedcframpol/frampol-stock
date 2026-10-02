/**
 * Cancel a holding extension. Fixture identities are removed in finally.
 *
 * Usage: node scripts/verify-070-cancel-holding-extension.mjs
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"

const require = createRequire(import.meta.url)
const { Client } = require("pg")
const { createClient } = require("@supabase/supabase-js")

const PREFIX = "E1070"
const DATE = "2026-10-02T00:00:00.000Z"
const ORIGINAL = "2026-11-01"
const FIRST = "2026-12-01"
const SECOND = "2027-01-15"
const CANCEL_REASON = "E1 verify cancel reason"
const EXTEND_REASON = "Customer asked for more time"

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

function pass(results, name, reason) {
  results[name] = { result: "PASS", reason }
  console.log(`PASS  ${name} — ${reason}`)
}

function fail(results, name, reason) {
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
  await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: userId })])
}

let seq = 0
function nextId(kind) {
  seq += 1
  return `${kind}-${PREFIX}-${seq}`
}

async function main() {
  loadEnvLocal()
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
  if (!dbUrl) throw new Error("SUPABASE_DB_URL is not set")
  const db = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
  await db.connect()
  const results = {}
  let fixturesOk = false
  const product = await db.query(
    `SELECT id, product_name FROM public.product_lines WHERE is_active ORDER BY id LIMIT 1`
  )
  const productId = product.rows[0].id
  const productName = product.rows[0].product_name
  const service = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const adminEmail = "verify-070-admin@test.local"
  const email = "verify-070-technicians@test.local"
  for (const leftover of [adminEmail, email]) {
    const existing = await db.query(`SELECT id FROM auth.users WHERE email = $1`, [leftover])
    if (existing.rows[0]) await service.auth.admin.deleteUser(existing.rows[0].id)
  }
  const { data: adminCreated, error: adminError } = await service.auth.admin.createUser({
    email: adminEmail,
    email_confirm: true,
  })
  if (adminError) throw new Error(`createUser admin: ${adminError.message}`)
  const adminId = adminCreated.user.id
  const adminUpdated = await db.query(
    `UPDATE public.profiles SET role = 'admin'::public.app_role, active = true WHERE id = $1`,
    [adminId]
  )
  if (adminUpdated.rowCount !== 1) throw new Error("admin profile was not updated")
  const { data: created, error: createError } = await service.auth.admin.createUser({ email, email_confirm: true })
  if (createError) throw new Error(`createUser: ${createError.message}`)
  const technicianId = created.user.id
  const updated = await db.query(
    `UPDATE public.profiles SET role = 'technicians'::public.app_role, active = true WHERE id = $1`,
    [technicianId]
  )
  if (updated.rowCount !== 1) throw new Error("technician profile was not updated")

  async function snapshot() {
    const counted = await db.query(
      `SELECT resolution.resolved_client_id AS client_id,
              count(DISTINCT resolution.batch_key)::int AS orders,
              count(*)::int AS units
       FROM public.client_transaction_resolution AS resolution
       JOIN public.active_transactions AS transactions ON transactions.id = resolution.transaction_id
       WHERE transactions.type = 'Sale'
         AND resolution.resolved_client_id IS NOT NULL
       GROUP BY resolution.resolved_client_id`
    )
    return counted.rows
  }

  function indexSaleCounts(rows) {
    const byId = new Map()
    for (const row of rows) byId.set(row.client_id, `${Number(row.orders)}:${Number(row.units)}`)
    return byId
  }

  async function foreignSaleClients(since) {
    const touched = await db.query(
      `SELECT DISTINCT resolution.resolved_client_id AS client_id
       FROM public.transactions AS txn
       JOIN public.client_transaction_resolution AS resolution ON resolution.transaction_id = txn.id
       WHERE txn.created_at >= $1
         AND resolution.resolved_client_id IS NOT NULL
         AND txn.id NOT LIKE $2
         AND coalesce(txn.serial_number, '') NOT LIKE $2
         AND coalesce(txn.batch_id, '') NOT LIKE $2`,
      [since, `%${PREFIX}%`]
    )
    return new Set(touched.rows.map((row) => row.client_id))
  }

  const saleClock = await db.query(`SELECT clock_timestamp() AS started_at`)
  const saleStartedAt = saleClock.rows[0].started_at
  const beforeShot = await snapshot()

  async function returnDate(itemId) {
    const item = await db.query(`SELECT return_date FROM public.inventory_items WHERE id = $1`, [itemId])
    return item.rows[0]?.return_date ?? null
  }

  async function extension(id) {
    const row = await db.query(
      `SELECT previous_date, new_date, cancelled_at, cancelled_by, cancel_reason
       FROM public.holding_extensions WHERE id = $1`,
      [id]
    )
    return row.rows[0]
  }

  async function createInbound(serial) {
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
          date_added: DATE,
          location: "Warehouse A",
          client: null,
          assigned_to: null,
          poc_out_date: null,
          return_date: null,
        },
      ]),
      JSON.stringify([
        {
          id: txnId,
          type: "Inbound",
          serial_number: serial,
          item_name: productName,
          date: DATE,
          client: "",
          batch_id: batchId,
          to_location: "Warehouse A",
        },
      ]),
    ])
    return itemId
  }

  async function move(itemId, type, after) {
    const current = await db.query(
      `SELECT id, product_id, serial_number, status, date_added::text AS date_added, location,
              client, notes, assigned_to, purchase_date::text AS purchase_date,
              warranty_end_date::text AS warranty_end_date, assignment_history,
              reserved_for_request_line_id, cloud_key, poc_out_date, return_date
       FROM public.inventory_items
       WHERE id = $1 AND deleted_at IS NULL`,
      [itemId]
    )
    const row = current.rows[0]
    const txnId = nextId("TXN")
    const batchId = nextId("BATCH")
    await db.query(`SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`, [
      JSON.stringify([
        {
          id: row.id,
          product_id: row.product_id,
          serial_number: row.serial_number,
          status: after.status,
          date_added: row.date_added,
          location: after.location,
          client: after.client,
          notes: row.notes,
          assigned_to: after.assigned_to,
          purchase_date: row.purchase_date,
          warranty_end_date: row.warranty_end_date,
          poc_out_date: after.poc_out_date,
          return_date: after.return_date,
          assignment_history: row.assignment_history ?? [],
          reserved_for_request_line_id: row.reserved_for_request_line_id,
          cloud_key: row.cloud_key,
          deleted_at: null,
        },
      ]),
      JSON.stringify([
        {
          id: txnId,
          type,
          serial_number: row.serial_number,
          item_name: productName,
          date: DATE,
          batch_id: batchId,
          from_location: row.location,
          to_location: after.location,
          client: after.client ?? "",
          assigned_to: after.assigned_to,
        },
      ]),
    ])
    return batchId
  }

  async function extend(itemId, newDate) {
    await db.query(`SELECT public.extend_holding($1, $2, $3)`, [itemId, newDate, EXTEND_REASON])
    const row = await db.query(
      `SELECT id, previous_date, new_date
       FROM public.holding_extensions
       WHERE item_id = $1 AND new_date = $2 AND cancelled_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [itemId, newDate]
    )
    return row.rows[0]
  }

  async function cleanup() {
    await db.query(`DELETE FROM public.holding_extensions WHERE serial_number LIKE $1 OR item_id LIKE $2`, [
      `${PREFIX}-%`,
      `ITEM-${PREFIX}-%`,
    ])
    await db.query(`DELETE FROM public.transactions WHERE serial_number LIKE $1 OR batch_id LIKE $2`, [
      `${PREFIX}-%`,
      `BATCH-${PREFIX}-%`,
    ])
    await db.query(`DELETE FROM public.inventory_items WHERE serial_number LIKE $1 OR id LIKE $2`, [
      `${PREFIX}-%`,
      `ITEM-${PREFIX}-%`,
    ])
    if (technicianId) await service.auth.admin.deleteUser(technicianId)
    if (adminId) await service.auth.admin.deleteUser(adminId)
  }

  const holding = {
    status: "POC",
    location: "Client Site",
    client: "E1070 Holder",
    assigned_to: "E1070 Assignee",
    poc_out_date: "2026-10-02",
    return_date: ORIGINAL,
  }

  try {
    await setUser(db, adminId)
    const itemA = await createInbound(`${PREFIX}-A`)
    await move(itemA, "POC Out", holding)
    const first = await extend(itemA, FIRST)
    const second = await extend(itemA, SECOND)
    if (first.previous_date !== ORIGINAL || second.previous_date !== FIRST) {
      throw new Error(`previous dates ${first.previous_date} / ${second.previous_date}`)
    }

    await setUser(db, technicianId)
    const forbidden = await raises(
      db,
      `SELECT public.cancel_holding_extension($1, $2)`,
      [second.id, CANCEL_REASON],
      "forbidden"
    )
    if (forbidden) fail(results, "non_admin", forbidden)
    else pass(results, "non_admin", "technician rejected")

    await setUser(db, adminId)
    const short = await raises(
      db,
      `SELECT public.cancel_holding_extension($1, $2)`,
      [second.id, "too short"],
      "at least 15"
    )
    if (short) fail(results, "reason", short)
    else pass(results, "reason", "short reason rejected")

    const older = await raises(
      db,
      `SELECT public.cancel_holding_extension($1, $2)`,
      [first.id, CANCEL_REASON],
      "only the latest"
    )
    if (older) fail(results, "not_latest", older)
    else pass(results, "not_latest", "older extension rejected")
    if ((await returnDate(itemA)) !== SECOND) fail(results, "untouched", await returnDate(itemA))
    else pass(results, "untouched", SECOND)

    await db.query(`SELECT public.cancel_holding_extension($1, $2)`, [second.id, CANCEL_REASON])
    const afterLatest = await returnDate(itemA)
    const kept = await extension(second.id)
    if (afterLatest === FIRST && kept.cancelled_at && kept.cancelled_by === adminId && kept.cancel_reason === CANCEL_REASON && kept.previous_date === FIRST && kept.new_date === SECOND) {
      pass(results, "cancel_latest", `return date ${FIRST}; row kept`)
    } else {
      fail(results, "cancel_latest", JSON.stringify({ afterLatest, kept }))
    }

    await db.query(`SELECT public.cancel_holding_extension($1, $2)`, [first.id, CANCEL_REASON])
    const afterFirst = await returnDate(itemA)
    const keptFirst = await extension(first.id)
    if (afterFirst === ORIGINAL && keptFirst.cancelled_at && keptFirst.previous_date === ORIGINAL && keptFirst.new_date === FIRST) {
      pass(results, "cancel_again", `return date ${ORIGINAL}; row kept`)
    } else {
      fail(results, "cancel_again", JSON.stringify({ afterFirst, keptFirst }))
    }

    const itemB = await createInbound(`${PREFIX}-B`)
    await move(itemB, "POC Out", holding)
    const moved = await extend(itemB, FIRST)
    const batchId = await move(itemB, "Transfer", { ...holding, location: "Warehouse B", return_date: FIRST })
    const later = await raises(
      db,
      `SELECT public.cancel_holding_extension($1, $2)`,
      [moved.id, CANCEL_REASON],
      "later"
    )
    if (later) fail(results, "later_movement", later)
    else if ((await returnDate(itemB)) !== FIRST) fail(results, "later_movement", await returnDate(itemB))
    else pass(results, "later_movement", `rejected after ${batchId}`)

    fixturesOk = Object.values(results).every((row) => row.result === "PASS")
  } finally {
    await cleanup()
    const residue = await db.query(
      `SELECT
         (SELECT count(*)::int FROM public.transactions WHERE serial_number LIKE $1 OR batch_id LIKE $2) AS txns,
         (SELECT count(*)::int FROM public.inventory_items WHERE serial_number LIKE $1 OR id LIKE $3) AS items,
         (SELECT count(*)::int FROM public.holding_extensions WHERE serial_number LIKE $1 OR item_id LIKE $3) AS extensions,
         (SELECT count(*)::int FROM auth.users WHERE email LIKE 'verify-070-%@test.local') AS users`,
      [`${PREFIX}-%`, `BATCH-${PREFIX}-%`, `ITEM-${PREFIX}-%`]
    )
    const left = residue.rows[0]
    if (left.txns === 0 && left.items === 0 && left.extensions === 0 && left.users === 0) {
      pass(results, "residue", "no fixture rows or test users left")
    } else {
      fail(results, "residue", JSON.stringify(left))
    }
  }

  if (fixturesOk && results.residue?.result === "PASS") {
    try {
      await setUser(db, adminId)
      const afterShot = await snapshot()
      const before = indexSaleCounts(beforeShot)
      const after = indexSaleCounts(afterShot)
      const changed = []
      for (const id of new Set([...before.keys(), ...after.keys()])) {
        if (before.get(id) !== after.get(id)) changed.push(id)
      }
      const foreign = await foreignSaleClients(saleStartedAt)
      const unexplained = changed.filter((id) => !foreign.has(id))
      const ignored = changed.filter((id) => foreign.has(id))
      const orders = afterShot.reduce((sum, row) => sum + Number(row.orders), 0)
      const units = afterShot.reduce((sum, row) => sum + Number(row.units), 0)
      if (unexplained.length) fail(results, "snapshot", unexplained.slice(0, 5).join(", "))
      else if (ignored.length) pass(results, "snapshot", `${afterShot.length} clients; ignored ${ignored.join(", ")}`)
      else pass(results, "snapshot", `${afterShot.length} / ${orders} / ${units} unchanged`)
    } catch (error) {
      fail(results, "snapshot", error instanceof Error ? error.message : String(error))
    }
  }

  await Promise.race([db.end(), new Promise((resolve) => setTimeout(resolve, 2000))])
  const failed = Object.values(results).filter((row) => row.result !== "PASS")
  if (failed.length) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
