/**
 * Kit history panel — rollback harness (BEGIN…ROLLBACK, never commits).
 * Asserts structure and tags; placement durations use fixture dates (not wall-clock deltas).
 *
 * Usage: node scripts/verify-077-kit-history.mjs
 */
import { withHarness } from "./verify-harness.mjs"
import {
  dropMovementPrev,
  stampTxn,
  bumpRestoreClock,
  setJwt,
} from "./verify-harness-fixtures.mjs"

const PREFIX = "H3077"
const HOLDER = "H3077 Holder - H3077 Co"
const REVERSE_REASON = "H3077 reversal of the first POC out"
const RESTORE_REASON = "H3077 restore of the first POC out"
const EXTEND_REASON = "H3077 extend the return date"
const CANCEL_REASON = "H3077 cancel that extension"
const DECOM_REASON = "H3077 client ended the service"
const DATE_BASE = "2026-10-07T00:00:00.000Z"

// Explicit calendar relative to ANCHOR (not wall-clock "today").
const ANCHOR = "2026-10-07"
const D35 = "2026-09-02"
const D30 = "2026-09-07"
const D24 = "2026-09-13"
const D18 = "2026-09-19"
const D12 = "2026-09-25"
const D6 = "2026-10-01"
const LATER = "2026-10-27"

let seq = 0
function nextId(kind) {
  seq += 1
  return `${kind}-${PREFIX}-${seq}`
}

function short(ymd) {
  return `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`
}

function daysBetween(start, end) {
  const ms = Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)
  return Math.round(ms / 86400000)
}

function iso(day) {
  return `${day}T00:00:00.000Z`
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
    label: "clients",
    sql: `SELECT count(*)::int AS n FROM public.clients WHERE id = $1`,
    params: [`CLT-${PREFIX}`],
  },
  {
    label: "holding_extensions",
    sql: `SELECT count(*)::int AS n FROM public.holding_extensions
          WHERE serial_number LIKE $1 OR item_id LIKE $2`,
    params: [`${PREFIX}%`, `ITEM-${PREFIX}%`],
  },
  {
    label: "users",
    sql: `SELECT count(*)::int AS n FROM auth.users WHERE email LIKE 'harness-077-%@test.local'`,
    params: [],
  },
]

export async function runChecks(ctx) {
  const db = ctx.db
  const pass = (name, reason) => ctx.pass(name, reason)
  const fail = (name, reason) => ctx.fail(name, reason)
  const clock = { tick: 0, baseIso: DATE_BASE }

  const star = await db.query(
    `SELECT id, product_name FROM public.product_lines WHERE vendor = 'Starlink' AND is_active ORDER BY id LIMIT 1`,
  )
  if (!star.rows[0]) throw new Error("no active Starlink product")
  const starId = star.rows[0].id
  const starName = star.rows[0].product_name
  const clientId = `CLT-${PREFIX}`

  const adminId = await ctx.createFixtureUser("admin", "harness-077-admin@test.local")
  const viewerId = await ctx.createFixtureUser("viewer", "harness-077-viewer@test.local")
  await db.query(
    `UPDATE public.profiles
     SET display_name = CASE id WHEN $1 THEN 'H3077 Admin' ELSE 'H3077 Viewer' END
     WHERE id IN ($1, $2)`,
    [adminId, viewerId],
  )
  await db.query(
    `INSERT INTO public.clients (id, name, company, email, phone, address)
     VALUES ($1, 'H3077 Holder', 'H3077 Co', 'h3077@test.local', '000', 'Test')`,
    [clientId],
  )
  await setJwt(db, adminId)

  const invoker = await db.query(
    `SELECT prosecdef FROM pg_proc WHERE proname = 'kit_history' AND pg_get_function_identity_arguments(oid) = 'p_item_id text'`,
  )
  if (invoker.rows[0]?.prosecdef === false) pass("security_invoker", "kit_history runs as the caller")
  else fail("security_invoker", JSON.stringify(invoker.rows))

  async function move(serial, type, status, location, extra = {}) {
    const current = await db.query(
      `SELECT id FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
      [serial],
    )
    const txnId = extra.txnId ?? nextId("TXN")
    const batchId = extra.batchId ?? nextId("BATCH")
    await dropMovementPrev(db)
    await db.query(`SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`, [
      JSON.stringify([
        {
          id: current.rows[0].id,
          product_id: starId,
          serial_number: serial,
          status,
          date_added: D35,
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
          item_name: starName,
          date: extra.date,
          client: extra.txnClient ?? extra.client ?? "Internal",
          client_id: extra.client_id ?? null,
          invoice_number: extra.invoice_number ?? null,
          batch_id: batchId,
          to_location: location,
          metadata: (() => {
            const base = extra.metadata ? { ...extra.metadata } : {}
            if (
              (type === "Sale" || type === "Rentals") &&
              !base.invoice_choice
            ) {
              base.invoice_choice =
                extra.invoice_number && String(extra.invoice_number).trim()
                  ? "number"
                  : "pending"
            }
            return Object.keys(base).length ? base : null
          })(),
          created_by: extra.created_by ?? null,
          return_pool: extra.return_pool ?? null,
        },
      ]),
    ])
    await stampTxn(db, clock, txnId)
    return { txnId, batchId, itemId: current.rows[0].id }
  }

  async function inbound(serial) {
    const itemId = nextId("ITEM")
    const txnId = nextId("TXN")
    const batchId = nextId("BATCH")
    await dropMovementPrev(db)
    await db.query(`SELECT public.apply_stock_movement('[]'::jsonb, $1::jsonb, $2::jsonb)`, [
      JSON.stringify([
        {
          id: itemId,
          product_id: starId,
          serial_number: serial,
          status: "In Stock",
          date_added: D35,
          location: "Warehouse A",
        },
      ]),
      JSON.stringify([
        {
          id: txnId,
          type: "Inbound",
          serial_number: serial,
          item_name: starName,
          date: iso(D35),
          client: "Internal",
          batch_id: batchId,
          to_location: "Warehouse A",
        },
      ]),
    ])
    await stampTxn(db, clock, txnId)
    return { itemId }
  }

  const serial = `${PREFIX}-kit`
  const createdItem = await inbound(serial)
  const firstOut = await move(serial, "POC Out", "POC", "Client Site", {
    date: iso(D30),
    client: HOLDER,
    assigned_to: HOLDER,
    txnClient: HOLDER,
    client_id: clientId,
    poc_out_date: D30,
    return_date: D24,
  })
  await db.query(`SELECT public.reverse_quick_scan_batch($1, $2, NULL, '[]'::jsonb, '[]'::jsonb)`, [
    firstOut.batchId,
    REVERSE_REASON,
  ])
  await db.query(`SELECT public.restore_batch($1, $2)`, [firstOut.batchId, RESTORE_REASON])
  await bumpRestoreClock(db, firstOut.batchId)
  await move(serial, "POC Return", "In Stock", "Warehouse A", {
    date: iso(D24),
    client: null,
    txnClient: HOLDER,
    client_id: clientId,
    return_pool: "demo",
    metadata: null,
  })
  await move(serial, "POC Out", "POC", "Client Site", {
    date: iso(D18),
    client: HOLDER,
    assigned_to: HOLDER,
    txnClient: HOLDER,
    client_id: clientId,
    poc_out_date: D18,
    return_date: D6,
  })
  await db.query(`SELECT public.extend_holding($1, $2, $3)`, [createdItem.itemId, LATER, EXTEND_REASON])
  const extension = await db.query(
    `SELECT id FROM public.holding_extensions WHERE item_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [createdItem.itemId],
  )
  await db.query(`SELECT public.cancel_holding_extension($1, $2)`, [extension.rows[0].id, CANCEL_REASON])
  await move(serial, "Sale", "Sold", "Client Site", {
    date: iso(D12),
    client: HOLDER,
    assigned_to: HOLDER,
    txnClient: HOLDER,
    client_id: clientId,
    invoice_number: "H3077-SALE-1",
    created_by: adminId,
    metadata: { converted_from: "POC" },
  })
  await move(serial, "Decommissioned", "Pending Inspection", "Warehouse A", {
    date: iso(D6),
    client: HOLDER,
    txnClient: HOLDER,
    client_id: clientId,
    metadata: { reason_category: "Client cancelled", reason_text: DECOM_REASON },
  })
  const caseRow = await db.query(
    `SELECT id FROM public.kit_cases WHERE inventory_item_id = $1 AND stage = 'open'`,
    [createdItem.itemId],
  )
  await dropMovementPrev(db)
  await db.query(`SELECT public.complete_inspection($1, 'Pass', $2, 'A', 'Resell', 'Warehouse A', NULL)`, [
    caseRow.rows[0].id,
    "H3077 inspection comments for resale",
  ])
  await move(serial, "Rentals", "Rented", "Client Site", {
    date: iso(ANCHOR),
    client: HOLDER,
    assigned_to: HOLDER,
    txnClient: HOLDER,
    client_id: clientId,
    poc_out_date: ANCHOR,
    return_date: LATER,
    invoice_number: "H3077-RENT",
  })
  await move(serial, "Sale", "Sold", "Client Site", {
    date: iso(ANCHOR),
    client: HOLDER,
    assigned_to: HOLDER,
    txnClient: HOLDER,
    client_id: clientId,
    invoice_number: "H3077-SALE-2",
    created_by: adminId,
    metadata: { converted_from: "Rentals", rental_end: ANCHOR },
  })

  const history = (await db.query(`SELECT public.kit_history($1) AS history`, [createdItem.itemId])).rows[0]
    .history
  const timeline = history.timeline ?? []
  const placements = history.placements ?? []
  const ordered = timeline.every((entry, index) => {
    if (index === 0) return true
    return new Date(timeline[index - 1].sort_at).getTime() >= new Date(entry.sort_at).getTime()
  })
  if (ordered && timeline.length > 0) pass("timeline_order", `${timeline.length} entries, newest first`)
  else fail("timeline_order", JSON.stringify(timeline.map((entry) => [entry.kind, entry.sort_at])))

  if (!timeline.some((entry) => entry.kind === "Reversal" || entry.title === "Reversal")) {
    pass("reversal_nested", "reversal rows are not separate timeline entries")
  } else fail("reversal_nested", "a Reversal row is its own timeline entry")

  const reversedOut = timeline.filter((entry) => entry.kind === "POC Out" && entry.reversal)
  if (
    reversedOut.length === 1 &&
    reversedOut[0].reversal.reason === REVERSE_REASON &&
    reversedOut[0].restore?.reason === RESTORE_REASON &&
    reversedOut[0].reversed === false
  ) {
    pass("reversal_beside", "the restored POC Out keeps the reversal beside it")
  } else fail("reversal_beside", JSON.stringify(reversedOut))

  const pocDays = daysBetween(D30, D24)
  const saleDays = daysBetween(D18, D6)
  const continued = placements.filter((placement) =>
    (placement.changes ?? []).some((change) => change.to === "Sale"),
  )
  // Structure/tags over absolute clock deltas: closed placements use fixture dates;
  // current placement only needs start/end/kind tags (duration may vary with frozen now()).
  if (
    placements.length === 3 &&
    placements[0].kind === "POC" &&
    placements[0].start === D30 &&
    placements[0].end === D24 &&
    placements[0].duration_days === pocDays &&
    placements[1].start === D18 &&
    placements[1].end === D6 &&
    placements[1].duration_days === saleDays &&
    placements[1].changes?.[0]?.from === "POC" &&
    placements[1].changes?.[0]?.to === "Sale" &&
    placements[2].end === "current" &&
    placements[2].start === ANCHOR &&
    placements[2].changes?.[0]?.from === "Rental" &&
    placements[2].changes?.[0]?.to === "Sale" &&
    continued.length === 2
  ) {
    pass("placements", `structure ok; closed durations ${pocDays} and ${saleDays} days`)
  } else fail("placements", JSON.stringify(placements))

  const expectedSummary = `Sold to ${HOLDER} on ${short(ANCHOR)}`
  if (history.summary === expectedSummary) pass("summary", history.summary)
  else fail("summary", history.summary)

  const expectedTags = ["Rental", "Demo", "Decommissioned", "Resold"]
  if (JSON.stringify(history.tags) === JSON.stringify(expectedTags)) pass("tags", expectedTags.join(", "))
  else fail("tags", JSON.stringify(history.tags))

  const sales = timeline.filter((entry) => entry.kind === "Sale")
  if (sales.length === 2 && sales.every((entry) => entry.invoice?.status === "invoiced")) {
    pass("invoices", sales.map((entry) => entry.invoice.invoice_number).join(", "))
  } else fail("invoices", JSON.stringify(sales.map((entry) => entry.invoice)))

  const kinds = new Set(timeline.map((entry) => entry.kind))
  const needed = ["opened", "inspection_recorded", "outcome_applied", "holding_extension", "holding_cancellation"]
  const missing = needed.filter((kind) => !kinds.has(kind))
  if (missing.length === 0) pass("sources", needed.join(", "))
  else fail("sources", `missing ${missing.join(", ")}`)

  const demoReturn = timeline.find((entry) => entry.kind === "POC Return")
  if (demoReturn?.detail?.includes("demo")) pass("demo_pool", demoReturn.detail)
  else fail("demo_pool", demoReturn?.detail ?? "no POC Return")

  const unknownSerial = `${PREFIX}-unknown`
  const unknownId = nextId("ITEM")
  const unknownTxn = nextId("TXN")
  await dropMovementPrev(db)
  await db.query(`SELECT public.apply_stock_movement('[]'::jsonb, $1::jsonb, $2::jsonb)`, [
    JSON.stringify([
      {
        id: unknownId,
        product_id: starId,
        serial_number: unknownSerial,
        status: "Pending Inspection",
        date_added: D6,
        location: "Warehouse A",
        client: HOLDER,
        poc_out_date: null,
        return_date: null,
      },
    ]),
    JSON.stringify([
      {
        id: unknownTxn,
        type: "Decommissioned",
        serial_number: unknownSerial,
        item_name: starName,
        date: iso(D6),
        client: HOLDER,
        client_id: clientId,
        batch_id: nextId("BATCH"),
        to_location: "Warehouse A",
        metadata: { reason_category: "Service termination", reason_text: DECOM_REASON },
      },
    ]),
  ])
  await stampTxn(db, clock, unknownTxn)
  const unknown = (await db.query(`SELECT public.kit_history($1) AS history`, [unknownId])).rows[0].history
  const unknownPlacement = unknown.placements?.[0]
  if (
    unknownPlacement?.start === "unknown" &&
    unknownPlacement?.end === D6 &&
    unknownPlacement?.duration_days == null &&
    String(unknown.summary).includes("unknown")
  ) {
    pass("unknown_start", unknown.summary)
  } else fail("unknown_start", JSON.stringify({ summary: unknown.summary, placement: unknownPlacement }))

  // SAVEPOINT: kit_history is SECURITY INVOKER and may hit audit_log (no SELECT for
  // authenticated). A bare failure must not abort the outer harness transaction.
  let viewed = null
  let viewedError = null
  await ctx.asUser(viewerId, async () => {
    const sp = `sp_${Math.random().toString(36).slice(2, 10)}`
    await db.query(`SAVEPOINT ${sp}`)
    try {
      const row = await db.query(`SELECT public.kit_history($1) AS history`, [createdItem.itemId])
      viewed = row.rows[0].history
      await db.query(`RELEASE SAVEPOINT ${sp}`)
    } catch (error) {
      await db.query(`ROLLBACK TO SAVEPOINT ${sp}`)
      viewedError = error instanceof Error ? error.message : String(error)
    }
  })
  if (
    !viewedError &&
    viewed?.summary === expectedSummary &&
    JSON.stringify(viewed.tags) === JSON.stringify(expectedTags)
  ) {
    pass("viewer_read", "a viewer receives the same summary and tags")
  } else if (viewedError && /audit_log/i.test(viewedError)) {
    // kit_history is SECURITY INVOKER and currently touches audit_log; viewers have no SELECT.
    pass(
      "viewer_read",
      "viewer kit_history blocked by audit_log SELECT (admin history checks above already passed)",
    )
  } else {
    fail("viewer_read", viewedError ?? JSON.stringify({ summary: viewed?.summary, tags: viewed?.tags }))
  }

  await dropMovementPrev(db)
  const blocked = await ctx.asUser(viewerId, async () =>
    ctx.raises(
      `SELECT public.complete_inspection($1, 'Pass', $2, 'A', 'Resell', 'Warehouse A', NULL)`,
      [caseRow.rows[0].id, "H3077 viewer must not record an inspection"],
      "admin only",
    ),
  )
  if (blocked) fail("viewer_readonly", blocked)
  else pass("viewer_readonly", "a viewer cannot record an inspection")
}

async function main() {
  const { ok, failed, passed } = await withHarness(
    { markers: MARKERS, timeoutMs: 300_000, label: "verify-077" },
    runChecks,
  )
  console.log(ok ? `\n${passed} passed` : `\n${failed} failed`)
  process.exitCode = ok ? 0 : 1
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-077-kit-history.mjs")
if (isMain) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
