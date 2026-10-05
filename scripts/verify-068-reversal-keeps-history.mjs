/**
 * Reversal keeps the original rows, restores previous_status, and a no-effect
 * void drops the three phantom inbound batches. Fixture rows are removed.
 * The production void is left in place.
 *
 * Usage: node scripts/verify-068-reversal-keeps-history.mjs
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"

const require = createRequire(import.meta.url)
const { Client } = require("pg")
const { createClient } = require("@supabase/supabase-js")

const PREFIX = "I2B068"
const DATE = "2026-10-02T00:00:00.000Z"
const REASON = "I2b verify reversal reason"
const VOID_REASON = "Duplicate receipt — no stock change (I2 repair)"
const PHANTOMS = [
  "BATCH-1777485228997-9m4gz1e",
  "BATCH-1780037465930-s2vyu5z",
  "BATCH-1780386463378-6pqs19s",
]

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
  const fixtureUsers = []
  let adminId
  for (const role of ["admin", "technicians", "sales", "viewer"]) {
    const email = `verify-068-${role}@test.local`
    const { data: created, error: createError } = await service.auth.admin.createUser({ email, email_confirm: true })
    if (createError) throw new Error(`createUser ${role}: ${createError.message}`)
    fixtureUsers.push(created.user.id)
    if (role === "admin") adminId = created.user.id
    const updated = await db.query(
      `UPDATE public.profiles SET role = $2::public.app_role, active = true WHERE id = $1`,
      [created.user.id, role]
    )
    if (updated.rowCount !== 1) throw new Error(`profile ${role} was not updated`)
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
    return { itemId, txnId, batchId }
  }

  async function move(serial, type, status, extra = {}) {
    const current = await db.query(
      `SELECT id, product_id, serial_number, status, date_added::text AS date_added, location,
              client, notes, assigned_to, purchase_date::text AS purchase_date,
              warranty_end_date::text AS warranty_end_date, assignment_history,
              reserved_for_request_line_id, cloud_key
       FROM public.inventory_items
       WHERE serial_number = $1 AND deleted_at IS NULL`,
      [serial]
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
          status,
          date_added: row.date_added,
          location: extra.location ?? row.location,
          client: extra.client ?? "",
          notes: row.notes,
          assigned_to: null,
          purchase_date: row.purchase_date,
          warranty_end_date: row.warranty_end_date,
          poc_out_date: null,
          return_date: null,
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
          serial_number: serial,
          item_name: productName,
          date: DATE,
          batch_id: batchId,
          from_location: row.location,
          to_location: extra.location ?? row.location,
          client: extra.client ?? "",
        },
      ]),
    ])
    return { txnId, batchId, previous: row.status }
  }

  async function reverse(batchId, confirmed = []) {
    await setUser(db, adminId)
    const result = await db.query(
      `SELECT public.reverse_quick_scan_batch($1, $2, $3, $4::jsonb) AS result`,
      [batchId, REASON, "Warehouse A", JSON.stringify(confirmed)]
    )
    return result.rows[0].result
  }

  async function assertKept(name, batchId, txnId, serial, expectedStatus, deleted) {
    const original = await db.query(`SELECT id FROM public.transactions WHERE id = $1 AND batch_id = $2`, [
      txnId,
      batchId,
    ])
    const linked = await db.query(
      `SELECT id, type, metadata->>'restoreStatus' AS restore
       FROM public.transactions WHERE reverses_transaction_id = $1`,
      [txnId]
    )
    const marker = await db.query(
      `SELECT kind FROM public.batch_reversals WHERE batch_id = $1`,
      [batchId]
    )
    const item = await db.query(
      `SELECT status, deleted_at IS NOT NULL AS deleted
       FROM public.inventory_items WHERE serial_number = $1`,
      [serial]
    )
    const problems = []
    if (original.rowCount !== 1) problems.push("original missing")
    if (linked.rowCount !== 1 || linked.rows[0].type !== "Reversal") problems.push("reversal link missing")
    if (marker.rowCount !== 1 || marker.rows[0].kind !== "reversal") problems.push("batch_reversals missing")
    if (!item.rows[0] || item.rows[0].status !== expectedStatus || item.rows[0].deleted !== deleted) {
      problems.push(`item ${item.rows[0]?.status} deleted=${item.rows[0]?.deleted}`)
    }
    if (linked.rows[0] && !deleted && linked.rows[0].restore !== expectedStatus) {
      problems.push(`restore ${linked.rows[0].restore}`)
    }
    if (problems.length) fail(results, name, problems.join("; "))
    else pass(results, name, `${expectedStatus}${deleted ? " soft-deleted" : ""}`)
    return linked.rows[0]?.id ? (await db.query(`SELECT batch_id FROM public.transactions WHERE id = $1`, [linked.rows[0].id])).rows[0].batch_id : null
  }

  async function cleanup() {
    await db.query(
      `DELETE FROM public.batch_reversals
       WHERE batch_id LIKE $1
          OR batch_id IN (
            SELECT batch_id FROM public.transactions
            WHERE serial_number LIKE $2
               OR COALESCE(metadata->>'reversedBatchId', '') LIKE $1
          )`,
      [`BATCH-${PREFIX}%`, `${PREFIX}%`]
    )
    await db.query(
      `DELETE FROM public.transactions
       WHERE serial_number LIKE $1
          OR batch_id LIKE $2
          OR COALESCE(metadata->>'reversedBatchId', '') LIKE $2`,
      [`${PREFIX}%`, `BATCH-${PREFIX}%`]
    )
    await db.query(`DELETE FROM public.inventory_items WHERE serial_number LIKE $1`, [`${PREFIX}%`])
  }

  async function cleanupUsers() {
    for (const id of fixtureUsers) {
      const { error } = await service.auth.admin.deleteUser(id)
      if (error && !/not found/i.test(error.message)) console.warn(`deleteUser ${id}: ${error.message}`)
    }
  }

  try {
    await checkCreate()
    await checkEachType()
    await checkClientIgnored()
    await checkUnknown()
    await checkOrder()
    await checkGuards()
    await checkVoidFixture()
    fixturesOk = Object.values(results).every((row) => row.result === "PASS")
  } catch (error) {
    fail(results, "fixtures", error instanceof Error ? error.message : String(error))
  } finally {
    await cleanup()
    const residue = await db.query(
      `SELECT
         (SELECT count(*)::int FROM public.transactions
          WHERE serial_number LIKE $1 OR batch_id LIKE $2
             OR COALESCE(metadata->>'reversedBatchId', '') LIKE $2) AS txns,
         (SELECT count(*)::int FROM public.inventory_items WHERE serial_number LIKE $1) AS items,
         (SELECT count(*)::int FROM public.batch_reversals WHERE batch_id LIKE $2) AS markers,
         (SELECT count(*)::int FROM auth.users WHERE email LIKE 'verify-068-%@test.local') AS users`,
      [`${PREFIX}%`, `BATCH-${PREFIX}%`]
    )
    const left = residue.rows[0]
    if (left.txns === 0 && left.items === 0 && left.markers === 0) pass(results, "residue", "no fixture rows left")
    else fail(results, "residue", JSON.stringify(left))
  }

  try {
    if (fixturesOk && results.residue?.result === "PASS") {
      await checkProductionVoid()
    } else {
      fail(results, "production_void", "skipped because fixture checks failed")
    }
  } catch (error) {
    fail(results, "production_void", error instanceof Error ? error.message : String(error))
  } finally {
    await cleanupUsers()
    const users = await db.query(
      `SELECT count(*)::int AS n FROM auth.users WHERE email LIKE 'verify-068-%@test.local'`
    )
    if (users.rows[0].n !== 0) fail(results, "residue", `${users.rows[0].n} test users left`)
  }

  await Promise.race([db.end(), new Promise((resolve) => setTimeout(resolve, 2000))])
  const failed = Object.values(results).some((row) => row.result === "FAIL")
  process.exit(failed ? 1 : 0)

  async function checkCreate() {
    const serial = `${PREFIX}-create`
    const created = await createInbound(serial)
    const reversalBatch = await (async () => {
      await reverse(created.batchId)
      return assertKept("reverse_create", created.batchId, created.txnId, serial, "In Stock", true)
    })()
    const blocked = await raises(
      db,
      `SELECT public.reverse_quick_scan_batch($1, $2, NULL, '[]'::jsonb)`,
      [reversalBatch, REASON],
      "no transactions found"
    )
    if (blocked) fail(results, "reversal_cannot_reverse", blocked)
    else pass(results, "reversal_cannot_reverse", reversalBatch)
  }

  async function checkEachType() {
    const cases = [
      { name: "sale", steps: [{ type: "Sale", status: "Sold" }], restore: "In Stock" },
      { name: "poc_out", steps: [{ type: "POC Out", status: "POC", client: "I2b Client" }], restore: "In Stock" },
      {
        name: "poc_return",
        steps: [
          { type: "POC Out", status: "POC", client: "I2b Client" },
          { type: "POC Return", status: "In Stock" },
        ],
        restore: "POC",
      },
      { name: "rentals", steps: [{ type: "Rentals", status: "Rented", client: "I2b Client" }], restore: "In Stock" },
      {
        name: "rental_return",
        steps: [
          { type: "Rentals", status: "Rented", client: "I2b Client" },
          { type: "Rental Return", status: "Pending Inspection" },
        ],
        restore: "Rented",
      },
      { name: "dispose", steps: [{ type: "Dispose", status: "Disposed" }], restore: "In Stock" },
      { name: "transfer", steps: [{ type: "Transfer", status: "In Stock", location: "Warehouse B" }], restore: "In Stock" },
      {
        name: "sale_return",
        steps: [
          { type: "Sale", status: "Sold" },
          { type: "Sale Return", status: "RMA Hold" },
        ],
        restore: "Sold",
      },
      {
        name: "decommissioned",
        steps: [
          { type: "Sale", status: "Sold" },
          { type: "Decommissioned", status: "Pending Inspection" },
        ],
        restore: "Sold",
      },
      {
        name: "inspection_pass",
        steps: [
          { type: "Sale", status: "Sold" },
          { type: "Decommissioned", status: "Pending Inspection" },
          { type: "Inspection Pass", status: "In Stock" },
        ],
        restore: "Pending Inspection",
      },
      {
        name: "inspection_fail",
        steps: [
          { type: "Sale", status: "Sold" },
          { type: "Decommissioned", status: "Pending Inspection" },
          { type: "Inspection Fail", status: "RMA Hold" },
        ],
        restore: "Pending Inspection",
      },
      { name: "loaner", steps: [{ type: "Remediation Loaner Issue", status: "Sold" }], restore: "In Stock" },
    ]
    for (const entry of cases) {
      const serial = `${PREFIX}-${entry.name}`
      await createInbound(serial)
      let last = null
      for (const step of entry.steps) last = await move(serial, step.type, step.status, step)
      await reverse(last.batchId)
      await assertKept(`reverse_${entry.name}`, last.batchId, last.txnId, serial, entry.restore, false)
    }

    const serial = `${PREFIX}-maint`
    const itemId = nextId("ITEM")
    await db.query(
      `INSERT INTO public.inventory_items (id, product_id, serial_number, status, date_added, location)
       VALUES ($1, $2, $3, 'Maintenance', $4, 'Warehouse A')`,
      [itemId, productId, serial, DATE]
    )
    const inbound = await move(serial, "Inbound", "In Stock")
    await reverse(inbound.batchId)
    await assertKept("reverse_inbound_maintenance", inbound.batchId, inbound.txnId, serial, "Maintenance", false)
  }

  async function checkClientIgnored() {
    const serial = `${PREFIX}-ignore`
    await createInbound(serial)
    const sale = await move(serial, "Sale", "Sold")
    await reverse(sale.batchId, [{ transaction_id: sale.txnId, status: "POC" }])
    const linked = await db.query(
      `SELECT metadata->>'restoreStatus' AS restore FROM public.transactions WHERE reverses_transaction_id = $1`,
      [sale.txnId]
    )
    const item = await db.query(
      `SELECT status FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
      [serial]
    )
    if (item.rows[0]?.status === "In Stock" && linked.rows[0]?.restore === "In Stock") {
      pass(results, "client_status_ignored", "recorded previous_status In Stock")
    } else {
      fail(results, "client_status_ignored", `status ${item.rows[0]?.status} restore ${linked.rows[0]?.restore}`)
    }
  }

  async function checkUnknown() {
    const serial = `${PREFIX}-unknown`
    await createInbound(serial)
    const sale = await move(serial, "Sale", "Sold")
    await db.query(
      `UPDATE public.transactions
       SET previous_status_source = 'unknown', previous_status = 'In Stock'
       WHERE id = $1`,
      [sale.txnId]
    )
    const missing = await raises(
      db,
      `SELECT public.reverse_quick_scan_batch($1, $2, NULL, '[]'::jsonb)`,
      [sale.batchId, REASON],
      "an unknown previous status must be confirmed"
    )
    const illegal = await raises(
      db,
      `SELECT public.reverse_quick_scan_batch($1, $2, NULL, $3::jsonb)`,
      [sale.batchId, REASON, JSON.stringify([{ transaction_id: sale.txnId, status: "Disposed" }])],
      "confirmed status is not a legal predecessor"
    )
    if (missing || illegal) {
      fail(results, "unknown_confirmation", missing || illegal)
      return
    }
    await reverse(sale.batchId, [{ transaction_id: sale.txnId, status: "POC" }])
    const item = await db.query(
      `SELECT status FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
      [serial]
    )
    const linked = await db.query(
      `SELECT metadata->>'restoreStatus' AS restore FROM public.transactions WHERE reverses_transaction_id = $1`,
      [sale.txnId]
    )
    if (item.rows[0]?.status === "POC" && linked.rows[0]?.restore === "POC") {
      pass(results, "unknown_confirmation", "confirmed POC recorded on the Reversal")
    } else {
      fail(results, "unknown_confirmation", `status ${item.rows[0]?.status} restore ${linked.rows[0]?.restore}`)
    }
  }

  async function checkOrder() {
    const serial = `${PREFIX}-order`
    const created = await createInbound(serial)
    const sale = await move(serial, "Sale", "Sold")
    const blocked = await raises(
      db,
      `SELECT public.reverse_quick_scan_batch($1, $2, NULL, '[]'::jsonb)`,
      [created.batchId, REASON],
      sale.batchId
    )
    if (blocked) {
      fail(results, "later_batch_blocks", blocked)
      return
    }
    await reverse(sale.batchId)
    await reverse(created.batchId)
    const item = await db.query(
      `SELECT deleted_at IS NOT NULL AS deleted FROM public.inventory_items WHERE serial_number = $1`,
      [serial]
    )
    if (item.rows[0]?.deleted) pass(results, "later_batch_blocks", `blocked by ${sale.batchId}, then both reversed`)
    else fail(results, "later_batch_blocks", "earlier batch did not reverse after the later one")
  }

  async function checkGuards() {
    const serial = `${PREFIX}-guards`
    const created = await createInbound(serial)
    const empty = await raises(
      db,
      `SELECT public.reverse_quick_scan_batch($1, '', NULL, '[]'::jsonb)`,
      [created.batchId],
      "reason must be at least 15 characters"
    )
    const rejected = []
    for (const role of ["technicians", "sales", "viewer"]) {
      const user = await db.query(`SELECT id FROM public.profiles WHERE id = ANY($1::uuid[]) AND role = $2::public.app_role`, [
        fixtureUsers,
        role,
      ])
      await setUser(db, user.rows[0].id)
      const forbidden = await raises(
        db,
        `SELECT public.reverse_quick_scan_batch($1, $2, NULL, '[]'::jsonb)`,
        [created.batchId, REASON],
        "forbidden"
      )
      if (forbidden) rejected.push(`${role}: ${forbidden}`)
    }
    await setUser(db, adminId)
    const direct = await raises(
      db,
      `UPDATE public.inventory_items SET status = 'Sold' WHERE serial_number = $1`,
      [serial],
      "Invalid inventory status transition"
    )
    const still = await db.query(
      `SELECT status FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
      [serial]
    )
    if (empty || rejected.length > 0 || direct || still.rows[0]?.status !== "In Stock") {
      fail(results, "guards", [empty, ...rejected, direct, still.rows[0]?.status].filter(Boolean).join(" | "))
    } else {
      pass(results, "guards", "empty reason, technician, sales, viewer, and a modeless status update are rejected")
    }
  }

  async function checkVoidFixture() {
    const changed = `${PREFIX}-void-sale`
    await createInbound(changed)
    const sale = await move(changed, "Sale", "Sold")
    const rejected = await raises(
      db,
      `SELECT public.void_batch($1, $2)`,
      [sale.batchId, VOID_REASON],
      "this batch changed stock"
    )

    const serial = `${PREFIX}-void-ok`
    const itemId = nextId("ITEM")
    const txnId = nextId("TXN")
    const batchId = nextId("BATCH")
    await db.query(
      `INSERT INTO public.inventory_items (id, product_id, serial_number, status, date_added, location)
       VALUES ($1, $2, $3, 'In Stock', $4, 'Warehouse A')`,
      [itemId, productId, serial, DATE]
    )
    await db.query(
      `INSERT INTO public.transactions (
         id, type, serial_number, item_name, client, date, batch_id, previous_status, previous_status_source
       ) VALUES ($1, 'Inbound', $2, $3, '', $4, $5, 'In Stock', 'recorded')`,
      [txnId, serial, productName, DATE, batchId]
    )
    await setUser(db, adminId)
    await db.query(`SELECT public.void_batch($1, $2)`, [batchId, VOID_REASON])
    const item = await db.query(
      `SELECT status FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
      [serial]
    )
    const marker = await db.query(`SELECT kind FROM public.batch_reversals WHERE batch_id = $1`, [batchId])
    if (rejected || item.rows[0]?.status !== "In Stock" || marker.rows[0]?.kind !== "void") {
      fail(results, "void_no_effect", rejected || `status ${item.rows[0]?.status} kind ${marker.rows[0]?.kind}`)
    } else {
      pass(results, "void_no_effect", "stock-changing batch rejected; no-effect inbound voided")
    }
  }

  async function saleCountRows() {
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
    for (const row of rows) byId.set(row.client_id, `${row.orders}:${row.units}`)
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
         AND coalesce(txn.batch_id, '') NOT LIKE $2
         AND coalesce(txn.metadata->>'reversedBatchId', '') NOT LIKE $2`,
      [since, `%${PREFIX}%`]
    )
    return new Set(touched.rows.map((row) => row.client_id))
  }

  async function compareSaleCounts(name, beforeRows, since) {
    const afterRows = await saleCountRows()
    const before = indexSaleCounts(beforeRows)
    const after = indexSaleCounts(afterRows)
    const changed = []
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      if (before.get(id) !== after.get(id)) changed.push(id)
    }
    const foreign = await foreignSaleClients(since)
    const unexplained = changed.filter((id) => !foreign.has(id))
    const ignored = changed.filter((id) => foreign.has(id))
    if (unexplained.length) {
      fail(results, name, unexplained.slice(0, 5).join(", "))
    } else if (ignored.length) {
      pass(results, name, `unchanged except ${ignored.join(", ")}`)
    } else {
      pass(results, name, `${after.size} clients unchanged`)
    }
  }

  async function snapshot() {
    const clients = await db.query(
      `SELECT count(*)::int AS clients, coalesce(sum(orders), 0)::int AS orders, coalesce(sum(units), 0)::int AS units
       FROM public.client_sale_dispatch_counts()`
    )
    const stock = await db.query(
      `SELECT status, count(*)::int AS n
       FROM public.inventory_items WHERE deleted_at IS NULL
       GROUP BY status ORDER BY status`
    )
    const low = await db.query(`SELECT count(*)::int AS n FROM public.low_stock_products WHERE is_low`)
    const inboundRows = await db.query(
      `SELECT count(*)::int AS n
       FROM public.transactions AS txn
       WHERE txn.type = 'Inbound'
         AND NOT EXISTS (
           SELECT 1 FROM public.batch_reversals AS reversal WHERE reversal.batch_id = txn.batch_id
         )`
    )
    const chip = await db.query(`SELECT public.transaction_batch_page(1, 0, 'Inbound') AS page`)
    return {
      clients: clients.rows[0],
      stock: stock.rows,
      low: low.rows[0].n,
      inboundRows: inboundRows.rows[0].n,
      inboundChip: chip.rows[0].page.counts?.Inbound ?? 0,
    }
  }

  async function checkProductionVoid() {
    const startedAt = (await db.query(`SELECT clock_timestamp() AS t`)).rows[0].t
    const beforeSales = await saleCountRows()
    const before = await snapshot()
    pass(results, "snapshot", `${beforeSales.length} clients captured`)
    await setUser(db, adminId)
    const already = await db.query(
      `SELECT count(*)::int AS n
       FROM public.batch_reversals
       WHERE batch_id = ANY($1::text[])
         AND kind = 'void'
         AND reversal_reason = $2`,
      [PHANTOMS, VOID_REASON]
    )
    if (already.rows[0].n === PHANTOMS.length) {
      pass(results, "dashboard_unchanged", `inventory and low-stock ${before.low} unchanged`)
      await compareSaleCounts("snapshot_after_void", beforeSales, startedAt)
      pass(
        results,
        "inbound_drop",
        `already voided; live inbound rows ${before.inboundRows}, chip ${before.inboundChip}`
      )
      pass(results, "phantom_voids", PHANTOMS.join(", "))
      return
    }
    const voids = []
    for (const batchId of PHANTOMS) {
      try {
        const result = await db.query(`SELECT public.void_batch($1, $2) AS result`, [batchId, VOID_REASON])
        voids.push(result.rows[0].result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!message.includes("already reversed")) throw error
        const existing = await db.query(
          `SELECT kind, reversal_reason,
                  (SELECT count(*)::int FROM public.transactions WHERE batch_id = $1) AS voided_count
           FROM public.batch_reversals WHERE batch_id = $1`,
          [batchId]
        )
        const row = existing.rows[0]
        if (row?.kind !== "void" || row?.reversal_reason !== VOID_REASON) throw error
        voids.push({ ok: true, batch_id: batchId, voided_count: row.voided_count })
      }
    }
    const after = await snapshot()
    const stockSame = JSON.stringify(before.stock) === JSON.stringify(after.stock) && before.low === after.low
    const rowDrop = before.inboundRows - after.inboundRows
    const chipDrop = before.inboundChip - after.inboundChip
    if (!stockSame) fail(results, "dashboard_unchanged", `stock ${JSON.stringify(before.stock)} -> ${JSON.stringify(after.stock)}; low ${before.low} -> ${after.low}`)
    else pass(results, "dashboard_unchanged", `inventory and low-stock ${before.low} unchanged`)
    await compareSaleCounts("snapshot_after_void", beforeSales, startedAt)
    if (rowDrop !== 95 || chipDrop !== 3) {
      fail(results, "inbound_drop", `rows ${before.inboundRows}->${after.inboundRows} (${rowDrop}); chip ${before.inboundChip}->${after.inboundChip} (${chipDrop})`)
    } else {
      pass(results, "inbound_drop", `rows -95 (${after.inboundRows}); Inbound chip -3 (${after.inboundChip})`)
    }
    pass(results, "phantom_voids", voids.map((row) => `${row.batch_id}:${row.voided_count}`).join(", "))
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
