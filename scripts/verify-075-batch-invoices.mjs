/**
 * Invoice states — rollback harness (BEGIN…ROLLBACK, never commits).
 *
 * Usage: node scripts/verify-075-batch-invoices.mjs
 */
import { withHarness } from "./verify-harness.mjs"
import { dropMovementPrev, setJwt } from "./verify-harness-fixtures.mjs"

const PREFIX = "H3075"
const REASON = "Complimentary kit, not invoiced"
const CHANGE_REASON = "Corrected the invoice number"
const REJECT_REASON = "Return this batch to pending"
const VALID_STATUSES = ["invoiced", "pending", "not_invoiced", "legacy_unreviewed"]
const DATE = "2026-10-07"
const DATE_ISO = `${DATE}T00:00:00.000Z`

let seq = 0
function nextId(kind) {
  seq += 1
  return `${kind}-${PREFIX}-${seq}`
}

export const MARKERS = [
  {
    label: "transactions",
    sql: `SELECT count(*)::int AS n FROM public.transactions
          WHERE serial_number LIKE $1 OR id LIKE $2 OR batch_id LIKE $3`,
    params: [`${PREFIX}%`, `TXN-${PREFIX}%`, `BATCH-${PREFIX}%`],
  },
  {
    label: "items",
    sql: `SELECT count(*)::int AS n FROM public.inventory_items WHERE serial_number LIKE $1 OR id LIKE $2`,
    params: [`${PREFIX}%`, `ITEM-${PREFIX}%`],
  },
  {
    label: "batch_invoices",
    sql: `SELECT count(*)::int AS n FROM public.batch_invoices WHERE batch_id LIKE $1`,
    params: [`BATCH-${PREFIX}%`],
  },
  {
    label: "users",
    sql: `SELECT count(*)::int AS n FROM auth.users WHERE email LIKE 'harness-075-%@test.local'`,
    params: [],
  },
]

export async function runChecks(ctx) {
  const db = ctx.db
  const pass = (name, reason) => ctx.pass(name, reason)
  const fail = (name, reason) => ctx.fail(name, reason)

  const product = await db.query(
    `SELECT id, product_name FROM public.product_lines WHERE is_active ORDER BY id LIMIT 1`,
  )
  if (!product.rows[0]) throw new Error("no active product line")
  const productId = product.rows[0].id
  const productName = product.rows[0].product_name

  const adminA = await ctx.createFixtureUser("admin", "harness-075-admin-a@test.local")
  const adminB = await ctx.createFixtureUser("admin", "harness-075-admin-b@test.local")
  const accounts = await ctx.createFixtureUser("accounts", "harness-075-accounts@test.local")
  const tech = await ctx.createFixtureUser("technicians", "harness-075-tech@test.local")

  const statusCheck = await db.query(
    `SELECT count(*)::int AS n
     FROM public.batch_invoices
     WHERE NOT (status = ANY ($1::text[]))`,
    [VALID_STATUSES],
  )
  if (statusCheck.rows[0].n === 0) {
    pass("statuses_valid", `all batch_invoices statuses are in ${VALID_STATUSES.join(", ")}`)
  } else {
    fail("statuses_valid", `${statusCheck.rows[0].n} rows with unexpected status`)
  }

  async function inbound(serial) {
    const itemId = nextId("ITEM")
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
          stock_pool: "sale",
        },
      ]),
      JSON.stringify([
        {
          id: nextId("TXN"),
          type: "Inbound",
          serial_number: serial,
          item_name: productName,
          date: DATE_ISO,
          client: "Internal",
          batch_id: nextId("BATCH"),
          to_location: "Warehouse A",
        },
      ]),
    ])
  }

  async function sell(serial, actorId, extra) {
    const current = await db.query(
      `SELECT id FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
      [serial],
    )
    const txnId = nextId("TXN")
    const batchId = nextId("BATCH")
    await dropMovementPrev(db)
    await db.query(`SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`, [
      JSON.stringify([
        {
          id: current.rows[0].id,
          product_id: productId,
          serial_number: serial,
          status: "Sold",
          date_added: DATE,
          location: "Delivered",
          client: `${PREFIX} Holder`,
          stock_pool: "sale",
        },
      ]),
      JSON.stringify([
        {
          id: txnId,
          type: "Sale",
          serial_number: serial,
          item_name: productName,
          date: DATE_ISO,
          client: `${PREFIX} Holder`,
          invoice_number: extra.invoice_number ?? null,
          batch_id: batchId,
          created_by: actorId,
          metadata: extra.metadata,
        },
      ]),
    ])
    return batchId
  }

  async function itemStatus(serial) {
    const row = await db.query(
      `SELECT status FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
      [serial],
    )
    return row.rows[0]?.status ?? null
  }

  async function invoiceRow(batchId) {
    const row = await db.query(`SELECT * FROM public.batch_invoices WHERE batch_id = $1`, [batchId])
    return row.rows[0] ?? null
  }

  const serials = ["NUM", "PEND", "ZERO", "REJ", "CHG", "BAD", "BLANK", "SHORT"].map((name) => `${PREFIX}-${name}`)
  for (const serial of serials) await inbound(serial)

  await setJwt(db, adminA)
  const numbered = await sell(`${PREFIX}-NUM`, adminA, {
    invoice_number: `${PREFIX}-1`,
    metadata: { invoice_choice: "number" },
  })
  const pending = await sell(`${PREFIX}-PEND`, adminA, {
    metadata: { invoice_choice: "pending" },
  })
  const zero = await sell(`${PREFIX}-ZERO`, adminA, {
    metadata: { invoice_choice: "not_invoiced", invoice_reason: REASON },
  })
  const numberedRow = await invoiceRow(numbered)
  const pendingRow = await invoiceRow(pending)
  const zeroRow = await invoiceRow(zero)
  const saleCount = await db.query(
    `SELECT count(*)::int AS n FROM public.transactions WHERE batch_id = $1 AND type = 'Sale'`,
    [numbered],
  )
  if (
    saleCount.rows[0].n === 1 &&
    numberedRow?.status === "invoiced" &&
    numberedRow.invoice_number === `${PREFIX}-1` &&
    pendingRow?.status === "pending" &&
    zeroRow?.status === "not_invoiced" &&
    zeroRow.approval === "awaiting" &&
    (await itemStatus(`${PREFIX}-NUM`)) === "Sold" &&
    (await itemStatus(`${PREFIX}-PEND`)) === "Sold" &&
    (await itemStatus(`${PREFIX}-ZERO`)) === "Sold"
  ) {
    pass("states", "number, pending, and 00000 each write one sale and the kit is sold immediately")
  } else {
    fail("states", JSON.stringify({ numberedRow, pendingRow, zeroRow, sales: saleCount.rows[0].n }))
  }

  const cases = await db.query(
    `SELECT count(*)::int AS n FROM public.kit_cases kc
     JOIN public.inventory_items item ON item.id = kc.inventory_item_id
     WHERE item.serial_number LIKE $1`,
    [`${PREFIX}%`],
  )
  if (cases.rows[0].n === 0) pass("no_case", "converting the invoice does not open a case")
  else fail("no_case", `${cases.rows[0].n} cases`)

  const placeholderMoves = [
    ["0000", "placeholder"],
    ["-", "placeholder"],
    ["N/A", "placeholder"],
    ["00000", "at least 15"],
  ]
  let placeholderOk = true
  for (const [number, needle] of placeholderMoves) {
    const badId = (
      await db.query(`SELECT id FROM public.inventory_items WHERE serial_number = $1`, [`${PREFIX}-BAD`])
    ).rows[0].id
    await dropMovementPrev(db)
    const message = await ctx.raises(
      `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
      [
        JSON.stringify([
          {
            id: badId,
            product_id: productId,
            serial_number: `${PREFIX}-BAD`,
            status: "Sold",
            date_added: DATE,
            location: "Delivered",
            stock_pool: "sale",
          },
        ]),
        JSON.stringify([
          {
            id: nextId("TXN"),
            type: "Sale",
            serial_number: `${PREFIX}-BAD`,
            item_name: productName,
            date: DATE_ISO,
            client: `${PREFIX} Holder`,
            invoice_number: number,
            batch_id: nextId("BATCH"),
            created_by: adminA,
            metadata:
              number === "00000"
                ? { invoice_choice: "not_invoiced", invoice_reason: "short" }
                : { invoice_choice: "number" },
          },
        ]),
      ],
      needle,
    )
    if (message) placeholderOk = false
  }
  const blankId = (
    await db.query(`SELECT id FROM public.inventory_items WHERE serial_number = $1`, [`${PREFIX}-BLANK`])
  ).rows[0].id
  await dropMovementPrev(db)
  const blankMessage = await ctx.raises(
    `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
    [
      JSON.stringify([
        {
          id: blankId,
          product_id: productId,
          serial_number: `${PREFIX}-BLANK`,
          status: "Sold",
          date_added: DATE,
          location: "Delivered",
          stock_pool: "sale",
        },
      ]),
      JSON.stringify([
        {
          id: nextId("TXN"),
          type: "Sale",
          serial_number: `${PREFIX}-BLANK`,
          item_name: productName,
          date: DATE_ISO,
          client: `${PREFIX} Holder`,
          batch_id: nextId("BATCH"),
          created_by: adminA,
        },
      ]),
    ],
    "Invoice pending",
  )
  if (
    placeholderOk &&
    !blankMessage &&
    (await itemStatus(`${PREFIX}-BAD`)) === "In Stock" &&
    (await itemStatus(`${PREFIX}-BLANK`)) === "In Stock"
  ) {
    pass("placeholders", "placeholders, a short 00000 reason, and a blank invoice are rejected and stock stays")
  } else {
    fail("placeholders", blankMessage || "a placeholder was accepted")
  }

  const self = await ctx.asUser(adminA, async () =>
    ctx.raises(`SELECT public.approve_batch_invoice($1)`, [zero], "cannot approve an invoice you entered"),
  )
  if (!self) pass("self_approve", "the admin who entered 00000 cannot approve it")
  else fail("self_approve", self)

  const soldBefore = await itemStatus(`${PREFIX}-ZERO`)
  await setJwt(db, adminB)
  await db.query(`SELECT public.approve_batch_invoice($1)`, [zero])
  const approved = await invoiceRow(zero)
  if (
    approved?.approval === "approved" &&
    approved.approved_by === adminB &&
    soldBefore === "Sold" &&
    (await itemStatus(`${PREFIX}-ZERO`)) === "Sold"
  ) {
    pass("approved", "another admin approves 00000 and the kit stays sold")
  } else {
    fail("approved", JSON.stringify({ approved, soldBefore }))
  }

  await setJwt(db, adminA)
  const rejectedBatch = await sell(`${PREFIX}-REJ`, adminA, {
    metadata: { invoice_choice: "not_invoiced", invoice_reason: REASON },
  })
  await setJwt(db, adminB)
  await db.query(`SELECT public.reject_batch_invoice($1, $2)`, [rejectedBatch, REJECT_REASON])
  const rejected = await invoiceRow(rejectedBatch)
  if (rejected?.status === "pending" && rejected.approval == null && (await itemStatus(`${PREFIX}-REJ`)) === "Sold") {
    pass("rejected", "rejection returns the batch to pending and leaves the kit sold")
  } else {
    fail("rejected", JSON.stringify(rejected))
  }

  await setJwt(db, accounts)
  await db.query(`SELECT public.set_batch_invoice($1, 'number', $2, '')`, [rejectedBatch, `${PREFIX}-2`])
  const firstNumber = await invoiceRow(rejectedBatch)
  const shortChange = await ctx.raises(
    `SELECT public.set_batch_invoice($1, 'number', $2, 'too short')`,
    [rejectedBatch, `${PREFIX}-3`],
    "at least 15",
  )
  await db.query(`SELECT public.set_batch_invoice($1, 'number', $2, $3)`, [
    rejectedBatch,
    `${PREFIX}-3`,
    CHANGE_REASON,
  ])
  const changed = await invoiceRow(rejectedBatch)
  const events = await db.query(
    `SELECT new_status, new_invoice_number, reason FROM public.batch_invoice_events
     WHERE batch_id = $1 ORDER BY created_at`,
    [rejectedBatch],
  )
  const last = events.rows[events.rows.length - 1]
  if (
    firstNumber?.invoice_number === `${PREFIX}-2` &&
    !shortChange &&
    changed?.invoice_number === `${PREFIX}-3` &&
    last?.new_invoice_number === `${PREFIX}-3` &&
    last?.reason === CHANGE_REASON
  ) {
    pass("change_number", "the first number needs no reason; changing it needs a reason and writes history")
  } else {
    fail("change_number", JSON.stringify({ firstNumber, shortChange, changed, last, events: events.rows }))
  }

  const techBlocked = await ctx.asUser(tech, async () =>
    ctx.raises(
      `SELECT public.set_batch_invoice($1, 'number', $2, $3)`,
      [numbered, `${PREFIX}-9`, CHANGE_REASON],
      "Only admin or accounts",
    ),
  )
  const accountsApprove = await ctx.asUser(accounts, async () =>
    ctx.raises(`SELECT public.approve_batch_invoice($1)`, [zero], "Only an admin"),
  )
  if (!techBlocked && !accountsApprove) {
    pass("roles", "a technician cannot change an invoice and accounts cannot approve")
  } else {
    fail("roles", techBlocked || accountsApprove || "role check missed")
  }
}

async function main() {
  const { ok, failed, passed } = await withHarness(
    { markers: MARKERS, timeoutMs: 180_000, label: "verify-075" },
    runChecks,
  )
  console.log(ok ? `\n${passed} passed` : `\n${failed} failed`)
  process.exitCode = ok ? 0 : 1
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-075-batch-invoices.mjs")
if (isMain) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
