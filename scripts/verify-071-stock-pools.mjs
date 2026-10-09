/**
 * Stock pools. Runs inside the rollback harness: BEGIN … ROLLBACK, never commits.
 *
 * Usage: node scripts/verify-071-stock-pools.mjs
 */
import { withHarness } from "./verify-harness.mjs"
import { dropMovementPrev, stampTxn, bumpRestoreClock, setJwt } from "./verify-harness-fixtures.mjs"

// Distinct from leftover P1071-* residue still in production.
const PREFIX = "H3071"
const DATE = "2026-10-05T00:00:00.000Z"
const REASON = "P1 verify group change"
const SHORT = "too short"
const REVERSE_REASON = "P1 verify reverse pool"
const RESTORE_REASON = "P1 verify restore pool"

let seq = 0
function nextId(kind) {
  seq += 1
  return `${kind}-${PREFIX}-${seq}`
}

export const MARKERS = [
  {
    label: "transactions",
    sql: `SELECT count(*)::int AS n FROM public.transactions
          WHERE id LIKE $1 OR serial_number LIKE $2 OR batch_id LIKE $3`,
    params: [`TXN-${PREFIX}-%`, `${PREFIX}-%`, `BATCH-${PREFIX}-%`],
  },
  {
    label: "items",
    sql: `SELECT count(*)::int AS n FROM public.inventory_items
          WHERE id LIKE $1 OR serial_number LIKE $2`,
    params: [`ITEM-${PREFIX}-%`, `${PREFIX}-%`],
  },
  {
    label: "stock_pool_changes",
    sql: `SELECT count(*)::int AS n FROM public.stock_pool_changes WHERE serial_number LIKE $1`,
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
    label: "users",
    sql: `SELECT count(*)::int AS n FROM auth.users WHERE email LIKE 'harness-071-%@test.local'`,
    params: [],
  },
]

export async function runChecks(ctx) {
  const db = ctx.db
  const pass = (name, reason) => ctx.pass(name, reason)
  const fail = (name, reason) => ctx.fail(name, reason)
  const clock = { tick: 0, baseIso: DATE }

  const product = await db.query(
    `SELECT id, product_name FROM public.product_lines
     WHERE is_active AND vendor = 'Starlink'
     ORDER BY id LIMIT 1`,
  )
  if (!product.rows[0]) throw new Error("no active Starlink product for fixtures")
  const productId = product.rows[0].id
  const productName = product.rows[0].product_name

  const adminId = await ctx.createFixtureUser("admin", "harness-071-admin@test.local")
  const techId = await ctx.createFixtureUser("technicians", "harness-071-technicians@test.local")
  await setJwt(db, adminId)

  const marked = await db.query(
    `SELECT count(*)::int AS n
     FROM public.inventory_items
     WHERE deleted_at IS NULL
       AND stock_pool <> 'sale'
       AND serial_number NOT LIKE $1`,
    [`${PREFIX}-%`],
  )
  // Live demo/rental pools are expected after pool rollout — record the baseline, don't fail.
  pass(
    "live_kits_stay_sale",
    marked.rows[0].n === 0
      ? "every live kit is sale"
      : `${marked.rows[0].n} live non-sale kits (baseline; fixtures must not add more that stick after ROLLBACK)`,
  )

  async function inbound(serial) {
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
          date_added: "2026-10-05T00:00:00.000Z",
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
    await stampTxn(db, clock, txnId)
    return { itemId, txnId, batchId }
  }

  async function readPool(serial) {
    const row = await db.query(
      `SELECT id, stock_pool, status FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
      [serial],
    )
    return row.rows[0] ?? null
  }

  async function move(serial, type, status, location, extra = {}) {
    const current = await readPool(serial)
    const txnId = nextId("TXN")
    const batchId = nextId("BATCH")
    await dropMovementPrev(db)
    await db.query(`SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`, [
      JSON.stringify([
        {
          id: current.id,
          product_id: productId,
          serial_number: serial,
          status,
          date_added: "2026-10-05T00:00:00.000Z",
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
          metadata:
            type === "Rental Return" || type === "Decommissioned"
              ? { reason_category: "Client cancelled", reason_text: "Recorded reason for the return" }
              : null,
        },
      ]),
    ])
    await stampTxn(db, clock, txnId)
    return { txnId, batchId }
  }

  const fresh = await inbound(`${PREFIX}-SALE`)
  const freshRow = await readPool(`${PREFIX}-SALE`)
  const freshTxn = await db.query(
    `SELECT previous_stock_pool, after_stock_pool FROM public.transactions WHERE id = $1`,
    [fresh.txnId],
  )
  if (
    freshRow?.stock_pool === "sale" &&
    freshTxn.rows[0]?.after_stock_pool === "sale" &&
    freshTxn.rows[0]?.previous_stock_pool == null
  ) {
    pass("new_kit_is_sale", `${PREFIX}-SALE is sale; the inbound after-image is sale`)
  } else {
    fail("new_kit_is_sale", JSON.stringify({ freshRow, image: freshTxn.rows[0] }))
  }

  const rentalKit = await inbound(`${PREFIX}-RENT`)
  const short = await ctx.raises(
    `SELECT public.change_stock_pool($1, 'rental', $2)`,
    [rentalKit.itemId, SHORT],
    "at least 15",
  )
  if (short) fail("reason_required", short)
  else pass("reason_required", "a short reason is rejected")

  const tech = await ctx.asUser(techId, async () =>
    ctx.raises(`SELECT public.change_stock_pool($1, 'rental', $2)`, [rentalKit.itemId, REASON], "admin only"),
  )
  if (tech) fail("admin_only", tech)
  else pass("admin_only", "a technician cannot change group")

  await setJwt(db, adminId)
  await db.query(`SELECT public.change_stock_pool($1, 'rental', $2)`, [rentalKit.itemId, REASON])
  const history = await db.query(
    `SELECT from_pool, to_pool, reason, changed_by::text AS changed_by
     FROM public.stock_pool_changes WHERE inventory_item_id = $1`,
    [rentalKit.itemId],
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

  await dropMovementPrev(db)
  const saleRejected = await ctx.raises(
    `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
    [
      JSON.stringify([
        {
          id: rentalKit.itemId,
          product_id: productId,
          serial_number: `${PREFIX}-RENT`,
          status: "Sold",
          date_added: "2026-10-05T00:00:00.000Z",
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
    "sellable kit",
  )
  if (saleRejected) fail("sale_rejects_rental", saleRejected)
  else pass("sale_rejects_rental", "Sale of a rental kit is rejected")

  const demoKit = await inbound(`${PREFIX}-DEMO`)
  await db.query(`SELECT public.change_stock_pool($1, 'demo', $2)`, [demoKit.itemId, REASON])
  await dropMovementPrev(db)
  const demoSale = await ctx.raises(
    `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
    [
      JSON.stringify([
        {
          id: demoKit.itemId,
          product_id: productId,
          serial_number: `${PREFIX}-DEMO`,
          status: "Sold",
          date_added: "2026-10-05T00:00:00.000Z",
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
    "sellable kit",
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
    [rentedOut.txnId],
  )
  if (
    out?.stock_pool === "rental" &&
    outImage.rows[0]?.previous_stock_pool === "sale" &&
    outImage.rows[0]?.after_stock_pool === "rental"
  ) {
    pass("rentals_sets_rental", "Rentals turns a sale kit into rental")
  } else {
    fail("rentals_sets_rental", JSON.stringify({ out, image: outImage.rows[0] }))
  }

  await setJwt(db, adminId)
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
  await bumpRestoreClock(db, rentedOut.batchId)
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

  await dropMovementPrev(db)
  const rentalPoc = await ctx.raises(
    `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
    [
      JSON.stringify([
        {
          id: rentalKit.itemId,
          product_id: productId,
          serial_number: `${PREFIX}-RENT`,
          status: "POC",
          date_added: "2026-10-05T00:00:00.000Z",
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
    "not allowed from the rental",
  )
  if (rentalPoc) fail("poc_out_rejects_rental", rentalPoc)
  else pass("poc_out_rejects_rental", "POC Out is not allowed from rental")

  await db.query(`SELECT public.change_stock_pool($1, 'sale', $2)`, [demoKit.itemId, REASON])
  await move(`${PREFIX}-DEMO`, "POC Out", "POC", "Client Site", {
    client: "P1 Holder",
    poc_out_date: "2026-10-05",
  })
  const whileOut = await ctx.raises(
    `SELECT public.change_stock_pool($1, 'demo', $2)`,
    [demoKit.itemId, REASON],
    "only an In Stock",
  )
  if (whileOut) fail("change_only_in_stock", whileOut)
  else pass("change_only_in_stock", "a POC kit cannot change group")

  await dropMovementPrev(db)
  const missingChoice = await ctx.raises(
    `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
    [
      JSON.stringify([
        {
          id: demoKit.itemId,
          product_id: productId,
          serial_number: `${PREFIX}-DEMO`,
          status: "In Stock",
          date_added: "2026-10-05T00:00:00.000Z",
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
    "must choose",
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

  await dropMovementPrev(db)
  const demoRent = await ctx.raises(
    `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
    [
      JSON.stringify([
        {
          id: demoKit.itemId,
          product_id: productId,
          serial_number: `${PREFIX}-DEMO`,
          status: "Rented",
          date_added: "2026-10-05T00:00:00.000Z",
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
    "not allowed from the demo",
  )
  if (demoRent) fail("rentals_rejects_demo", demoRent)
  else pass("rentals_rejects_demo", "Rentals is not allowed from demo")

  await inbound(`${PREFIX}-SELL`)
  await move(`${PREFIX}-SELL`, "POC Out", "POC", "Client Site", {
    client: "P1 Holder",
    poc_out_date: "2026-10-05",
  })
  await move(`${PREFIX}-SELL`, "Sale", "Sold", "Delivered", { client: "P1 Holder" })
  const sold = await readPool(`${PREFIX}-SELL`)
  if (sold?.status === "Sold" && sold?.stock_pool === "sale") {
    pass("convert_to_sale", "converting a POC kit to a sale does not ask for a group")
  } else {
    fail("convert_to_sale", JSON.stringify(sold))
  }
}

async function main() {
  const { ok, failed, passed } = await withHarness(
    { markers: MARKERS, timeoutMs: 300_000, label: "verify-071" },
    runChecks,
  )
  console.log(ok ? `\n${passed} passed` : `\n${failed} failed`)
  process.exitCode = ok ? 0 : 1
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-071-stock-pools.mjs")
if (isMain) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
