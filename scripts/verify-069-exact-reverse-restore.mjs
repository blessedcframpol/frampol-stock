/**
 * Exact reverse and restore — rollback harness (BEGIN…ROLLBACK, never commits).
 * Usage: node scripts/verify-069-exact-reverse-restore.mjs
 */
import { withHarness } from "./verify-harness.mjs"

// Distinct from leftover R3069-* residue still in production (A1 blocked cleanup).
const PREFIX = "H3069"
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

async function raises(db, sql, params, needle) {
  const sp = `sp_${Math.random().toString(36).slice(2, 10)}`
  await db.query(`SAVEPOINT ${sp}`)
  try {
    await db.query(sql, params)
    await db.query(`ROLLBACK TO SAVEPOINT ${sp}`)
    return `expected ${needle}`
  } catch (error) {
    await db.query(`ROLLBACK TO SAVEPOINT ${sp}`)
    const message = error instanceof Error ? error.message : String(error)
    return message.includes(needle) ? null : message
  }
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


export const MARKERS = [
  {
    label: "transactions",
    sql: `SELECT count(*)::int AS n FROM public.transactions
          WHERE serial_number LIKE $1 OR batch_id LIKE $2
             OR COALESCE(metadata->>'reversedBatchId', '') LIKE $2`,
    params: [`${PREFIX}-%`, `BATCH-${PREFIX}-%`],
  },
  {
    label: "items",
    sql: `SELECT count(*)::int AS n FROM public.inventory_items WHERE serial_number LIKE $1`,
    params: [`${PREFIX}-%`],
  },
  {
    label: "batch_reversals",
    sql: `SELECT count(*)::int AS n FROM public.batch_reversals WHERE batch_id LIKE $1`,
    params: [`BATCH-${PREFIX}-%`],
  },
  {
    label: "batch_restores",
    sql: `SELECT count(*)::int AS n FROM public.batch_restores WHERE batch_id LIKE $1`,
    params: [`BATCH-${PREFIX}-%`],
  },
  {
    label: "holding_extensions",
    sql: `SELECT count(*)::int AS n FROM public.holding_extensions
          WHERE item_id LIKE $1 OR serial_number LIKE $2`,
    params: [`ITEM-${PREFIX}-%`, `${PREFIX}-%`],
  },
  {
    label: "users",
    sql: `SELECT count(*)::int AS n FROM auth.users WHERE email LIKE 'harness-069-%@test.local'`,
    params: [],
  },
]

export async function runChecks(ctx) {
  const db = ctx.db
  const results = ctx.results
  const pass = (name, reason) => ctx.pass(name, reason)
  const fail = (name, reason) => ctx.fail(name, reason)

  async function setUser(_db, userId) {
    await db.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ])
  }

  const product = await db.query(
    `SELECT id, product_name FROM public.product_lines
     WHERE is_active AND vendor = 'Starlink'
     ORDER BY id
     LIMIT 1`
  )
  if (!product.rows[0]) throw new Error("no active Starlink product for the rental fixture")
  const productId = product.rows[0].id
  const productName = product.rows[0].product_name

  const adminId = await ctx.createFixtureUser("admin", "harness-069-admin@test.local")
  const technicianId = await ctx.createFixtureUser("technicians", "harness-069-technicians@test.local")
  await ctx.createFixtureUser("viewer", "harness-069-viewer@test.local")

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
    if (problems.length) fail(name, problems.join("; "))
    else pass(name, expected.deleted ? "soft-deleted" : expected.status)
    return problems.length === 0
  }

  // apply_stock_movement creates _movement_prev ON COMMIT DROP — it survives every
  // call inside the harness transaction. Drop before each apply so CREATE TEMP works.
  async function dropMovementPrev() {
    await db.query(`DROP TABLE IF EXISTS _movement_prev`)
  }

  // now() / created_at is frozen for the outer harness transaction. reverse_restore_plan
  // looks up prior POC Out / Rentals with a strict created_at < comparison (no id
  // tie-break), so stamp each new movement slightly later than the last.
  let txnTick = 0
  async function stampTxn(...txnIds) {
    for (const txnId of txnIds) {
      txnTick += 1
      const at = new Date(Date.parse(DATE) + txnTick).toISOString()
      await db.query(`UPDATE public.transactions SET created_at = $2::timestamptz WHERE id = $1`, [
        txnId,
        at,
      ])
    }
  }

  // now() is frozen for the outer harness transaction, so reverse + restore get the
  // same timestamp and batch_is_currently_reversed stays true (reversed_at >= restored_at).
  // Nudge restored_at forward so the batch counts as active again inside the txn.
  async function bumpRestoreClock(batchId) {
    await db.query(
      `UPDATE public.batch_restores
       SET restored_at = restored_at + interval '1 millisecond'
       WHERE ctid = (
         SELECT ctid FROM public.batch_restores
         WHERE batch_id = $1
         ORDER BY restored_at DESC
         LIMIT 1
       )`,
      [batchId]
    )
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
    await dropMovementPrev()
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
    await stampTxn(txnId)
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
    await dropMovementPrev()
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
          disposal_reason: type === "Dispose" ? "Beyond economical repair for fixture" : null,
          authorised_by: type === "Dispose" ? adminId : null,
          metadata: (() => {
            const base =
              extra.metadata
                ? { ...extra.metadata }
                : type === "Rental Return" || type === "Decommissioned"
                  ? {
                      reason_category: "Client cancelled",
                      reason_text: "Recorded reason for the return",
                    }
                  : {}
            if (
              (type === "Sale" || type === "Rentals") &&
              !base.invoice_choice
            ) {
              base.invoice_choice = "pending"
            }
            return Object.keys(base).length ? base : null
          })(),
          return_pool: extra.returnPool,
          previous_location: "CLIENT LIE",
          previous_client: "CLIENT LIE",
          after_location: "CLIENT LIE",
          after_return_date: "CLIENT LIE",
        },
      ]),
    ])
    await stampTxn(txnId)
    const keptHolder = type === "Decommissioned" || type === "Rental Return"
    return {
      txnId,
      batchId,
      before,
      after: keptHolder
        ? { ...after, client: before.client, assigned_to: before.assigned_to, deleted: false }
        : { ...after, deleted: false },
      itemId: row.id,
    }
  }

  async function inspect(serial, { result, outcome, location, after }) {
    const current = await db.query(
      `SELECT id, status, location, client, assigned_to, poc_out_date, return_date
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
    const openCase = await db.query(
      `SELECT id FROM public.kit_cases
       WHERE inventory_item_id = $1 AND stage = 'open' AND case_type = 'decommission'`,
      [row.id]
    )
    if (!openCase.rows[0]) throw new Error(`no open case for ${serial}`)
    await setUser(db, adminId)
    await dropMovementPrev()
    await db.query(
      `SELECT public.complete_inspection($1, $2, $3, $4, $5, $6, NULL)`,
      [
        openCase.rows[0].id,
        result,
        "Checked the kit before choosing an outcome",
        result === "Pass" ? "A" : "C",
        outcome,
        location,
      ]
    )
    const applied = await db.query(
      `SELECT payload->>'transaction_id' AS transaction_id, payload->>'batch_id' AS batch_id
       FROM public.kit_case_events
       WHERE case_id = $1 AND event_type = 'outcome_applied'
       ORDER BY at DESC
       LIMIT 1`,
      [openCase.rows[0].id]
    )
    const recorded = applied.rows[0]
    if (!recorded?.transaction_id || !recorded.batch_id) throw new Error(`inspection wrote no movement for ${serial}`)
    await stampTxn(recorded.transaction_id)
    return {
      txnId: recorded.transaction_id,
      batchId: recorded.batch_id,
      before,
      after: { ...after, deleted: false },
      itemId: row.id,
    }
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
    if (problems.length) fail(name, problems.join("; "))
    else pass(name, "server image, client payload ignored")
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
    await bumpRestoreClock(batchId)
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
      pass(`${name}_kept`, "original and reversal kept; batch active again")
    } else if (restored) {
      fail(`${name}_kept`, JSON.stringify(row))
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

  let fixturesOk = false
  try {
    const created = await createInbound(`${PREFIX}-create`)
    await expectRecorded("create_recorded", created.txnId, stock, created.after, true)
    const forbidden = await ctx.asUser(technicianId, async () =>
      raises(db, `SELECT public.reverse_quick_scan_batch($1, $2, NULL, '[]'::jsonb, '[]'::jsonb)`, [created.batchId, REASON], "forbidden")
    )
    if (forbidden) fail("technician_forbidden", forbidden)
    else pass("technician_forbidden", "technician cannot reverse")
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
      pass("create_kept", "create reversal kept and the receipt counts again")
    } else if (createRestored) {
      fail("create_kept", `reversal ${reversalLeft.rows[0].n} active ${createActive.rows[0].n}`)
    }

    const cases = [
      { name: "sale", type: "Sale", after: { ...stock, status: "Sold", location: "Delivered", client: HOLDER, assigned_to: ASSIGNEE } },
      { name: "poc_out", type: "POC Out", after: { ...stock, status: "POC", location: "Client Site", ...held } },
      { name: "rentals", type: "Rentals", after: { ...stock, status: "Rented", location: "Client Site", ...held } },
      { name: "dispose", type: "Dispose", after: { ...stock, status: "Disposed" } },
      { name: "transfer", type: "Transfer", after: { ...stock, location: "Warehouse B" } },
      // Remediation Loaner Issue removed in P3.6.
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
        pass("extend_keeps_movement_date", "Extend date is on the kit; the POC Out after-image stays")
      } else {
        fail(
          "extend_keeps_movement_date",
          `kit ${extended?.return_date} txn ${issuedTxn.rows[0].after_return_date}`
        )
      }
      const returned = await move(
        serial,
        "POC Return",
        stock,
        { txnClient: HOLDER, txnAssigned: ASSIGNEE, returnPool: "sale" }
      )
      if (returned.before.return_date !== "2027-01-15") {
        fail("poc_return_recorded", `previous return date ${returned.before.return_date}`)
      } else {
        await roundTrip("poc_return", serial, returned)
      }
    }

    {
      const serial = `${PREFIX}-rental-return`
      await createInbound(serial)
      await move(serial, "Rentals", { ...stock, status: "Rented", location: "Client Site", ...held })
      const returned = await move(serial, "Rental Return", { ...stock, status: "Pending Inspection" }, { txnClient: HOLDER, txnAssigned: ASSIGNEE })
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
      const moved = await inspect(serial, {
        result: "Pass",
        outcome: "Resell",
        location: "Warehouse A",
        after: stock,
      })
      await roundTrip("inspection_pass", serial, moved)
    }

    {
      const serial = `${PREFIX}-inspection-fail`
      await createInbound(serial)
      await move(serial, "Sale", { ...stock, status: "Sold", location: "Delivered", client: HOLDER, assigned_to: ASSIGNEE })
      await move(serial, "Decommissioned", { ...stock, status: "Pending Inspection", location: "Service Center" })
      const moved = await inspect(serial, {
        result: "Fail",
        outcome: "Return to vendor",
        location: null,
        after: {
          status: "RMA Hold",
          location: "Service Center",
          client: HOLDER,
          assigned_to: ASSIGNEE,
          poc_out_date: null,
          return_date: null,
        },
      })
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
      const returned = await move(serial, "POC Return", stock, { txnClient: HOLDER, txnAssigned: ASSIGNEE, returnPool: "sale" })
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
        fail("legacy_return_requires_date", missing)
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
          pass("legacy_return_label", "entered at reversal")
        } else if (ok) {
          fail("legacy_return_label", JSON.stringify(entered))
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
        fail("legacy_sale_requires_date", missing)
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
        if (ok && label.rows[0]?.return_date === "2026-12-20") pass("legacy_sale_label", "entered at reversal")
        else if (ok) fail("legacy_sale_label", JSON.stringify(label.rows[0]))
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
        fail("legacy_warehouse_required", missing)
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
      await stampTxn(txnId)
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
        pass("void_restore", "void restore changes no stock and the receipt counts again")
      } else {
        fail("void_restore", `before ${voided?.status} after ${back?.status} active ${active.rows[0].n}`)
      }
    }

    fixturesOk = Object.values(results).every((row) => row.result === "PASS")
  } catch (error) {
    fail("fixtures", error instanceof Error ? error.message : String(error))
  }

  try {
    // Residue absence is asserted by harness markers after ROLLBACK (no in-txn cleanup).
    if (fixturesOk) {
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
        fail("snapshot", unexplained.slice(0, 5).join(", "))
      } else if (ignored.length) {
        pass("snapshot", `${afterShot.length} clients; ignored ${ignored.join(", ")}`)
      } else {
        pass("snapshot", `${afterShot.length} / ${orders} / ${units} unchanged by this run`)
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
      if (intact) pass("phantoms", "three voided receipts stayed voided")
      else fail("phantoms", JSON.stringify(phantoms.rows))

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
          pass(`stuck_${stuck.serial}`, "In Stock, no holder, warehouse must be entered")
        } else {
          fail(`stuck_${stuck.serial}`, JSON.stringify(row))
        }
      }
    } else {
      fail("production_check", "skipped because fixture checks failed")
    }
  } catch (error) {
    fail("production_check", error instanceof Error ? error.message : String(error))
  }

}

async function main() {
  const { ok, failed, passed } = await withHarness(
    { markers: MARKERS, timeoutMs: 300_000, label: "verify-069" },
    runChecks,
  )
  console.log(ok ? `\n${passed} passed` : `\n${failed} failed`)
  process.exitCode = ok ? 0 : 1
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-069-exact-reverse-restore.mjs")
if (isMain) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
