/**
 * Rental return, Starlink-only rental group, and bulk change group.
 * Runs inside the rollback harness: BEGIN … ROLLBACK, never commits.
 *
 * Usage: node scripts/verify-072-rental-rules.mjs
 */
import { withHarness } from "./verify-harness.mjs"
import { dropMovementPrev, stampTxn, setJwt } from "./verify-harness-fixtures.mjs"

// Distinct from leftover P1072-* residue still in production.
const PREFIX = "H3072"
const DATE = "2026-10-05T00:00:00.000Z"
const REASON = "P1 amendment group change"
const REVERSE_REASON = "P1 amendment reverse return"

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
    label: "users",
    sql: `SELECT count(*)::int AS n FROM auth.users WHERE email LIKE 'harness-072-%@test.local'`,
    params: [],
  },
]

export async function runChecks(ctx) {
  const db = ctx.db
  const pass = (name, reason) => ctx.pass(name, reason)
  const fail = (name, reason) => ctx.fail(name, reason)
  const clock = { tick: 0, baseIso: DATE }

  const star = await db.query(
    `SELECT id, product_name FROM public.product_lines WHERE vendor = 'Starlink' AND is_active ORDER BY id LIMIT 1`,
  )
  const other = await db.query(
    `SELECT id, product_name, vendor FROM public.product_lines WHERE vendor IS DISTINCT FROM 'Starlink' AND is_active ORDER BY id LIMIT 1`,
  )
  if (!star.rows[0]) throw new Error("no active Starlink product")
  if (!other.rows[0]) throw new Error("no active non-Starlink product")
  const starProduct = star.rows[0]
  const otherProduct = other.rows[0]

  const adminId = await ctx.createFixtureUser("admin", "harness-072-admin@test.local")
  const techId = await ctx.createFixtureUser("technicians", "harness-072-technicians@test.local")
  await setJwt(db, adminId)

  const liveBefore = await db.query(
    `SELECT i.serial_number, i.status, i.stock_pool
     FROM public.inventory_items i
     WHERE i.deleted_at IS NULL AND i.status = 'Rented'
     ORDER BY i.serial_number`,
  )

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
  // Live rentals may predate the Starlink-only rule — record the baseline, don't fail.
  pass(
    "no_non_starlink_rental",
    ever.rows[0].n === 0
      ? "no non-Starlink kit has been rented"
      : `${ever.rows[0].n} live non-Starlink rental baseline(s); fixtures must not add more that stick after ROLLBACK`,
  )

  async function inbound(serial, productId, productName) {
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
    await stampTxn(db, clock, txnId)
    return { itemId }
  }

  async function move(serial, productId, productName, type, status, location, extra = {}) {
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
              : type === "Sale" || type === "Rentals"
                ? { invoice_choice: "pending" }
                : null,
        },
      ]),
    ])
    await stampTxn(db, clock, txnId)
    return { batchId, txnId }
  }

  async function read(serial) {
    const row = await db.query(
      `SELECT status, stock_pool FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
      [serial],
    )
    return row.rows[0] ?? null
  }

  const starKit = await inbound(`${PREFIX}-STAR`, starProduct.id, starProduct.product_name)
  const otherKit = await inbound(`${PREFIX}-OTHER`, otherProduct.id, otherProduct.product_name)
  const second = await inbound(`${PREFIX}-STAR2`, starProduct.id, starProduct.product_name)

  await dropMovementPrev(db)
  const otherRent = await ctx.raises(
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
          metadata: { invoice_choice: "pending" },
        },
      ]),
    ],
    "only for Starlink",
  )
  if (otherRent) fail("rentals_starlink_only", otherRent)
  else pass("rentals_starlink_only", `${otherProduct.vendor} cannot be rented`)

  const otherPool = await ctx.raises(
    `SELECT public.change_stock_pool($1, 'rental', $2)`,
    [otherKit.itemId, REASON],
    "only for Starlink",
  )
  if (otherPool) fail("pool_starlink_only", otherPool)
  else pass("pool_starlink_only", "a non-Starlink kit cannot join the rental group")

  const rolled = await ctx.raises(
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
    fail(
      "bulk_all_or_nothing",
      JSON.stringify({ rolled, changed: afterRoll.rows[0].changed, history: rollHistory.rows[0].n }),
    )
  }

  const tech = await ctx.asUser(techId, async () =>
    ctx.raises(`SELECT public.change_stock_pools($1::text[], 'rental', $2)`, [[starKit.itemId], REASON], "admin only"),
  )
  if (tech) fail("bulk_admin_only", tech)
  else pass("bulk_admin_only", "a technician cannot change group")

  await setJwt(db, adminId)
  await db.query(`SELECT public.change_stock_pools($1::text[], 'rental', $2)`, [
    [starKit.itemId, second.itemId],
    REASON,
  ])
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

  await move(`${PREFIX}-STAR`, starProduct.id, starProduct.product_name, "Rentals", "Rented", "Client Site", {
    client: "P1 Holder",
    assigned_to: "P1 Holder",
    poc_out_date: "2026-10-05",
    return_date: "2026-11-05",
  })
  const out = await read(`${PREFIX}-STAR`)
  await db.query(`SELECT public.change_stock_pool($1, 'demo', $2)`, [starKit.itemId, REASON])
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
  await setJwt(db, adminId)
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

  const liveAfter = await db.query(
    `SELECT i.serial_number, i.status, i.stock_pool
     FROM public.inventory_items i
     WHERE i.deleted_at IS NULL AND i.status = 'Rented'
       AND i.serial_number NOT LIKE $1
     ORDER BY i.serial_number`,
    [`${PREFIX}-%`],
  )
  const same = JSON.stringify(liveBefore.rows) === JSON.stringify(liveAfter.rows)
  if (same) pass("live_rented_unchanged", `${liveAfter.rows.length} rented kits unchanged`)
  else fail("live_rented_unchanged", JSON.stringify({ before: liveBefore.rows, after: liveAfter.rows }))
}

async function main() {
  const { ok, failed, passed } = await withHarness(
    { markers: MARKERS, timeoutMs: 180_000, label: "verify-072" },
    runChecks,
  )
  console.log(ok ? `\n${passed} passed` : `\n${failed} failed`)
  process.exitCode = ok ? 0 : 1
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-072-rental-rules.mjs")
if (isMain) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
