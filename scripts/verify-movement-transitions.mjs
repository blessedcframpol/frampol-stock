/**
 * Movement transition matrix + sample RPC paths — rollback harness.
 * Uses ctx.asUser + SQL; no Auth magiclink clients.
 *
 * Usage: node scripts/verify-movement-transitions.mjs
 */
import { ITEM_STATUSES, MOVEMENT_TYPES, MOVEMENT_RESULT, movementResult } from "../lib/movement-transitions.mjs"
import { withHarness } from "./verify-harness.mjs"
import { dropMovementPrev, setJwt } from "./verify-harness-fixtures.mjs"

const PREFIX = "H3move"
const DATE = "2026-10-07"
const DATE_ISO = `${DATE}T00:00:00.000Z`

let moveSeq = 0
function nextTxn(kind, serial) {
  moveSeq += 1
  return `txn-${PREFIX}-${kind}-${moveSeq}-${serial}`
}

function addDays(ymd, days) {
  const [year, month, day] = ymd.split("-").map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export const MARKERS = [
  {
    label: "items",
    sql: `SELECT count(*)::int AS n FROM public.inventory_items WHERE serial_number LIKE $1 OR id LIKE $2`,
    params: [`${PREFIX}-%`, `item-${PREFIX}-%`],
  },
  {
    label: "transactions",
    sql: `SELECT count(*)::int AS n FROM public.transactions
          WHERE serial_number LIKE $1 OR id LIKE $2`,
    params: [`${PREFIX}-%`, `txn-%${PREFIX}%`],
  },
  {
    label: "holding_extensions",
    sql: `SELECT count(*)::int AS n FROM public.holding_extensions WHERE serial_number LIKE $1`,
    params: [`${PREFIX}-%`],
  },
  {
    label: "users",
    sql: `SELECT count(*)::int AS n FROM auth.users WHERE email LIKE 'harness-move-%@test.local'`,
    params: [],
  },
]

export async function runChecks(ctx) {
  const db = ctx.db
  const pass = (name, reason) => ctx.pass(name, reason)
  const fail = (name, reason) => ctx.fail(name, reason)

  await ctx.createFixtureUser("admin", "harness-move-admin@test.local")
  const techId = await ctx.createFixtureUser("technicians", "harness-move-technicians@test.local")
  const viewerId = await ctx.createFixtureUser("viewer", "harness-move-viewer@test.local")
  const salesId = await ctx.createFixtureUser("sales", "harness-move-sales@test.local")
  await ctx.createFixtureUser("accounts", "harness-move-accounts@test.local")

  async function pairResult(status, type) {
    const sp = `sp_${Math.random().toString(36).slice(2, 10)}`
    await db.query(`SAVEPOINT ${sp}`)
    try {
      const { rows } = await db.query(`SELECT public.movement_result_status($1, $2) AS status`, [
        status,
        type,
      ])
      await db.query(`RELEASE SAVEPOINT ${sp}`)
      return rows[0].status
    } catch (error) {
      await db.query(`ROLLBACK TO SAVEPOINT ${sp}`)
      return { raised: error instanceof Error ? error.message : String(error) }
    }
  }

  let mismatches = 0
  for (const status of ITEM_STATUSES) {
    for (const type of MOVEMENT_TYPES) {
      const expected = movementResult(status, type)
      const actual = await pairResult(status, type)
      const raised = typeof actual === "object"
      if (expected == null) {
        if (!raised || !String(actual.raised).includes("Invalid movement")) {
          mismatches += 1
          fail(`matrix_${type}_from_${status}`, JSON.stringify(actual))
        }
      } else if (actual !== expected) {
        mismatches += 1
        fail(`matrix_${type}_from_${status}`, `expected ${expected}, got ${JSON.stringify(actual)}`)
      }
    }
  }
  if (mismatches === 0) {
    pass(
      "matrix",
      `${ITEM_STATUSES.length * MOVEMENT_TYPES.length} pairs match MOVEMENT_RESULT (${Object.keys(MOVEMENT_RESULT).length} statuses)`,
    )
  }

  const products = await db.query(`SELECT id FROM public.product_lines WHERE is_active ORDER BY id LIMIT 1`)
  if (!products.rows[0]) throw new Error("No product line to attach the fixture")
  const productId = products.rows[0].id
  const overdue = addDays(DATE, -10)
  const dueSoon = addDays(DATE, 6)
  const saleSerial = `${PREFIX}-SALE`
  const extendSerial = `${PREFIX}-EXT`

  await db.query(
    `INSERT INTO public.inventory_items (
       id, product_id, serial_number, status, date_added, location, client, assigned_to, poc_out_date, return_date
     ) VALUES
     ($1, $2, $3, 'POC', $4, 'Client Site', 'Acme Holder', 'Acme Holder', '2026-06-01', $5),
     ($6, $2, $7, 'POC', $4, 'Client Site', 'Extend Holder', 'Extend Holder', '2026-06-01', $5)`,
    [
      `item-${saleSerial}`,
      productId,
      saleSerial,
      DATE,
      overdue,
      `item-${extendSerial}`,
      extendSerial,
    ],
  )

  async function loadItem(serial) {
    const { rows } = await db.query(`SELECT * FROM public.inventory_items WHERE serial_number = $1`, [serial])
    return rows[0]
  }

  async function applyMoveAs(userId, itemRow, type, status, location, extra = {}) {
    const upsert = {
      ...itemRow,
      status,
      location: location ?? itemRow.location,
      ...extra.item,
    }
    const metadata =
      extra.metadata !== undefined
        ? extra.metadata
        : type === "Sale" && itemRow.status === "POC"
          ? { converted_from: "POC", poc_out_date: "2026-06-01" }
          : null
    await dropMovementPrev(db)
    return ctx.asUser(userId, async () => {
      const sp = `sp_${Math.random().toString(36).slice(2, 10)}`
      await db.query(`SAVEPOINT ${sp}`)
      try {
        await db.query(`SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`, [
          JSON.stringify([upsert]),
          JSON.stringify([
            {
              id: nextTxn(type.replace(/\s+/g, ""), itemRow.serial_number),
              type,
              serial_number: itemRow.serial_number,
              item_name: "Fixture",
              client: itemRow.client ?? "Verify Client",
              date: DATE_ISO,
              from_location: type === "Transfer" ? itemRow.location : null,
              to_location: type === "Transfer" ? location : null,
              created_by: null,
              metadata,
            },
          ]),
        ])
        await db.query(`RELEASE SAVEPOINT ${sp}`)
        return null
      } catch (error) {
        await db.query(`ROLLBACK TO SAVEPOINT ${sp}`)
        return error instanceof Error ? error.message : String(error)
      }
    })
  }

  const saleItem = await loadItem(saleSerial)
  const badSale = await applyMoveAs(techId, saleItem, "Rentals", "Sold", saleItem.location)
  if (badSale && /Invalid movement/i.test(badSale)) {
    pass("invalid_transition", "Rentals from POC raises via apply_stock_movement")
  } else {
    fail("invalid_transition", badSale ?? "expected Invalid movement")
  }

  const beforeSale = await db.query(
    `SELECT count(*)::int AS n FROM public.inventory_items WHERE deleted_at IS NULL AND status = 'POC'`,
  )
  const saleError = await applyMoveAs(techId, saleItem, "Sale", "Sold", "Client Site", {
    item: { return_date: null, client: "Acme Holder", poc_out_date: "2026-06-01" },
  })
  if (saleError) {
    fail("poc_to_sale", saleError)
  } else {
    const sold = await loadItem(saleSerial)
    const txn = (
      await db.query(`SELECT type, metadata FROM public.transactions WHERE serial_number = $1 AND type = 'Sale'`, [
        saleSerial,
      ])
    ).rows[0]
    const afterPoc = await db.query(
      `SELECT count(*)::int AS n FROM public.inventory_items WHERE deleted_at IS NULL AND status = 'POC'`,
    )
    if (
      sold.status === "Sold" &&
      sold.location === "Client Site" &&
      sold.client === "Acme Holder" &&
      sold.return_date == null &&
      sold.poc_out_date === "2026-06-01" &&
      txn?.metadata?.converted_from === "POC" &&
      txn?.metadata?.poc_out_date === "2026-06-01" &&
      afterPoc.rows[0].n === beforeSale.rows[0].n - 1
    ) {
      pass("poc_to_sale", "POC → Sale clears return_date and records converted_from")
    } else {
      fail("poc_to_sale", JSON.stringify({ sold, txn, afterPoc: afterPoc.rows[0] }))
    }
  }

  const dispatched = await ctx.asUser(techId, async () => {
    const row = await db.query(
      `SELECT public.dispatched_page($1, $2, $3, NULL, NULL, $4) AS page`,
      [10, 0, "Sale", saleSerial],
    )
    return row.rows[0].page
  })
  const dispatchedText = JSON.stringify(dispatched)
  if (
    dispatchedText.includes(saleSerial) &&
    (dispatchedText.includes('"movement":"Sale"') || dispatchedText.includes('"movement": "Sale"'))
  ) {
    pass("dispatched_sale", "serial appears as Sale in dispatched_page")
  } else {
    fail("dispatched_sale", dispatchedText.slice(0, 200))
  }

  async function extendDenied(userId, reason) {
    return ctx.asUser(userId, async () => {
      const sp = `sp_${Math.random().toString(36).slice(2, 10)}`
      await db.query(`SAVEPOINT ${sp}`)
      try {
        await db.query(`SELECT public.extend_holding($1, $2, $3)`, [
          `item-${extendSerial}`,
          dueSoon,
          reason,
        ])
        await db.query(`ROLLBACK TO SAVEPOINT ${sp}`)
        return `${reason}: expected raise`
      } catch {
        await db.query(`ROLLBACK TO SAVEPOINT ${sp}`)
        return null
      }
    })
  }
  const viewerExtendMsg = await extendDenied(viewerId, "viewer should fail")
  const salesExtendMsg = await extendDenied(salesId, "sales should fail")
  if (!viewerExtendMsg && !salesExtendMsg) {
    pass("extend_roles", "viewer and sales cannot extend_holding")
  } else {
    fail("extend_roles", viewerExtendMsg || salesExtendMsg)
  }

  await setJwt(db, techId)
  await db.query(`SELECT public.extend_holding($1, $2, $3)`, [
    `item-${extendSerial}`,
    dueSoon,
    "Customer asked for another week",
  ])
  const extended = (
    await db.query(`SELECT return_date FROM public.inventory_items WHERE serial_number = $1`, [extendSerial])
  ).rows[0]
  const audit = (
    await db.query(
      `SELECT previous_date, new_date, reason, holding_type FROM public.holding_extensions WHERE serial_number = $1`,
      [extendSerial],
    )
  ).rows[0]
  if (
    extended?.return_date === dueSoon &&
    audit?.previous_date === overdue &&
    audit?.new_date === dueSoon &&
    audit?.holding_type === "POC"
  ) {
    pass("extend_holding", "technician extends overdue POC to due soon")
  } else {
    fail("extend_holding", JSON.stringify({ extended, audit }))
  }

  const stockSerial = `${PREFIX}-STOCK`
  const loanSerial = `${PREFIX}-LOAN`
  const pocTransferSerial = `${PREFIX}-XFER-POC`
  const rentTransferSerial = `${PREFIX}-XFER-RENT`
  const maintSerial = `${PREFIX}-MAINT`
  await db.query(
    `INSERT INTO public.inventory_items (
       id, product_id, serial_number, status, date_added, location, client, assigned_to, return_date
     ) VALUES
     ($1, $2, $3, 'In Stock', $4, 'Warehouse A', NULL, NULL, NULL),
     ($5, $2, $6, 'In Stock', $4, 'Warehouse A', NULL, NULL, NULL),
     ($7, $2, $8, 'POC', $4, 'Client Site', 'Site Holder', 'Site Holder', $9),
     ($10, $2, $11, 'Rented', $4, 'Client Site', 'Rent Holder', 'Rent Holder', $9),
     ($12, $2, $13, 'In Stock', $4, 'Warehouse A', NULL, NULL, NULL)`,
    [
      `item-${stockSerial}`,
      productId,
      stockSerial,
      DATE,
      `item-${loanSerial}`,
      loanSerial,
      `item-${pocTransferSerial}`,
      pocTransferSerial,
      overdue,
      `item-${rentTransferSerial}`,
      rentTransferSerial,
      `item-${maintSerial}`,
      maintSerial,
    ],
  )

  const stockItem = await loadItem(stockSerial)
  const stockSaleError = await applyMoveAs(techId, stockItem, "Sale", "Sold", "Delivered")
  const stockSold = await loadItem(stockSerial)
  if (!stockSaleError && stockSold.status === "Sold" && stockSold.location === "Delivered") {
    pass("normal_sale", "normal Sale location Delivered")
  } else {
    fail("normal_sale", stockSaleError || JSON.stringify(stockSold))
  }

  const loanItem = await loadItem(loanSerial)
  const loanError = await applyMoveAs(techId, loanItem, "Remediation Loaner Issue", "Sold", "Delivered")
  const loaned = await loadItem(loanSerial)
  const loanReturnError = await applyMoveAs(techId, loaned, "Sale Return", "RMA Hold", "Warehouse A")
  const loanReturned = await loadItem(loanSerial)
  const loanAgain = await applyMoveAs(techId, loanReturned, "Remediation Loaner Issue", "Sold", "Delivered")
  if (
    !loanError &&
    loaned.status === "Sold" &&
    !loanReturnError &&
    loanReturned.status === "RMA Hold" &&
    loanAgain &&
    /Invalid movement/i.test(loanAgain)
  ) {
    pass("loaner", "loaner issue and return; re-issue from RMA Hold rejected")
  } else {
    fail("loaner", JSON.stringify({ loanError, loaned, loanReturnError, loanReturned, loanAgain }))
  }

  let transferOk = true
  for (const [serial, movement] of [
    [pocTransferSerial, "POC Out"],
    [rentTransferSerial, "Rentals"],
  ]) {
    const before = await loadItem(serial)
    const error = await applyMoveAs(techId, before, "Transfer", before.status, "Warehouse B")
    const after = await loadItem(serial)
    const page = await ctx.asUser(techId, async () => {
      const row = await db.query(
        `SELECT public.dispatched_page($1, $2, $3, NULL, NULL, $4) AS page`,
        [5, 0, movement, serial],
      )
      return row.rows[0].page
    })
    const stillOut = await db.query(
      `SELECT count(*)::int AS n FROM public.inventory_items
       WHERE serial_number = $1 AND deleted_at IS NULL
         AND status IN ('POC', 'Rented')
         AND return_date IS NOT NULL AND return_date <> '' AND return_date < $2`,
      [serial, DATE],
    )
    if (
      error ||
      after.status !== before.status ||
      after.location !== "Warehouse B" ||
      !JSON.stringify(page).includes(serial) ||
      stillOut.rows[0].n !== 1
    ) {
      transferOk = false
      fail(`transfer_${serial}`, JSON.stringify({ error, after, stillOut: stillOut.rows[0] }))
    }
  }
  if (transferOk) pass("transfer", "transfer from POC and Rented keeps status and Dispatched membership")

  // Transfer keeps status — it cannot enter Maintenance from In Stock (matrix already encodes this).
  const maintItem = await loadItem(maintSerial)
  const blocked = await applyMoveAs(techId, maintItem, "Transfer", "Maintenance", "Service Center")
  if (blocked && /Invalid movement/i.test(blocked)) {
    pass("maint_ungated", "Transfer cannot enter Maintenance")
  } else {
    fail("maint_ungated", blocked ?? "expected Invalid movement")
  }

  const fakeMaint = await applyMoveAs(techId, maintItem, "Sale", "Maintenance", "Service Center")
  if (fakeMaint && /Invalid movement/i.test(fakeMaint)) {
    pass("maint_via_sale", "Sale cannot enter Maintenance")
  } else {
    fail("maint_via_sale", fakeMaint ?? "expected Invalid movement")
  }

  // Production guard requires app.movement_type; In Stock→Maintenance only as Reversal of Inbound.
  await db.query(`SELECT set_config('app.movement_type', 'Reversal', true)`)
  await db.query(`SELECT set_config('app.reversal_original_type', 'Inbound', true)`)
  await db.query(`UPDATE public.inventory_items SET status = 'Maintenance' WHERE serial_number = $1`, [
    maintSerial,
  ])
  await db.query(`SELECT set_config('app.movement_type', '', true)`)
  await db.query(`SELECT set_config('app.reversal_original_type', '', true)`)
  const inMaintenance = await loadItem(maintSerial)
  const backError = await applyMoveAs(techId, inMaintenance, "Inbound", "In Stock", "Warehouse A")
  const repaired = await loadItem(maintSerial)
  if (!backError && inMaintenance.status === "Maintenance" && repaired.status === "In Stock") {
    pass("maint_reversal_path", "Maintenance via Inbound reversal, then Inbound back to stock")
  } else {
    fail("maint_reversal_path", JSON.stringify({ inMaintenance, backError, repaired }))
  }

}

async function main() {
  const { ok, failed, passed } = await withHarness(
    { markers: MARKERS, timeoutMs: 300_000, label: "verify-movement" },
    runChecks,
  )
  console.log(ok ? `\n${passed} passed` : `\n${failed} failed`)
  process.exitCode = ok ? 0 : 1
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-movement-transitions.mjs")
if (isMain) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
