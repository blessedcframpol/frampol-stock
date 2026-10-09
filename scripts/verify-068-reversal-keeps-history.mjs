/**
 * Reversal keeps the original rows and restores previous_status.
 * Runs inside the rollback harness: BEGIN … ROLLBACK, never commits.
 *
 * Usage: node scripts/verify-068-reversal-keeps-history.mjs
 */
import { withHarness } from "./verify-harness.mjs"
import { dropMovementPrev, stampTxn, setJwt } from "./verify-harness-fixtures.mjs"

// Distinct from leftover I2B068-* residue still in production.
const PREFIX = "H3068"
const DATE = "2026-10-02T00:00:00.000Z"
const REASON = "I2b verify reversal reason"
const VOID_REASON = "Duplicate receipt — no stock change (I2 repair)"
const PHANTOMS = [
  "BATCH-1777485228997-9m4gz1e",
  "BATCH-1780037465930-s2vyu5z",
  "BATCH-1780386463378-6pqs19s",
]

let seq = 0
function nextId(kind) {
  seq += 1
  return `${kind}-${PREFIX}-${seq}`
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
    label: "users",
    sql: `SELECT count(*)::int AS n FROM auth.users WHERE email LIKE 'harness-068-%@test.local'`,
    params: [],
  },
]

export async function runChecks(ctx) {
  const db = ctx.db
  const results = ctx.results
  const pass = (name, reason) => ctx.pass(name, reason)
  const fail = (name, reason) => ctx.fail(name, reason)
  const clock = { tick: 0, baseIso: DATE }

  const product = await db.query(
    `SELECT id, product_name FROM public.product_lines
     WHERE is_active AND vendor = 'Starlink'
     ORDER BY id LIMIT 1`,
  )
  if (!product.rows[0]) throw new Error("no active product for fixtures")
  const productId = product.rows[0].id
  const productName = product.rows[0].product_name

  const adminId = await ctx.createFixtureUser("admin", "harness-068-admin@test.local")
  const technicianId = await ctx.createFixtureUser("technicians", "harness-068-technicians@test.local")
  const salesId = await ctx.createFixtureUser("sales", "harness-068-sales@test.local")
  const viewerId = await ctx.createFixtureUser("viewer", "harness-068-viewer@test.local")

  async function createInbound(serial) {
    const itemId = nextId("ITEM")
    const txnId = nextId("TXN")
    const batchId = nextId("BATCH")
    await dropMovementPrev(db)
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
    await stampTxn(db, clock, txnId)
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
      [serial],
    )
    const row = current.rows[0]
    const txnId = nextId("TXN")
    const batchId = nextId("BATCH")
    await dropMovementPrev(db)
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
          return_pool: extra.return_pool ?? null,
          metadata:
            type === "Rental Return" || type === "Decommissioned"
              ? { reason_category: "Client cancelled", reason_text: "Recorded reason for the return" }
              : null,
        },
      ]),
    ])
    await stampTxn(db, clock, txnId)
    return { txnId, batchId, previous: row.status }
  }

  async function reverse(batchId, confirmed = [], entered = []) {
    await setJwt(db, adminId)
    const result = await db.query(
      `SELECT public.reverse_quick_scan_batch($1, $2, NULL, $3::jsonb, $4::jsonb) AS result`,
      [batchId, REASON, JSON.stringify(confirmed), JSON.stringify(entered)],
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
      [txnId],
    )
    const marker = await db.query(`SELECT kind FROM public.batch_reversals WHERE batch_id = $1`, [batchId])
    const item = await db.query(
      `SELECT status, deleted_at IS NOT NULL AS deleted
       FROM public.inventory_items WHERE serial_number = $1`,
      [serial],
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
    if (problems.length) fail(name, problems.join("; "))
    else pass(name, `${expectedStatus}${deleted ? " soft-deleted" : ""}`)
    if (!linked.rows[0]?.id) return null
    const batch = await db.query(`SELECT batch_id FROM public.transactions WHERE id = $1`, [linked.rows[0].id])
    return batch.rows[0].batch_id
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
       GROUP BY resolution.resolved_client_id`,
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
      [since, `%${PREFIX}%`],
    )
    return new Set(touched.rows.map((row) => row.client_id))
  }

  async function snapshot() {
    const clients = await db.query(
      `SELECT count(*)::int AS clients, coalesce(sum(orders), 0)::int AS orders, coalesce(sum(units), 0)::int AS units
       FROM public.client_sale_dispatch_counts()`,
    )
    const stock = await db.query(
      `SELECT status, count(*)::int AS n
       FROM public.inventory_items WHERE deleted_at IS NULL
       GROUP BY status ORDER BY status`,
    )
    const low = await db.query(`SELECT count(*)::int AS n FROM public.low_stock_products WHERE is_low`)
    const inboundRows = await db.query(
      `SELECT count(*)::int AS n
       FROM public.transactions AS txn
       WHERE txn.type = 'Inbound'
         AND NOT EXISTS (
           SELECT 1 FROM public.batch_reversals AS reversal WHERE reversal.batch_id = txn.batch_id
         )`,
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

  const saleClock = await db.query(`SELECT clock_timestamp() AS started_at`)
  const saleStartedAt = saleClock.rows[0].started_at
  const beforeShot = await snapshot()
  const beforeSales = await saleCountRows()

  let fixturesOk = false
  try {
    {
      const serial = `${PREFIX}-create`
      const created = await createInbound(serial)
      const reversalBatch = await (async () => {
        await reverse(created.batchId)
        return assertKept("reverse_create", created.batchId, created.txnId, serial, "In Stock", true)
      })()
      const blocked = await ctx.raises(
        `SELECT public.reverse_quick_scan_batch($1, $2, NULL, '[]'::jsonb, '[]'::jsonb)`,
        [reversalBatch, REASON],
        "no transactions found",
      )
      if (blocked) fail("reversal_cannot_reverse", blocked)
      else pass("reversal_cannot_reverse", reversalBatch)
    }

    {
      const cases = [
        { name: "sale", steps: [{ type: "Sale", status: "Sold" }], restore: "In Stock" },
        { name: "poc_out", steps: [{ type: "POC Out", status: "POC", client: "I2b Client" }], restore: "In Stock" },
        {
          name: "poc_return",
          steps: [
            { type: "POC Out", status: "POC", client: "I2b Client" },
            { type: "POC Return", status: "In Stock", return_pool: "sale" },
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
        {
          name: "transfer",
          steps: [{ type: "Transfer", status: "In Stock", location: "Warehouse B" }],
          restore: "In Stock",
        },
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
        // Inspection Pass/Fail must go through complete_inspection (069/073 cover that).
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
        [itemId, productId, serial, DATE],
      )
      const inbound = await move(serial, "Inbound", "In Stock")
      await reverse(inbound.batchId)
      await assertKept("reverse_inbound_maintenance", inbound.batchId, inbound.txnId, serial, "Maintenance", false)
    }

    {
      const serial = `${PREFIX}-ignore`
      await createInbound(serial)
      const sale = await move(serial, "Sale", "Sold")
      await reverse(sale.batchId, [{ transaction_id: sale.txnId, status: "POC" }])
      const linked = await db.query(
        `SELECT metadata->>'restoreStatus' AS restore FROM public.transactions WHERE reverses_transaction_id = $1`,
        [sale.txnId],
      )
      const item = await db.query(
        `SELECT status FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
        [serial],
      )
      if (item.rows[0]?.status === "In Stock" && linked.rows[0]?.restore === "In Stock") {
        pass("client_status_ignored", "recorded previous_status In Stock")
      } else {
        fail("client_status_ignored", `status ${item.rows[0]?.status} restore ${linked.rows[0]?.restore}`)
      }
    }

    {
      const serial = `${PREFIX}-unknown`
      await createInbound(serial)
      const sale = await move(serial, "Sale", "Sold")
      await db.query(
        `UPDATE public.transactions
         SET previous_status_source = 'unknown', previous_status = 'In Stock'
         WHERE id = $1`,
        [sale.txnId],
      )
      const missing = await ctx.raises(
        `SELECT public.reverse_quick_scan_batch($1, $2, NULL, '[]'::jsonb, '[]'::jsonb)`,
        [sale.batchId, REASON],
        "an unknown previous status must be confirmed",
      )
      const illegal = await ctx.raises(
        `SELECT public.reverse_quick_scan_batch($1, $2, NULL, $3::jsonb, '[]'::jsonb)`,
        [sale.batchId, REASON, JSON.stringify([{ transaction_id: sale.txnId, status: "Disposed" }])],
        "confirmed status is not a legal predecessor",
      )
      if (missing || illegal) {
        fail("unknown_confirmation", missing || illegal)
      } else {
        await reverse(sale.batchId, [{ transaction_id: sale.txnId, status: "POC" }])
        const item = await db.query(
          `SELECT status FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
          [serial],
        )
        const linked = await db.query(
          `SELECT metadata->>'restoreStatus' AS restore FROM public.transactions WHERE reverses_transaction_id = $1`,
          [sale.txnId],
        )
        if (item.rows[0]?.status === "POC" && linked.rows[0]?.restore === "POC") {
          pass("unknown_confirmation", "confirmed POC recorded on the Reversal")
        } else {
          fail("unknown_confirmation", `status ${item.rows[0]?.status} restore ${linked.rows[0]?.restore}`)
        }
      }
    }

    {
      const serial = `${PREFIX}-order`
      const created = await createInbound(serial)
      const sale = await move(serial, "Sale", "Sold")
      const blocked = await ctx.raises(
        `SELECT public.reverse_quick_scan_batch($1, $2, NULL, '[]'::jsonb, '[]'::jsonb)`,
        [created.batchId, REASON],
        sale.batchId,
      )
      if (blocked) {
        fail("later_batch_blocks", blocked)
      } else {
        await reverse(sale.batchId)
        await reverse(created.batchId)
        const item = await db.query(
          `SELECT deleted_at IS NOT NULL AS deleted FROM public.inventory_items WHERE serial_number = $1`,
          [serial],
        )
        if (item.rows[0]?.deleted) {
          pass("later_batch_blocks", `blocked by ${sale.batchId}, then both reversed`)
        } else {
          fail("later_batch_blocks", "earlier batch did not reverse after the later one")
        }
      }
    }

    {
      const serial = `${PREFIX}-guards`
      const created = await createInbound(serial)
      const empty = await ctx.raises(
        `SELECT public.reverse_quick_scan_batch($1, '', NULL, '[]'::jsonb, '[]'::jsonb)`,
        [created.batchId],
        "reason must be at least 15 characters",
      )
      const rejected = []
      for (const [role, userId] of [
        ["technicians", technicianId],
        ["sales", salesId],
        ["viewer", viewerId],
      ]) {
        const forbidden = await ctx.asUser(userId, async () =>
          ctx.raises(
            `SELECT public.reverse_quick_scan_batch($1, $2, NULL, '[]'::jsonb, '[]'::jsonb)`,
            [created.batchId, REASON],
            "forbidden",
          ),
        )
        if (forbidden) rejected.push(`${role}: ${forbidden}`)
      }
      await setJwt(db, adminId)
      const direct = await ctx.raises(
        `UPDATE public.inventory_items SET status = 'Sold' WHERE serial_number = $1`,
        [serial],
        "Invalid",
      )
      const still = await db.query(
        `SELECT status FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
        [serial],
      )
      if (empty || rejected.length > 0 || direct || still.rows[0]?.status !== "In Stock") {
        fail("guards", [empty, ...rejected, direct, still.rows[0]?.status].filter(Boolean).join(" | "))
      } else {
        pass("guards", "empty reason, technician, sales, viewer, and a modeless status update are rejected")
      }
    }

    {
      const changed = `${PREFIX}-void-sale`
      await createInbound(changed)
      const sale = await move(changed, "Sale", "Sold")
      await setJwt(db, adminId)
      const rejected = await ctx.raises(
        `SELECT public.void_batch($1, $2)`,
        [sale.batchId, VOID_REASON],
        "this batch changed stock",
      )

      const serial = `${PREFIX}-void-ok`
      const itemId = nextId("ITEM")
      const txnId = nextId("TXN")
      const batchId = nextId("BATCH")
      await db.query(
        `INSERT INTO public.inventory_items (id, product_id, serial_number, status, date_added, location)
         VALUES ($1, $2, $3, 'In Stock', $4, 'Warehouse A')`,
        [itemId, productId, serial, DATE],
      )
      await db.query(
        `INSERT INTO public.transactions (
           id, type, serial_number, item_name, client, date, batch_id, previous_status, previous_status_source
         ) VALUES ($1, 'Inbound', $2, $3, '', $4, $5, 'In Stock', 'recorded')`,
        [txnId, serial, productName, DATE, batchId],
      )
      await stampTxn(db, clock, txnId)
      await setJwt(db, adminId)
      await db.query(`SELECT public.void_batch($1, $2)`, [batchId, VOID_REASON])
      const item = await db.query(
        `SELECT status FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
        [serial],
      )
      const marker = await db.query(`SELECT kind FROM public.batch_reversals WHERE batch_id = $1`, [batchId])
      if (rejected || item.rows[0]?.status !== "In Stock" || marker.rows[0]?.kind !== "void") {
        fail("void_no_effect", rejected || `status ${item.rows[0]?.status} kind ${marker.rows[0]?.kind}`)
      } else {
        pass("void_no_effect", "stock-changing batch rejected; no-effect inbound voided")
      }
    }

    fixturesOk = Object.values(results).every((row) => row.result === "PASS")
  } catch (error) {
    fail("fixtures", error instanceof Error ? error.message : String(error))
  }

  try {
    if (fixturesOk) {
      await setJwt(db, adminId)
      // Fixture kits still exist in this txn; compare sale counts (foreign-filtered) and
      // read-only phantom voids — not live inbound chip math from a one-shot production void.
      const afterSales = await saleCountRows()
      const before = indexSaleCounts(beforeSales)
      const after = indexSaleCounts(afterSales)
      const changed = []
      for (const id of new Set([...before.keys(), ...after.keys()])) {
        if (before.get(id) !== after.get(id)) changed.push(id)
      }
      const foreign = await foreignSaleClients(saleStartedAt)
      const unexplained = changed.filter((id) => !foreign.has(id))
      const ignored = changed.filter((id) => foreign.has(id))
      if (unexplained.length) {
        fail("snapshot", unexplained.slice(0, 5).join(", "))
      } else if (ignored.length) {
        pass("snapshot", `unchanged except ${ignored.join(", ")}`)
      } else {
        pass(
          "snapshot",
          `${after.size} clients / inbound rows ${beforeShot.inboundRows} chip ${beforeShot.inboundChip} (beforeShot; no production void this run)`,
        )
      }

      const phantoms = await db.query(
        `SELECT reversal.batch_id, reversal.kind, reversal.reversal_reason,
                public.batch_is_currently_reversed(reversal.batch_id) AS reversed,
                (SELECT count(*)::int FROM public.batch_restores AS restored WHERE restored.batch_id = reversal.batch_id) AS restores
         FROM public.batch_reversals AS reversal
         WHERE reversal.batch_id = ANY($1::text[])
         ORDER BY reversal.batch_id`,
        [PHANTOMS],
      )
      const intact =
        phantoms.rowCount === 3 &&
        phantoms.rows.every(
          (row) =>
            row.kind === "void" &&
            row.reversal_reason === VOID_REASON &&
            row.reversed === true &&
            row.restores === 0,
        )
      if (intact) pass("phantom_voids", "three voided receipts stayed voided")
      else fail("phantom_voids", JSON.stringify(phantoms.rows))
    } else {
      fail("production_check", "skipped because fixture checks failed")
    }
  } catch (error) {
    fail("production_check", error instanceof Error ? error.message : String(error))
  }
}

async function main() {
  const { ok, failed, passed } = await withHarness(
    { markers: MARKERS, timeoutMs: 300_000, label: "verify-068" },
    runChecks,
  )
  console.log(ok ? `\n${passed} passed` : `\n${failed} failed`)
  process.exitCode = ok ? 0 : 1
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-068-reversal-keeps-history.mjs")
if (isMain) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
