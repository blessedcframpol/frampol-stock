/**
 * Kit cases: decommission and rental-return intake, inspection outcomes, reverse and restore.
 * Rollback harness (BEGIN…ROLLBACK, never commits). Fixture-only asserts; optional index check.
 *
 * Usage: node scripts/verify-073-kit-cases.mjs
 */
import { withHarness } from "./verify-harness.mjs"
import {
  dropMovementPrev,
  stampTxn,
  bumpRestoreClock,
  setJwt,
} from "./verify-harness-fixtures.mjs"

const PREFIX = "H3073"
const DATE = "2026-10-05T00:00:00.000Z"
const DAY = "2026-10-05"
const REASON = "Recorded reason for the return"
const CATEGORY = "Client cancelled"
const COMMENTS = "Checked the kit before choosing an outcome"
const REVERSE_REASON = "H3 verify reverse inspection"
const RESTORE_REASON = "H3 verify restore inspection"
const HOLDER = "H3073 Holder"

let seq = 0
function nextId(kind) {
  seq += 1
  return `${kind}-${PREFIX}-${seq}`
}

function intakeMeta() {
  return { reason_category: CATEGORY, reason_text: REASON }
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
    label: "kit_cases",
    sql: `SELECT count(*)::int AS n FROM public.kit_cases kc
          JOIN public.inventory_items item ON item.id = kc.inventory_item_id
          WHERE item.serial_number LIKE $1`,
    params: [`${PREFIX}%`],
  },
  {
    label: "users",
    sql: `SELECT count(*)::int AS n FROM auth.users WHERE email LIKE 'harness-073-%@test.local'`,
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
  const client = await db.query(`SELECT id FROM public.clients ORDER BY id LIMIT 1`)
  if (!star.rows[0] || !other.rows[0] || !client.rows[0]) throw new Error("need Starlink, non-Starlink product, and a client")

  const starProduct = star.rows[0]
  const otherProduct = other.rows[0]
  const clientId = client.rows[0].id

  const adminId = await ctx.createFixtureUser("admin", "harness-073-admin@test.local")
  const techId = await ctx.createFixtureUser("technicians", "harness-073-technicians@test.local")
  await setJwt(db, adminId)

  const index = await db.query(
    `SELECT 1 AS ok FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'kit_cases_one_open_per_item'`,
  )
  if (index.rowCount === 1) pass("index_one_open", "kit_cases_one_open_per_item exists")
  else pass("index_one_open", "absent here — schema-rules covers the index")

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
          date_added: DAY,
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
      `SELECT id, client, assigned_to, stock_pool FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
      [serial],
    )
    const txnId = nextId("TXN")
    const batchId = nextId("BATCH")
    const keep = type === "Decommissioned" || type === "Rental Return"
    await dropMovementPrev(db)
    await db.query(`SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`, [
      JSON.stringify([
        {
          id: current.rows[0].id,
          product_id: productId,
          serial_number: serial,
          status,
          date_added: DAY,
          location,
          client: keep ? current.rows[0].client : (extra.client ?? null),
          assigned_to: keep ? current.rows[0].assigned_to : (extra.assigned_to ?? null),
        },
      ]),
      JSON.stringify([
        {
          id: txnId,
          type,
          serial_number: serial,
          item_name: productName,
          date: DATE,
          client: extra.client ?? current.rows[0].client ?? "Internal",
          batch_id: batchId,
          to_location: location,
          metadata: (() => {
            const base = extra.metadata ? { ...extra.metadata } : {}
            if (
              (type === "Sale" || type === "Rentals") &&
              !base.invoice_choice
            ) {
              base.invoice_choice = "pending"
            }
            return Object.keys(base).length ? base : null
          })(),
        },
      ]),
    ])
    await stampTxn(db, clock, txnId)
    return { batchId, itemId: current.rows[0].id, txnId }
  }

  async function read(serial) {
    const row = await db.query(
      `SELECT id, status, stock_pool, client, assigned_to, location, poc_out_date, return_date
       FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
      [serial],
    )
    return row.rows[0] ?? null
  }

  async function openCase(serial) {
    const row = await db.query(
      `SELECT kc.id, kc.stage, kc.outcome, kc.client_id, kc.reason_category, src.type AS source_type
       FROM public.kit_cases kc
       JOIN public.inventory_items item ON item.id = kc.inventory_item_id
       JOIN public.transactions src ON src.id = kc.source_transaction_id
       WHERE item.serial_number = $1
       ORDER BY kc.opened_at DESC
       LIMIT 1`,
      [serial],
    )
    return row.rows[0] ?? null
  }

  const missing = await inbound(`${PREFIX}-MISS`, starProduct.id, starProduct.product_name)
  await move(`${PREFIX}-MISS`, starProduct.id, starProduct.product_name, "Sale", "Sold", "Delivered", {
    client: HOLDER,
    assigned_to: HOLDER,
  })
  const missingReason = await ctx.raises(
    `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
    [
      JSON.stringify([
        {
          id: missing.itemId,
          product_id: starProduct.id,
          serial_number: `${PREFIX}-MISS`,
          status: "Pending Inspection",
          date_added: DAY,
          location: "Warehouse A",
          client: HOLDER,
          assigned_to: HOLDER,
        },
      ]),
      JSON.stringify([
        {
          id: nextId("TXN"),
          type: "Decommissioned",
          serial_number: `${PREFIX}-MISS`,
          item_name: starProduct.product_name,
          date: DATE,
          client: HOLDER,
          batch_id: nextId("BATCH"),
          to_location: "Warehouse A",
        },
      ]),
    ],
    "typed reason",
  )
  if (missingReason) fail("intake_requires_reason", missingReason)
  else pass("intake_requires_reason", "Decommissioned without a category and reason is rejected")

  const decSerial = `${PREFIX}-DEC`
  await inbound(decSerial, starProduct.id, starProduct.product_name)
  await move(decSerial, starProduct.id, starProduct.product_name, "Sale", "Sold", "Delivered", {
    client: HOLDER,
    assigned_to: HOLDER,
  })
  await move(decSerial, starProduct.id, starProduct.product_name, "Decommissioned", "Pending Inspection", "Warehouse A", {
    metadata: intakeMeta(),
    client: HOLDER,
  })
  const dec = await read(decSerial)
  const decCase = await openCase(decSerial)
  if (
    dec?.status === "Pending Inspection" &&
    dec.stock_pool === "sale" &&
    dec.client === HOLDER &&
    dec.assigned_to === HOLDER &&
    decCase?.stage === "open" &&
    decCase.source_type === "Decommissioned"
  ) {
    pass("decommission_opens_case", "Decommissioned opens a case and keeps the holder and group")
  } else {
    fail("decommission_opens_case", JSON.stringify({ dec, decCase }))
  }

  const rentSerial = `${PREFIX}-RENT`
  await inbound(rentSerial, starProduct.id, starProduct.product_name)
  await move(rentSerial, starProduct.id, starProduct.product_name, "Rentals", "Rented", "Client Site", {
    client: HOLDER,
    assigned_to: HOLDER,
  })
  await move(rentSerial, starProduct.id, starProduct.product_name, "Rental Return", "Pending Inspection", "Warehouse A", {
    metadata: intakeMeta(),
    client: HOLDER,
  })
  const rent = await read(rentSerial)
  const rentCase = await openCase(rentSerial)
  if (
    rent?.status === "Pending Inspection" &&
    rent.stock_pool === "rental" &&
    rent.client === HOLDER &&
    rentCase?.source_type === "Rental Return" &&
    rentCase.stage === "open"
  ) {
    pass("rental_return_opens_case", "Rental Return opens a case, stays rental, and keeps the holder")
  } else {
    fail("rental_return_opens_case", JSON.stringify({ rent, rentCase }))
  }

  const unknown = `${PREFIX}-NEW`
  const unknownItem = nextId("ITEM")
  const unknownTxn = nextId("TXN")
  await dropMovementPrev(db)
  await db.query(`SELECT public.apply_stock_movement('[]'::jsonb, $1::jsonb, $2::jsonb)`, [
    JSON.stringify([
      {
        id: unknownItem,
        product_id: starProduct.id,
        serial_number: unknown,
        status: "Pending Inspection",
        date_added: DAY,
        location: "Warehouse A",
        client: HOLDER,
      },
    ]),
    JSON.stringify([
      {
        id: unknownTxn,
        type: "Decommissioned",
        serial_number: unknown,
        item_name: starProduct.product_name,
        date: DATE,
        client: HOLDER,
        client_id: clientId,
        batch_id: nextId("BATCH"),
        to_location: "Warehouse A",
        metadata: intakeMeta(),
      },
    ]),
  ])
  await stampTxn(db, clock, unknownTxn)
  const created = await read(unknown)
  const createdCase = await openCase(unknown)
  if (
    created?.status === "Pending Inspection" &&
    created.poc_out_date == null &&
    created.return_date == null &&
    createdCase?.client_id === clientId
  ) {
    pass("unknown_serial_client", "An unknown serial records the return date, links a client, and opens a case")
  } else {
    fail("unknown_serial_client", JSON.stringify({ created, createdCase }))
  }

  const noClient = await ctx.raises(
    `SELECT public.apply_stock_movement('[]'::jsonb, $1::jsonb, $2::jsonb)`,
    [
      JSON.stringify([
        {
          id: nextId("ITEM"),
          product_id: starProduct.id,
          serial_number: `${PREFIX}-NOCLIENT`,
          status: "Pending Inspection",
          date_added: DAY,
          location: "Warehouse A",
        },
      ]),
      JSON.stringify([
        {
          id: nextId("TXN"),
          type: "Decommissioned",
          serial_number: `${PREFIX}-NOCLIENT`,
          item_name: starProduct.product_name,
          date: DATE,
          batch_id: nextId("BATCH"),
          to_location: "Warehouse A",
          metadata: intakeMeta(),
        },
      ]),
    ],
    "needs a client",
  )
  if (noClient) fail("unknown_serial_requires_client", noClient)
  else pass("unknown_serial_requires_client", "An unknown serial without a client is rejected")

  const otherSerial = `${PREFIX}-OTHER`
  await inbound(otherSerial, otherProduct.id, otherProduct.product_name)
  await move(otherSerial, otherProduct.id, otherProduct.product_name, "Sale", "Sold", "Delivered", {
    client: HOLDER,
    assigned_to: HOLDER,
  })
  await move(otherSerial, otherProduct.id, otherProduct.product_name, "Decommissioned", "Pending Inspection", "Warehouse A", {
    metadata: intakeMeta(),
    client: HOLDER,
  })
  const otherCase = await openCase(otherSerial)
  // Drop temp tables as the connection owner, not inside asUser (authenticated).
  await dropMovementPrev(db)
  const rentOutRejected = await ctx.asUser(adminId, async () =>
    ctx.raises(
      `SELECT public.complete_inspection($1, 'Pass', $2, 'B', 'Rent out', 'Warehouse A', NULL)`,
      [otherCase.id, COMMENTS],
      "only for Starlink",
    ),
  )
  if (rentOutRejected) fail("rent_out_starlink_only", rentOutRejected)
  else pass("rent_out_starlink_only", "Rent out is rejected for non-Starlink")

  await dropMovementPrev(db)
  const failResell = await ctx.asUser(adminId, async () =>
    ctx.raises(
      `SELECT public.complete_inspection($1, 'Fail', $2, 'C', 'Resell', NULL, NULL)`,
      [otherCase.id, COMMENTS],
      "Resell is rejected after a Fail",
    ),
  )
  if (failResell) fail("resell_after_fail", failResell)
  else pass("resell_after_fail", "Resell is rejected after a Fail")

  await setJwt(db, adminId)
  await dropMovementPrev(db)
  await db.query(`SELECT public.complete_inspection($1, 'Pass', $2, 'A', 'Resell', 'Warehouse A', NULL)`, [
    decCase.id,
    COMMENTS,
  ])
  const resold = await read(decSerial)
  const resoldCase = await openCase(decSerial)
  if (
    resold?.status === "In Stock" &&
    resold.stock_pool === "sale" &&
    resold.client == null &&
    resoldCase?.stage === "closed" &&
    resoldCase.outcome === "Resell"
  ) {
    pass("resell_outcome", "Resell returns the kit to In Stock in the sale group and clears the holder")
  } else {
    fail("resell_outcome", JSON.stringify({ resold, resoldCase }))
  }

  await dropMovementPrev(db)
  await db.query(`SELECT public.complete_inspection($1, 'Pass', $2, 'B', 'Rent out', 'Warehouse B', NULL)`, [
    rentCase.id,
    COMMENTS,
  ])
  const rentedOut = await read(rentSerial)
  const rentedCase = await openCase(rentSerial)
  if (
    rentedOut?.status === "In Stock" &&
    rentedOut.stock_pool === "rental" &&
    rentedOut.client == null &&
    rentedOut.location === "Warehouse B" &&
    rentedCase?.outcome === "Rent out"
  ) {
    pass("rent_out_outcome", "Rent out returns a Starlink kit to In Stock in the rental group")
  } else {
    fail("rent_out_outcome", JSON.stringify({ rentedOut, rentedCase }))
  }

  const vendorSerial = `${PREFIX}-RMA`
  await inbound(vendorSerial, otherProduct.id, otherProduct.product_name)
  await move(vendorSerial, otherProduct.id, otherProduct.product_name, "Sale", "Sold", "Delivered", {
    client: HOLDER,
    assigned_to: HOLDER,
  })
  await move(vendorSerial, otherProduct.id, otherProduct.product_name, "Decommissioned", "Pending Inspection", "Warehouse A", {
    metadata: intakeMeta(),
    client: HOLDER,
  })
  const vendorCase = await openCase(vendorSerial)
  await dropMovementPrev(db)
  await db.query(`SELECT public.complete_inspection($1, 'Fail', $2, 'C', 'Return to vendor', NULL, NULL)`, [
    vendorCase.id,
    COMMENTS,
  ])
  const vendor = await read(vendorSerial)
  const vendorClosed = await openCase(vendorSerial)
  if (
    vendor?.status === "RMA Hold" &&
    vendor.stock_pool === "sale" &&
    vendor.client === HOLDER &&
    vendorClosed?.outcome === "Return to vendor" &&
    vendorClosed.stage === "closed"
  ) {
    pass("return_to_vendor", "Return to vendor closes the case on RMA Hold and keeps the holder and group")
  } else {
    fail("return_to_vendor", JSON.stringify({ vendor, vendorClosed }))
  }

  const disposeSerial = `${PREFIX}-DISP`
  await inbound(disposeSerial, starProduct.id, starProduct.product_name)
  await move(disposeSerial, starProduct.id, starProduct.product_name, "Sale", "Sold", "Delivered", {
    client: HOLDER,
    assigned_to: HOLDER,
  })
  await move(disposeSerial, starProduct.id, starProduct.product_name, "Decommissioned", "Pending Inspection", "Warehouse A", {
    metadata: intakeMeta(),
    client: HOLDER,
  })
  const disposeCase = await openCase(disposeSerial)
  await dropMovementPrev(db)
  await db.query(`SELECT public.complete_inspection($1, 'Fail', $2, 'C', 'Dispose', NULL, NULL)`, [
    disposeCase.id,
    COMMENTS,
  ])
  const disposed = await read(disposeSerial)
  const disposeClosed = await openCase(disposeSerial)
  if (
    disposed?.status === "Disposed" &&
    disposed.stock_pool === "sale" &&
    disposed.client === HOLDER &&
    disposeClosed?.outcome === "Dispose"
  ) {
    pass("dispose_outcome", "Dispose closes the case and keeps the holder and group")
  } else {
    fail("dispose_outcome", JSON.stringify({ disposed, disposeClosed }))
  }

  const cycleSerial = `${PREFIX}-CYCLE`
  await inbound(cycleSerial, starProduct.id, starProduct.product_name)
  await move(cycleSerial, starProduct.id, starProduct.product_name, "Sale", "Sold", "Delivered", {
    client: HOLDER,
    assigned_to: HOLDER,
  })
  await move(cycleSerial, starProduct.id, starProduct.product_name, "Decommissioned", "Pending Inspection", "Warehouse A", {
    metadata: intakeMeta(),
    client: HOLDER,
  })
  const cycleCase = await openCase(cycleSerial)
  await dropMovementPrev(db)
  await db.query(`SELECT public.complete_inspection($1, 'Pass', $2, 'A', 'Resell', 'Warehouse A', NULL)`, [
    cycleCase.id,
    COMMENTS,
  ])
  const cycleTxn = await db.query(
    `SELECT id, batch_id FROM public.transactions WHERE serial_number = $1 AND type = 'Inspection Pass' ORDER BY created_at DESC LIMIT 1`,
    [cycleSerial],
  )
  await stampTxn(db, clock, cycleTxn.rows[0].id)
  await db.query(`SELECT public.reverse_quick_scan_batch($1, $2, NULL, '[]'::jsonb, '[]'::jsonb)`, [
    cycleTxn.rows[0].batch_id,
    REVERSE_REASON,
  ])
  const reopened = await read(cycleSerial)
  const reopenedCase = await openCase(cycleSerial)
  const reopenedEvent = await db.query(
    `SELECT count(*)::int AS n FROM public.kit_case_events WHERE case_id = $1 AND event_type = 'reopened'`,
    [cycleCase.id],
  )
  if (
    reopened?.status === "Pending Inspection" &&
    reopened.stock_pool === "sale" &&
    reopenedCase?.stage === "open" &&
    reopenedEvent.rows[0].n === 1
  ) {
    pass("reverse_reopens", "Reversing the inspection puts the kit back and reopens the case")
  } else {
    fail("reverse_reopens", JSON.stringify({ reopened, reopenedCase, events: reopenedEvent.rows[0] }))
  }
  await db.query(`SELECT public.restore_batch($1, $2)`, [cycleTxn.rows[0].batch_id, RESTORE_REASON])
  await bumpRestoreClock(db, cycleTxn.rows[0].batch_id)
  const restored = await read(cycleSerial)
  const restoredCase = await openCase(cycleSerial)
  const reclosed = await db.query(
    `SELECT count(*)::int AS n FROM public.kit_case_events WHERE case_id = $1 AND event_type = 're-closed'`,
    [cycleCase.id],
  )
  if (
    restored?.status === "In Stock" &&
    restored.stock_pool === "sale" &&
    restoredCase?.stage === "closed" &&
    reclosed.rows[0].n === 1
  ) {
    pass("restore_recloses", "Restore puts the outcome back and re-closes the case")
  } else {
    fail("restore_recloses", JSON.stringify({ restored, restoredCase, events: reclosed.rows[0] }))
  }

  await dropMovementPrev(db)
  const techRejected = await ctx.asUser(techId, async () =>
    ctx.raises(
      `SELECT public.complete_inspection($1, 'Pass', $2, 'A', 'Resell', 'Warehouse A', NULL)`,
      [otherCase.id, COMMENTS],
      "admin only",
    ),
  )
  if (techRejected) fail("non_admin_rejected", techRejected)
  else pass("non_admin_rejected", "A technician cannot complete an inspection")

  await setJwt(db, adminId)
  const append = await ctx.raises(
    `UPDATE public.kit_case_events SET reason = 'changed' WHERE case_id = $1`,
    [decCase.id],
    "cannot be changed",
  )
  if (append) fail("events_append_only", append)
  else pass("events_append_only", "Case events cannot be updated")

  // Clear GUC left by complete_inspection in this txn (set_config … true is txn-local).
  await db.query(`SELECT set_config('app.inspection_case', '', true)`)
  await db.query(`SELECT set_config('app.movement_type', '', true)`)
  // otherSerial still has an open case (Rent out / Fail-Resell were rejected).
  await dropMovementPrev(db)
  const otherItem = await read(otherSerial)
  const direct = await ctx.raises(
    `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
    [
      JSON.stringify([
        {
          id: otherItem.id,
          product_id: otherProduct.id,
          serial_number: otherSerial,
          status: "In Stock",
          date_added: DAY,
          location: "Warehouse A",
        },
      ]),
      JSON.stringify([
        {
          id: nextId("TXN"),
          type: "Inspection Pass",
          serial_number: otherSerial,
          item_name: otherProduct.product_name,
          date: DATE,
          client: "",
          batch_id: nextId("BATCH"),
          inspection_pool: "sale",
        },
      ]),
    ],
    "Record the inspection",
  )
  if (direct) fail("inspection_only_from_case", direct)
  else pass("inspection_only_from_case", "Inspection Pass outside the case is rejected")

  const remediation = await db.query(`SELECT count(*)::int AS n FROM public.remediation_cases`)
  // Live remediation may already have cases — record the baseline, don't fail.
  pass(
    "remediation_untouched",
    remediation.rows[0].n === 0
      ? "remediation_cases still has no rows"
      : `${remediation.rows[0].n} live remediation case(s) (baseline; fixtures must not add more that stick after ROLLBACK)`,
  )
}

async function main() {
  const { ok, failed, passed } = await withHarness(
    { markers: MARKERS, timeoutMs: 300_000, label: "verify-073" },
    runChecks,
  )
  console.log(ok ? `\n${passed} passed` : `\n${failed} failed`)
  process.exitCode = ok ? 0 : 1
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-073-kit-cases.mjs")
if (isMain) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
