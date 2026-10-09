/**
 * Cancel a holding extension — rollback harness (BEGIN…ROLLBACK, never commits).
 *
 * Usage: node scripts/verify-070-cancel-holding-extension.mjs
 */
import { withHarness } from "./verify-harness.mjs"
import { dropMovementPrev, stampTxn, setJwt } from "./verify-harness-fixtures.mjs"

// Distinct from leftover E1070 / verify-070 residue still in production (A1 blocked cleanup).
const PREFIX = "H3070"
const DATE = "2026-10-02T00:00:00.000Z"
const ORIGINAL = "2026-11-01"
const FIRST = "2026-12-01"
const SECOND = "2027-01-15"
const CANCEL_REASON = "H3070 verify cancel reason"
const EXTEND_REASON = "Customer asked for more time"

let seq = 0
function nextId(kind) {
  seq += 1
  return `${kind}-${PREFIX}-${seq}`
}

export const MARKERS = [
  {
    label: "transactions",
    sql: `SELECT count(*)::int AS n FROM public.transactions
          WHERE serial_number LIKE $1 OR batch_id LIKE $2`,
    params: [`${PREFIX}-%`, `BATCH-${PREFIX}-%`],
  },
  {
    label: "items",
    sql: `SELECT count(*)::int AS n FROM public.inventory_items
          WHERE serial_number LIKE $1 OR id LIKE $2`,
    params: [`${PREFIX}-%`, `ITEM-${PREFIX}-%`],
  },
  {
    label: "holding_extensions",
    sql: `SELECT count(*)::int AS n FROM public.holding_extensions
          WHERE serial_number LIKE $1 OR item_id LIKE $2`,
    params: [`${PREFIX}-%`, `ITEM-${PREFIX}-%`],
  },
  {
    label: "users",
    sql: `SELECT count(*)::int AS n FROM auth.users WHERE email LIKE 'harness-070-%@test.local'`,
    params: [],
  },
]

export async function runChecks(ctx) {
  const { db, pass, fail } = ctx

  const product = await db.query(
    `SELECT id, product_name FROM public.product_lines WHERE is_active ORDER BY id LIMIT 1`,
  )
  if (!product.rows[0]) throw new Error("no active product line for the fixture")
  const productId = product.rows[0].id
  const productName = product.rows[0].product_name

  const adminId = await ctx.createFixtureUser("admin", "harness-070-admin@test.local")
  const technicianId = await ctx.createFixtureUser("technicians", "harness-070-technicians@test.local")

  const clock = { tick: 0, baseIso: DATE }

  async function returnDate(itemId) {
    const item = await db.query(`SELECT return_date FROM public.inventory_items WHERE id = $1`, [itemId])
    return item.rows[0]?.return_date ?? null
  }

  async function extension(id) {
    const row = await db.query(
      `SELECT previous_date, new_date, cancelled_at, cancelled_by, cancel_reason
       FROM public.holding_extensions WHERE id = $1`,
      [id],
    )
    return row.rows[0]
  }

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
    await stampTxn(db, clock, txnId)
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
      [itemId],
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
          metadata:
            type === "Sale" || type === "Rentals"
              ? { invoice_choice: "pending" }
              : null,
        },
      ]),
    ])
    await stampTxn(db, clock, txnId)
    return batchId
  }

  /**
   * Same fields as extend_holding, with an explicit created_at so ordering is
   * well-defined under the harness's frozen transaction clock (now()).
   */
  async function extend(itemId, newDate) {
    const item = await db.query(
      `SELECT id, serial_number, status, return_date
       FROM public.inventory_items WHERE id = $1 AND deleted_at IS NULL`,
      [itemId],
    )
    const row = item.rows[0]
    if (!row || (row.status !== "POC" && row.status !== "Rented")) {
      throw new Error(`extend: kit ${itemId} is not on a holding`)
    }
    const previous = row.return_date
    clock.tick += 1
    const at = new Date(Date.parse(clock.baseIso) + clock.tick).toISOString()
    await db.query(`UPDATE public.inventory_items SET return_date = $2 WHERE id = $1`, [itemId, newDate])
    const inserted = await db.query(
      `INSERT INTO public.holding_extensions (
         item_id, serial_number, holding_type, previous_date, new_date, reason, extended_by, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, auth.uid(), $7::timestamptz
       )
       RETURNING id, previous_date, new_date`,
      [
        row.id,
        row.serial_number,
        row.status === "POC" ? "POC" : "Rental",
        previous,
        newDate,
        EXTEND_REASON,
        at,
      ],
    )
    return inserted.rows[0]
  }

  /** Same ordering as cancel_holding_extension's "latest" guard (created_at, then id::text). */
  async function latestOpen(itemId) {
    const row = await db.query(
      `SELECT id, previous_date, new_date
       FROM public.holding_extensions
       WHERE item_id = $1 AND cancelled_at IS NULL
       ORDER BY created_at DESC, id::text DESC
       LIMIT 1`,
      [itemId],
    )
    return row.rows[0]
  }

  const holding = {
    status: "POC",
    location: "Client Site",
    client: "H3070 Holder",
    assigned_to: "H3070 Assignee",
    poc_out_date: "2026-10-02",
    return_date: ORIGINAL,
  }

  // JWT only (table owner) so RLS does not block fixture walks; get_my_role() still resolves.
  await setJwt(db, adminId)
  const itemA = await createInbound(`${PREFIX}-A`)
  await move(itemA, "POC Out", holding)
  const first = await extend(itemA, FIRST)
  const second = await extend(itemA, SECOND)
  if (first.previous_date !== ORIGINAL || second.previous_date !== FIRST) {
    throw new Error(`previous dates ${first.previous_date} / ${second.previous_date}`)
  }
  // With frozen now(), "latest" is by id::text — resolve the same way the function does.
  const newest = await latestOpen(itemA)
  const olderRow = newest.id === first.id ? second : first
  if (newest.new_date !== SECOND) {
    throw new Error(`expected latest extension on ${SECOND}, got ${newest.new_date}`)
  }

  const forbidden = await ctx.asUser(technicianId, async () =>
    ctx.raises(`SELECT public.cancel_holding_extension($1, $2)`, [newest.id, CANCEL_REASON], "forbidden"),
  )
  if (forbidden) fail("non_admin", forbidden)
  else pass("non_admin", "technician rejected")

  await setJwt(db, adminId)

  const short = await ctx.raises(
    `SELECT public.cancel_holding_extension($1, $2)`,
    [newest.id, "too short"],
    "at least 15",
  )
  if (short) fail("reason", short)
  else pass("reason", "short reason rejected")

  // Latest-guard runs before the return_date check when both extensions are open.
  const older = await ctx.raises(
    `SELECT public.cancel_holding_extension($1, $2)`,
    [olderRow.id, CANCEL_REASON],
    "only the latest",
  )
  if (older) fail("not_latest", older)
  else pass("not_latest", "older extension rejected while a newer one is active")
  if ((await returnDate(itemA)) !== SECOND) fail("untouched", await returnDate(itemA))
  else pass("untouched", SECOND)

  await db.query(`SELECT public.cancel_holding_extension($1, $2)`, [newest.id, CANCEL_REASON])
  const afterLatest = await returnDate(itemA)
  const kept = await extension(newest.id)
  if (
    afterLatest === FIRST &&
    kept.cancelled_at &&
    kept.cancelled_by === adminId &&
    kept.cancel_reason === CANCEL_REASON &&
    kept.previous_date === FIRST &&
    kept.new_date === SECOND
  ) {
    pass("cancel_latest", `return date ${FIRST}; row kept`)
  } else {
    fail("cancel_latest", JSON.stringify({ afterLatest, kept }))
  }

  await db.query(`SELECT public.cancel_holding_extension($1, $2)`, [olderRow.id, CANCEL_REASON])
  const afterFirst = await returnDate(itemA)
  const keptFirst = await extension(olderRow.id)
  if (
    afterFirst === ORIGINAL &&
    keptFirst.cancelled_at &&
    keptFirst.previous_date === ORIGINAL &&
    keptFirst.new_date === FIRST
  ) {
    pass("cancel_again", `return date ${ORIGINAL}; row kept`)
  } else {
    fail("cancel_again", JSON.stringify({ afterFirst, keptFirst }))
  }

  const itemB = await createInbound(`${PREFIX}-B`)
  await move(itemB, "POC Out", holding)
  const moved = await extend(itemB, FIRST)
  const batchId = await move(itemB, "Transfer", { ...holding, location: "Warehouse B", return_date: FIRST })
  // Extensions use frozen now(); stampTxn uses a fixed DATE base. clock_timestamp()
  // advances inside the txn so the transfer is strictly after the extension.
  await db.query(
    `UPDATE public.transactions
     SET created_at = clock_timestamp()
     WHERE batch_id = $1`,
    [batchId],
  )
  const later = await ctx.raises(
    `SELECT public.cancel_holding_extension($1, $2)`,
    [moved.id, CANCEL_REASON],
    "later",
  )
  if (later) fail("later_movement", later)
  else if ((await returnDate(itemB)) !== FIRST) fail("later_movement", await returnDate(itemB))
  else pass("later_movement", `rejected after ${batchId}`)
}

async function main() {
  const { ok, failed, passed } = await withHarness(
    { markers: MARKERS, timeoutMs: 300_000, label: "verify-070" },
    runChecks,
  )
  console.log(ok ? `\n${passed} passed` : `\n${failed} failed`)
  process.exitCode = ok ? 0 : 1
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-070-cancel-holding-extension.mjs")
if (isMain) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
