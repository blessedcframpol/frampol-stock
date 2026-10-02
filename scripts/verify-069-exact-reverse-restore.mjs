/**
 * Exact reverse and restore. Fixture identities are removed in finally.
 *
 * Usage: node scripts/verify-069-exact-reverse-restore.mjs
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"

const require = createRequire(import.meta.url)
const { Client } = require("pg")
const { createClient } = require("@supabase/supabase-js")

const PREFIX = "R3069"
const DATE = "2026-10-02T00:00:00.000Z"
const REASON = "R3 verify reversal reason"
const RESTORE_REASON = "R3 verify restore reason"
const HOLDER = "R3069 Holder"
const ASSIGNEE = "R3069 Assignee"
const VOID_REASON = "Duplicate receipt — no stock change (I2 repair)"
const PHANTOMS = [
  "BATCH-1777485228997-9m4gz1e",
  "BATCH-1780037465930-s2vyu5z",
  "BATCH-1780386463378-6pqs19s",
]
const STUCK = [
  { serial: "1C6A1B5F61ED", batchId: "BATCH-1785225214804-tpcxa2v" },
  { serial: "SMPI-260713-0017-2", batchId: "BATCH-1785243860787-7siycoj" },
  { serial: "SMMM-260727-0025-6", batchId: "BATCH-1786618964456-kh5zr14" },
]
const FIELDS = ["status", "location", "client", "assigned_to", "poc_out_date", "return_date"]

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

function blank(value) {
  return value == null || value === "" ? null : value
}

function sameFields(actual, expected) {
  const problems = []
  for (const key of FIELDS) {
    if (blank(actual?.[key]) !== blank(expected[key])) {
      problems.push(`${key} ${actual?.[key] ?? "null"} != ${expected[key] ?? "null"}`)
    }
  }
  if (Boolean(actual?.deleted) !== Boolean(expected.deleted)) {
    problems.push(`deleted ${actual?.deleted} != ${expected.deleted}`)
  }
  return problems
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
  for (const role of ["admin", "technicians", "viewer"]) {
    const email = `verify-069-${role}@test.local`
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
  const technicianId = fixtureUsers.find((id) => id !== adminId)

  async function readItem(serial) {
    const item = await db.query(
      `SELECT status, location, client, assigned_to, poc_out_date, return_date,
              deleted_at IS NOT NULL AS deleted
       FROM public.inventory_items
       WHERE serial_number = $1
       ORDER BY deleted_at NULLS FIRST, id
       LIMIT 1`,
      [serial]
    )
    return item.rows[0] ?? null
  }

  async function expectItem(name, serial, expected) {
    const row = await readItem(serial)
    const problems = sameFields(row, expected)
    if (problems.length) fail(results, name, problems.join("; "))
    else pass(results, name, expected.deleted ? "soft-deleted" : expected.status)
    return problems.length === 0
  }

  async function createInbound(serial) {
    const itemId = nextId("ITEM")
    const txnId = nextId("TXN")
    const batchId = nextId("BATCH")
    const after = {
      status: "In Stock",
      location: "Warehouse A",
      client: null,
      assigned_to: null,
      poc_out_date: null,
      return_date: null,
      deleted: false,
    }
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
          previous_location: "CLIENT LIE",
        },
      ]),
    ])
    return { itemId, txnId, batchId, after }
  }

  async function move(serial, type, after, extra = {}) {
    const current = await db.query(
      `SELECT id, product_id, serial_number, status, date_added::text AS date_added, location,
              client, notes, assigned_to, purchase_date::text AS purchase_date,
              warranty_end_date::text AS warranty_end_date, assignment_history,
              reserved_for_request_line_id, cloud_key, poc_out_date, return_date
       FROM public.inventory_items
       WHERE serial_number = $1 AND deleted_at IS NULL`,
      [serial]
    )
    const row = current.rows[0]
    const before = {
      status: row.status,
      location: row.location,
      client: blank(row.client),
      assigned_to: blank(row.assigned_to),
      poc_out_date: blank(row.poc_out_date),
      return_date: blank(row.return_date),
      deleted: false,
    }
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
          previous_location: "CLIENT LIE",
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
          from_location: before.location,
          to_location: after.location,
          client: extra.txnClient ?? after.client ?? "",
          assigned_to: extra.txnAssigned ?? after.assigned_to,
          metadata: extra.metadata ?? null,
          previous_location: "CLIENT LIE",
          previous_client: "CLIENT LIE",
          after_location: "CLIENT LIE",
          after_return_date: "CLIENT LIE",
        },
      ]),
    ])
    return { txnId, batchId, before, after: { ...after, deleted: false }, itemId: row.id }
  }

  async function expectRecorded(name, txnId, before, after, created) {
    const txn = await db.query(
      `SELECT previous_status, previous_status_source, previous_location, previous_client,
              previous_assigned_to, previous_poc_out_date, previous_return_date,
              after_status, after_location, after_client, after_assigned_to,
              after_poc_out_date, after_return_date
       FROM public.transactions WHERE id = $1`,
      [txnId]
    )
    const row = txn.rows[0]
    const problems = []
    if (row.previous_status_source !== "recorded") problems.push(`source ${row.previous_status_source}`)
    const previous = created
      ? { status: null, location: null, client: null, assigned_to: null, poc_out_date: null, return_date: null }
      : before
    const recordedPrevious = {
      status: row.previous_status,
      location: row.previous_location,
      client: row.previous_client,
      assigned_to: row.previous_assigned_to,
      poc_out_date: row.previous_poc_out_date,
      return_date: row.previous_return_date,
    }
    const recordedAfter = {
      status: row.after_status,
      location: row.after_location,
      client: row.after_client,
      assigned_to: row.after_assigned_to,
      poc_out_date: row.after_poc_out_date,
      return_date: row.after_return_date,
    }
    for (const key of FIELDS) {
      if (blank(recordedPrevious[key]) !== blank(previous[key])) problems.push(`previous ${key}`)
      if (blank(recordedAfter[key]) !== blank(after[key])) problems.push(`after ${key}`)
    }
    if (problems.length) fail(results, name, problems.join("; "))
    else pass(results, name, "server image, client payload ignored")
    return problems.length === 0
  }

  async function reverse(batchId, entered = [], confirmed = []) {
    await setUser(db, adminId)
    const result = await db.query(
      `SELECT public.reverse_quick_scan_batch($1, $2, NULL, $3::jsonb, $4::jsonb) AS result`,
      [batchId, REASON, JSON.stringify(confirmed), JSON.stringify(entered)]
    )
    return result.rows[0].result
  }

  async function restore(batchId) {
    await setUser(db, adminId)
    await db.query(`SELECT public.restore_batch($1, $2)`, [batchId, RESTORE_REASON])
  }

  async function roundTrip(name, serial, moved) {
    const recordedOk = await expectRecorded(`${name}_recorded`, moved.txnId, moved.before, moved.after, false)
    if (!recordedOk) return
    await reverse(moved.batchId)
    const reversed = await expectItem(`${name}_reverse`, serial, moved.before)
    if (!reversed) return
    const kept = await db.query(
      `SELECT
         (SELECT count(*)::int FROM public.transactions WHERE id = $1) AS original,
         (SELECT count(*)::int FROM public.transactions WHERE reverses_transaction_id = $1) AS reversal
      `,
      [moved.txnId]
    )
    await restore(moved.batchId)
    const restored = await expectItem(`${name}_restore`, serial, moved.after)
    const audit = await db.query(
      `SELECT
         (SELECT count(*)::int FROM public.transactions WHERE id = $1) AS original,
         (SELECT count(*)::int FROM public.transactions WHERE reverses_transaction_id = $1) AS reversal,
         (SELECT count(*)::int FROM public.batch_reversals WHERE batch_id = $2) AS marker,
         (SELECT count(*)::int FROM public.batch_restores WHERE batch_id = $2) AS restores,
         (SELECT count(*)::int FROM public.active_transactions WHERE id = $1) AS active`,
      [moved.txnId, moved.batchId]
    )
    const row = audit.rows[0]
    if (
      restored &&
      kept.rows[0].original === 1 &&
      kept.rows[0].reversal === 1 &&
      row.original === 1 &&
      row.reversal === 1 &&
      row.marker === 1 &&
      row.restores === 1 &&
      row.active === 1
    ) {
      pass(results, `${name}_kept`, "original and reversal kept; batch active again")
    } else if (restored) {
      fail(results, `${name}_kept`, JSON.stringify(row))
    }
  }

  async function cleanup() {
    await db.query(
      `DELETE FROM public.holding_extensions
       WHERE item_id LIKE $1 OR serial_number LIKE $2`,
      [`ITEM-${PREFIX}-%`, `${PREFIX}-%`]
    )
    await db.query(
      `DELETE FROM public.batch_restores
       WHERE batch_id LIKE $1
          OR batch_id IN (
            SELECT batch_id FROM public.transactions
            WHERE serial_number LIKE $2 OR COALESCE(metadata->>'reversedBatchId', '') LIKE $1
          )`,
      [`BATCH-${PREFIX}-%`, `${PREFIX}-%`]
    )
    await db.query(
      `DELETE FROM public.batch_reversals
       WHERE batch_id LIKE $1
          OR batch_id IN (
            SELECT batch_id FROM public.transactions
            WHERE serial_number LIKE $2 OR COALESCE(metadata->>'reversedBatchId', '') LIKE $1
          )`,
      [`BATCH-${PREFIX}-%`, `${PREFIX}-%`]
    )
    await db.query(
      `DELETE FROM public.transactions
       WHERE serial_number LIKE $1
          OR batch_id LIKE $2
          OR COALESCE(metadata->>'reversedBatchId', '') LIKE $2`,
      [`${PREFIX}-%`, `BATCH-${PREFIX}-%`]
    )
    await db.query(`DELETE FROM public.inventory_items WHERE serial_number LIKE $1`, [`${PREFIX}-%`])
  }

  async function cleanupUsers() {
    for (const id of fixtureUsers) {
      const { error } = await service.auth.admin.deleteUser(id)
      if (error && !/not found/i.test(error.message)) console.warn(`deleteUser ${id}: ${error.message}`)
    }
  }

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
         AND coalesce(txn.batch_id, '') NOT LIKE $2
         AND coalesce(txn.metadata->>'reversedBatchId', '') NOT LIKE $2`,
      [since, `%${PREFIX}%`]
    )
    return new Set(touched.rows.map((row) => row.client_id))
  }

  const saleClock = await db.query(`SELECT clock_timestamp() AS started_at`)
  const saleStartedAt = saleClock.rows[0].started_at
  const beforeShot = await snapshot()
  const stock = {
    status: "In Stock",
    location: "Warehouse A",
    client: null,
    assigned_to: null,
    poc_out_date: null,
    return_date: null,
  }
  const held = {
    client: HOLDER,
    assigned_to: ASSIGNEE,
    poc_out_date: "2026-09-15",
    return_date: "2026-11-01",
  }

  try {
    const created = await createInbound(`${PREFIX}-create`)
    await expectRecorded("create_recorded", created.txnId, stock, created.after, true)
    await setUser(db, technicianId)
    const forbidden = await raises(
      db,
      `SELECT public.reverse_quick_scan_batch($1, $2, NULL, '[]'::jsonb, '[]'::jsonb)`,
      [created.batchId, REASON],
      "forbidden"
    )
    if (forbidden) fail(results, "technician_forbidden", forbidden)
    else pass(results, "technician_forbidden", "technician cannot reverse")
    await reverse(created.batchId)
    await expectItem("create_reverse", `${PREFIX}-create`, { ...created.after, deleted: true })
    const reversalLeft = await db.query(
      `SELECT count(*)::int AS n FROM public.transactions WHERE reverses_transaction_id = $1`,
      [created.txnId]
    )
    await restore(created.batchId)
    const createRestored = await expectItem("create_restore", `${PREFIX}-create`, created.after)
    const createActive = await db.query(
      `SELECT count(*)::int AS n FROM public.active_transactions WHERE id = $1`,
      [created.txnId]
    )
    if (createRestored && reversalLeft.rows[0].n === 1 && createActive.rows[0].n === 1) {
      pass(results, "create_kept", "create reversal kept and the receipt counts again")
    } else if (createRestored) {
      fail(results, "create_kept", `reversal ${reversalLeft.rows[0].n} active ${createActive.rows[0].n}`)
    }

    const cases = [
      { name: "sale", type: "Sale", after: { ...stock, status: "Sold", location: "Delivered", client: HOLDER, assigned_to: ASSIGNEE } },
      { name: "poc_out", type: "POC Out", after: { ...stock, status: "POC", location: "Client Site", ...held } },
      { name: "rentals", type: "Rentals", after: { ...stock, status: "Rented", location: "Client Site", ...held } },
      { name: "dispose", type: "Dispose", after: { ...stock, status: "Disposed" } },
      { name: "transfer", type: "Transfer", after: { ...stock, location: "Warehouse B" } },
      { name: "loaner", type: "Remediation Loaner Issue", after: { ...stock, status: "Sold", location: "Delivered", client: HOLDER, assigned_to: ASSIGNEE } },
    ]
    for (const entry of cases) {
      const serial = `${PREFIX}-${entry.name}`
      await createInbound(serial)
      const moved = await move(serial, entry.type, entry.after)
      await roundTrip(entry.name, serial, moved)
    }

    {
      const serial = `${PREFIX}-poc-return`
      const createdPoc = await createInbound(serial)
      const issued = await move(serial, "POC Out", { ...stock, status: "POC", location: "Client Site", ...held })
      await setUser(db, adminId)
      await db.query(`SELECT public.extend_holding($1, $2, $3)`, [createdPoc.itemId, "2027-01-15", "R3 extend"])
      const extended = await readItem(serial)
      const issuedTxn = await db.query(`SELECT after_return_date FROM public.transactions WHERE id = $1`, [issued.txnId])
      if (extended?.return_date === "2027-01-15" && issuedTxn.rows[0].after_return_date === "2026-11-01") {
        pass(results, "extend_keeps_movement_date", "Extend date is on the kit; the POC Out after-image stays")
      } else {
        fail(
          results,
          "extend_keeps_movement_date",
          `kit ${extended?.return_date} txn ${issuedTxn.rows[0].after_return_date}`
        )
      }
      const returned = await move(
        serial,
        "POC Return",
        stock,
        { txnClient: HOLDER, txnAssigned: ASSIGNEE }
      )
      if (returned.before.return_date !== "2027-01-15") {
        fail(results, "poc_return_recorded", `previous return date ${returned.before.return_date}`)
      } else {
        await roundTrip("poc_return", serial, returned)
      }
    }

    {
      const serial = `${PREFIX}-rental-return`
      await createInbound(serial)
      await move(serial, "Rentals", { ...stock, status: "Rented", location: "Client Site", ...held })
      const returned = await move(serial, "Rental Return", stock, { txnClient: HOLDER, txnAssigned: ASSIGNEE })
      await roundTrip("rental_return", serial, returned)
    }

    {
      const serial = `${PREFIX}-sale-return`
      await createInbound(serial)
      await move(serial, "Sale", { ...stock, status: "Sold", location: "Delivered", client: HOLDER, assigned_to: ASSIGNEE })
      const returned = await move(
        serial,
        "Sale Return",
        { ...stock, status: "RMA Hold" },
        { txnClient: HOLDER, txnAssigned: ASSIGNEE }
      )
      await roundTrip("sale_return", serial, returned)
    }

    {
      const serial = `${PREFIX}-decommissioned`
      await createInbound(serial)
      await move(serial, "Sale", { ...stock, status: "Sold", location: "Delivered", client: HOLDER, assigned_to: ASSIGNEE })
      const moved = await move(serial, "Decommissioned", {
        ...stock,
        status: "Pending Inspection",
        location: "Service Center",
      })
      await roundTrip("decommissioned", serial, moved)
    }

    {
      const serial = `${PREFIX}-inspection-pass`
      await createInbound(serial)
      await move(serial, "Sale", { ...stock, status: "Sold", location: "Delivered", client: HOLDER, assigned_to: ASSIGNEE })
      await move(serial, "Decommissioned", { ...stock, status: "Pending Inspection", location: "Service Center" })
      const moved = await move(serial, "Inspection Pass", stock)
      await roundTrip("inspection_pass", serial, moved)
    }

    {
      const serial = `${PREFIX}-inspection-fail`
      await createInbound(serial)
      await move(serial, "Sale", { ...stock, status: "Sold", location: "Delivered", client: HOLDER, assigned_to: ASSIGNEE })
      await move(serial, "Decommissioned", { ...stock, status: "Pending Inspection", location: "Service Center" })
      const moved = await move(serial, "Inspection Fail", { ...stock, status: "RMA Hold" })
      await roundTrip("inspection_fail", serial, moved)
    }

    {
      const serial = `${PREFIX}-maint-inbound`
      const itemId = nextId("ITEM")
      await db.query(
        `INSERT INTO public.inventory_items (id, product_id, serial_number, status, date_added, location, client, assigned_to)
         VALUES ($1, $2, $3, 'Maintenance', $4, 'Service Center', $5, $6)`,
        [itemId, productId, serial, DATE, HOLDER, ASSIGNEE]
      )
      const moved = await move(serial, "Inbound", stock)
      await roundTrip("maint_inbound", serial, moved)
    }

    {
      const serial = `${PREFIX}-legacy-return`
      await createInbound(serial)
      await move(serial, "POC Out", {
        ...stock,
        status: "POC",
        location: "Client Site",
        client: HOLDER,
        assigned_to: ASSIGNEE,
        poc_out_date: "2026-09-15",
        return_date: "2026-11-01",
      })
      const returned = await move(serial, "POC Return", stock, { txnClient: HOLDER, txnAssigned: ASSIGNEE })
      await db.query(
        `UPDATE public.transactions
         SET previous_location = NULL, previous_client = NULL, previous_assigned_to = NULL,
             previous_poc_out_date = NULL, previous_return_date = NULL,
             after_status = NULL, after_location = NULL, after_client = NULL,
             after_assigned_to = NULL, after_poc_out_date = NULL, after_return_date = NULL
         WHERE id = $1`,
        [returned.txnId]
      )
      const missing = await raises(
        db,
        `SELECT public.reverse_quick_scan_batch($1, $2, NULL, '[]'::jsonb, '[]'::jsonb)`,
        [returned.batchId, REASON],
        "return date must be entered at reversal"
      )
      if (missing) {
        fail(results, "legacy_return_requires_date", missing)
      } else {
        await reverse(returned.batchId, [{ transaction_id: returned.txnId, return_date: "2026-12-15" }])
        const ok = await expectItem("legacy_return", serial, {
          status: "POC",
          location: "Client Site",
          client: HOLDER,
          assigned_to: ASSIGNEE,
          poc_out_date: "2026-10-02",
          return_date: "2026-12-15",
          deleted: false,
        })
        const label = await db.query(
          `SELECT metadata -> 'entered at reversal' AS entered
           FROM public.transactions WHERE reverses_transaction_id = $1`,
          [returned.txnId]
        )
        const entered = label.rows[0]?.entered
        if (ok && entered?.return_date === "2026-12-15" && entered.location == null) {
          pass(results, "legacy_return_label", "entered at reversal")
        } else if (ok) {
          fail(results, "legacy_return_label", JSON.stringify(entered))
        }
      }
    }

    {
      const serial = `${PREFIX}-legacy-sale`
      await createInbound(serial)
      await move(serial, "POC Out", { ...stock, status: "POC", location: "Client Site", ...held })
      const sold = await move(
        serial,
        "Sale",
        { ...stock, status: "Sold", location: "Delivered", client: HOLDER, assigned_to: ASSIGNEE, poc_out_date: "2026-09-15" },
        { metadata: { converted_from: "POC", poc_out_date: "2026-08-01" } }
      )
      await db.query(
        `UPDATE public.transactions
         SET previous_location = NULL, previous_client = NULL, previous_assigned_to = NULL,
             previous_poc_out_date = NULL, previous_return_date = NULL,
             after_status = NULL, after_location = NULL, after_client = NULL,
             after_assigned_to = NULL, after_poc_out_date = NULL, after_return_date = NULL
         WHERE id = $1`,
        [sold.txnId]
      )
      const missing = await raises(
        db,
        `SELECT public.reverse_quick_scan_batch($1, $2, NULL, '[]'::jsonb, '[]'::jsonb)`,
        [sold.batchId, REASON],
        "return date must be entered at reversal"
      )
      if (missing) {
        fail(results, "legacy_sale_requires_date", missing)
      } else {
        await reverse(sold.batchId, [{ transaction_id: sold.txnId, return_date: "2026-12-20" }])
        const ok = await expectItem("legacy_converted_sale", serial, {
          status: "POC",
          location: "Client Site",
          client: HOLDER,
          assigned_to: ASSIGNEE,
          poc_out_date: "2026-08-01",
          return_date: "2026-12-20",
          deleted: false,
        })
        const label = await db.query(
          `SELECT metadata -> 'entered at reversal' ->> 'return_date' AS return_date
           FROM public.transactions WHERE reverses_transaction_id = $1`,
          [sold.txnId]
        )
        if (ok && label.rows[0]?.return_date === "2026-12-20") pass(results, "legacy_sale_label", "entered at reversal")
        else if (ok) fail(results, "legacy_sale_label", JSON.stringify(label.rows[0]))
      }
    }

    {
      const serial = `${PREFIX}-legacy-warehouse`
      await createInbound(serial)
      const sold = await move(serial, "Sale", {
        ...stock,
        status: "Sold",
        location: "Delivered",
        client: HOLDER,
        assigned_to: ASSIGNEE,
      })
      await db.query(
        `UPDATE public.transactions
         SET previous_location = NULL, previous_client = NULL, previous_assigned_to = NULL,
             previous_poc_out_date = NULL, previous_return_date = NULL,
             after_status = NULL, after_location = NULL, after_client = NULL,
             after_assigned_to = NULL, after_poc_out_date = NULL, after_return_date = NULL
         WHERE id = $1`,
        [sold.txnId]
      )
      const missing = await raises(
        db,
        `SELECT public.reverse_quick_scan_batch($1, $2, NULL, '[]'::jsonb, '[]'::jsonb)`,
        [sold.batchId, REASON],
        "location must be entered at reversal"
      )
      if (missing) {
        fail(results, "legacy_warehouse_required", missing)
      } else {
        await reverse(sold.batchId, [{ transaction_id: sold.txnId, location: "Warehouse B" }])
        await expectItem("legacy_warehouse", serial, { ...stock, location: "Warehouse B", deleted: false })
      }
    }

    {
      const serial = `${PREFIX}-void`
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
           id, type, serial_number, item_name, client, date, batch_id, to_location,
           previous_status, previous_status_source
         ) VALUES ($1, 'Inbound', $2, $3, '', $4, $5, 'Warehouse A', 'In Stock', 'recorded')`,
        [txnId, serial, productName, DATE, batchId]
      )
      await setUser(db, adminId)
      await db.query(`SELECT public.void_batch($1, $2)`, [batchId, RESTORE_REASON])
      const voided = await readItem(serial)
      await restore(batchId)
      const back = await readItem(serial)
      const active = await db.query(`SELECT count(*)::int AS n FROM public.active_transactions WHERE id = $1`, [txnId])
      if (
        voided?.status === "In Stock" &&
        voided.location === "Warehouse A" &&
        back?.status === "In Stock" &&
        back.location === "Warehouse A" &&
        active.rows[0].n === 1
      ) {
        pass(results, "void_restore", "void restore changes no stock and the receipt counts again")
      } else {
        fail(results, "void_restore", `before ${voided?.status} after ${back?.status} active ${active.rows[0].n}`)
      }
    }

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
         (SELECT count(*)::int FROM public.batch_restores WHERE batch_id LIKE $2) AS restores,
         (SELECT count(*)::int FROM public.holding_extensions WHERE item_id LIKE $3 OR serial_number LIKE $1) AS extensions,
         (SELECT count(*)::int FROM auth.users WHERE email LIKE 'verify-069-%@test.local') AS users`,
      [`${PREFIX}-%`, `BATCH-${PREFIX}-%`, `ITEM-${PREFIX}-%`]
    )
    const left = residue.rows[0]
    if (
      left.txns === 0 &&
      left.items === 0 &&
      left.markers === 0 &&
      left.restores === 0 &&
      left.extensions === 0
    ) {
      pass(results, "residue", "no fixture rows left")
    } else {
      fail(results, "residue", JSON.stringify(left))
    }
  }

  try {
    if (fixturesOk && results.residue?.result === "PASS") {
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
      if (unexplained.length) {
        fail(results, "snapshot", unexplained.slice(0, 5).join(", "))
      } else if (ignored.length) {
        pass(results, "snapshot", `${afterShot.length} clients; ignored ${ignored.join(", ")}`)
      } else {
        pass(results, "snapshot", `${afterShot.length} / ${orders} / ${units} unchanged by this run`)
      }
      const phantoms = await db.query(
        `SELECT reversal.batch_id, reversal.kind, reversal.reversal_reason,
                public.batch_is_currently_reversed(reversal.batch_id) AS reversed,
                (SELECT count(*)::int FROM public.batch_restores AS restored WHERE restored.batch_id = reversal.batch_id) AS restores
         FROM public.batch_reversals AS reversal
         WHERE reversal.batch_id = ANY($1::text[])
         ORDER BY reversal.batch_id`,
        [PHANTOMS]
      )
      const intact =
        phantoms.rowCount === 3 &&
        phantoms.rows.every(
          (row) => row.kind === "void" && row.reversal_reason === VOID_REASON && row.reversed === true && row.restores === 0
        )
      if (intact) pass(results, "phantoms", "three voided receipts stayed voided")
      else fail(results, "phantoms", JSON.stringify(phantoms.rows))

      for (const stuck of STUCK) {
        const plan = await db.query(`SELECT public.reverse_restore_plan($1) AS plan`, [stuck.batchId])
        console.log(`PLAN  ${stuck.serial} ${JSON.stringify(plan.rows[0].plan)}`)
        const rows = plan.rows[0].plan.rows ?? []
        const row = rows[0]
        const needs = Array.isArray(row?.needs) ? row.needs : []
        if (
          rows.length === 1 &&
          row.serial === stuck.serial &&
          row.hasImage === false &&
          row.status === "In Stock" &&
          row.client == null &&
          row.assignedTo == null &&
          row.location == null &&
          row.returnDate == null &&
          row.pocOutDate == null &&
          needs.includes("location") &&
          !needs.includes("return_date")
        ) {
          pass(results, `stuck_${stuck.serial}`, "In Stock, no holder, warehouse must be entered")
        } else {
          fail(results, `stuck_${stuck.serial}`, JSON.stringify(row))
        }
      }
    } else {
      fail(results, "production_check", "skipped because fixture checks failed")
    }
  } catch (error) {
    fail(results, "production_check", error instanceof Error ? error.message : String(error))
  } finally {
    await cleanupUsers()
    const users = await db.query(
      `SELECT count(*)::int AS n FROM auth.users WHERE email LIKE 'verify-069-%@test.local'`
    )
    if (users.rows[0].n !== 0) fail(results, "residue", `${users.rows[0].n} test users left`)
  }

  await Promise.race([db.end(), new Promise((resolve) => setTimeout(resolve, 2000))])
  const failed = Object.values(results).some((row) => row.result === "FAIL")
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
