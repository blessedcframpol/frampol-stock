/**
 * Returns report — rollback harness (BEGIN…ROLLBACK, never commits).
 * Fixture dates use explicit DATE constants (not wall-clock "today").
 *
 * Usage: node scripts/verify-078-returns-report.mjs
 */
import { withHarness } from "./verify-harness.mjs"
import { dropMovementPrev, setJwt } from "./verify-harness-fixtures.mjs"

const PREFIX = "H3078"
const SITE = "Borrowdale"
const SITE_CLIENT = "H3 Borrowdale - H3 Site"
const NONE_CLIENT = "H3 Nowhere - H3 None"
const REASON_CONTRACT = "H3 client ended the contract"
const REASON_MOVED = "H3 moved offices"
const REASON_NONE = "H3 no address given"
const REASON_SIGNAL = "H3 signal lost"
const REASON_RENTAL = "H3 rental ended"
const REASON_EDGE = "H3 on the first day"
const REASON_OUTSIDE = "H3 outside the window"
const COMMENTS = "H3 inspection comments"

let seq = 0
function nextId(kind) {
  seq += 1
  return `${kind}-${PREFIX}-${seq}`
}

function iso(day) {
  return `${day}T00:00:00.000Z`
}

function addDays(day, delta) {
  const ms = Date.parse(`${day}T00:00:00.000Z`) + delta * 86400000
  return new Date(ms).toISOString().slice(0, 10)
}

function flatten(report) {
  const out = {}
  for (const row of report.now.waiting) out[`wait:${row.type}`] = row.units
  out.oldest = report.now.oldest_wait_days
  out.rental_out = report.now.rental_out
  for (const category of report.returns) {
    out[`return:${category.category}`] = category.units
    for (const reason of category.reasons ?? []) out[`reason:${category.category}:${reason.text}`] = reason.units
  }
  for (const row of report.outcomes) {
    out[`outcome:${row.outcome}:starlink`] = row.starlink
    out[`outcome:${row.outcome}:other`] = row.other
  }
  for (const row of report.results) out[`result:${row.result}`] = row.units
  for (const row of report.grades) out[`grade:${row.grade}`] = row.units
  for (const row of report.sites) out[`site:${row.site}`] = row.units
  return out
}

function periodDelta(before, after, expected) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(expected)])
  const misses = []
  for (const key of keys) {
    if (key.startsWith("wait:") || key === "oldest" || key === "rental_out") continue
    const delta = (after[key] ?? 0) - (before[key] ?? 0)
    const want = expected[key] ?? 0
    if (delta !== want) misses.push(`${key} ${delta} wanted ${want}`)
  }
  return misses
}

function daysBetween(start, end) {
  const ms = Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)
  return Math.round(ms / 86400000)
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
    sql: `SELECT count(*)::int AS n FROM public.kit_cases WHERE inventory_item_id LIKE $1`,
    params: [`ITEM-${PREFIX}%`],
  },
  {
    label: "clients",
    sql: `SELECT count(*)::int AS n FROM public.clients WHERE id LIKE $1`,
    params: [`CLT-${PREFIX}%`],
  },
  {
    label: "users",
    sql: `SELECT count(*)::int AS n FROM auth.users WHERE email LIKE 'harness-078-%@test.local'`,
    params: [],
  },
]

export async function runChecks(ctx) {
  const db = ctx.db
  const pass = (name, reason) => ctx.pass(name, reason)
  const fail = (name, reason) => ctx.fail(name, reason)

  const star = await db.query(
    `SELECT id, product_name FROM public.product_lines WHERE vendor = 'Starlink' AND is_active ORDER BY id LIMIT 1`,
  )
  const other = await db.query(
    `SELECT id, product_name FROM public.product_lines WHERE vendor IS DISTINCT FROM 'Starlink' AND is_active ORDER BY id LIMIT 1`,
  )
  if (!star.rows[0] || !other.rows[0]) throw new Error("need Starlink and non-Starlink product lines")
  const starId = star.rows[0].id
  const starName = star.rows[0].product_name
  const otherId = other.rows[0].id
  const otherName = other.rows[0].product_name
  const siteClientId = `CLT-${PREFIX}-SITE`
  const noneClientId = `CLT-${PREFIX}-NONE`

  const adminId = await ctx.createFixtureUser("admin", "harness-078-admin@test.local")
  const viewerId = await ctx.createFixtureUser("viewer", "harness-078-viewer@test.local")
  const salesId = await ctx.createFixtureUser("sales", "harness-078-sales@test.local")
  await db.query(
    `INSERT INTO public.clients (id, name, company, email, address, sites)
     VALUES
       ($1, 'H3 Borrowdale', 'H3 Site', 'h3078-site@test.local', $3, $4::jsonb),
       ($2, 'H3 Nowhere', 'H3 None', 'h3078-none@test.local', NULL, NULL)`,
    [siteClientId, noneClientId, SITE, JSON.stringify([{ address: SITE }])],
  )
  await setJwt(db, adminId)

  // Window relative to harness now() so fixtures opened today stay inside p_to.
  const ANCHOR = (
    await db.query(`SELECT to_char((now() AT TIME ZONE 'Africa/Harare')::date, 'YYYY-MM-DD') AS d`)
  ).rows[0].d
  const EDGE = addDays(ANCHOR, -90)
  const GAP = addDays(ANCHOR, -91)
  const OUTSIDE = addDays(ANCHOR, -120)
  const LATER = addDays(ANCHOR, 20)

  const invoker = await db.query(
    `SELECT prosecdef FROM pg_proc
     WHERE proname = 'returns_report' AND pg_get_function_identity_arguments(oid) = 'p_from date, p_to date'`,
  )
  if (invoker.rows[0]?.prosecdef === false) pass("security_invoker", "returns_report runs as the caller")
  else fail("security_invoker", JSON.stringify(invoker.rows))

  async function decommission(serial, productId, productName, clientId, clientLabel, category, reason) {
    const itemId = nextId("ITEM")
    await dropMovementPrev(db)
    await db.query(`SELECT public.apply_stock_movement('[]'::jsonb, $1::jsonb, $2::jsonb)`, [
      JSON.stringify([
        {
          id: itemId,
          product_id: productId,
          serial_number: serial,
          status: "Pending Inspection",
          date_added: ANCHOR,
          location: "Warehouse A",
          client: clientLabel,
          poc_out_date: null,
          return_date: null,
        },
      ]),
      JSON.stringify([
        {
          id: nextId("TXN"),
          type: "Decommissioned",
          serial_number: serial,
          item_name: productName,
          date: iso(ANCHOR),
          client: clientLabel,
          client_id: clientId,
          batch_id: nextId("BATCH"),
          to_location: "Warehouse A",
          metadata: { reason_category: category, reason_text: reason },
        },
      ]),
    ])
    const caseRow = await db.query(
      `SELECT id FROM public.kit_cases WHERE inventory_item_id = $1 AND stage = 'open'`,
      [itemId],
    )
    return { itemId, caseId: caseRow.rows[0].id }
  }

  async function inspect(caseId, result, grade, outcome, location) {
    await dropMovementPrev(db)
    await db.query(`SELECT public.complete_inspection($1, $2, $3, $4, $5, $6, NULL)`, [
      caseId,
      result,
      COMMENTS,
      grade,
      outcome,
      location,
    ])
  }

  /** Opened_at only — kit_case_events are append-only, so event times use insert-at below. */
  async function backdateOpened(caseId, day) {
    await db.query(
      `UPDATE public.kit_cases
       SET opened_at = ($2::timestamp AT TIME ZONE 'Africa/Harare')
       WHERE id = $1`,
      [caseId, `${day} 12:00:00`],
    )
  }

  /**
   * Close a case on an explicit calendar day via the normal INSERT path for
   * kit_case_events (explicit at) — no trigger disable.
   */
  async function inspectOnDay(caseId, result, grade, outcome, location, day) {
    const caseRow = await db.query(`SELECT * FROM public.kit_cases WHERE id = $1`, [caseId])
    const kase = caseRow.rows[0]
    const itemRow = await db.query(
      `SELECT item.*, line.vendor, line.product_name
       FROM public.inventory_items AS item
       JOIN public.product_lines AS line ON line.id = item.product_id
       WHERE item.id = $1 AND item.deleted_at IS NULL`,
      [kase.inventory_item_id],
    )
    const item = itemRow.rows[0]
    let move = "Inspection Pass"
    let status = "In Stock"
    let pool = null
    let client = item.client
    let assigned = item.assigned_to
    let loc = item.location
    let poc = item.poc_out_date
    let ret = item.return_date
    if (outcome === "Resell") {
      pool = "sale"
      client = null
      assigned = null
      poc = null
      ret = null
      loc = location
    } else if (outcome === "Rent out") {
      pool = "rental"
      client = null
      assigned = null
      poc = null
      ret = null
      loc = location
    } else if (outcome === "Dispose") {
      move = "Dispose"
      status = "Disposed"
    } else {
      move = "Inspection Fail"
      status = "RMA Hold"
    }
    const at = `${day} 12:00:00`
    const txnId = nextId("TXN")
    const batchId = nextId("BATCH")
    await dropMovementPrev(db)
    await db.query(`SELECT set_config('app.inspection_case', $1, true)`, [caseId])
    await db.query(`SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`, [
      JSON.stringify([
        {
          id: item.id,
          product_id: item.product_id,
          serial_number: item.serial_number,
          status,
          date_added: item.date_added,
          location: loc,
          client,
          notes: item.notes,
          assigned_to: assigned,
          purchase_date: item.purchase_date,
          warranty_end_date: item.warranty_end_date,
          poc_out_date: poc,
          return_date: ret,
          assignment_history: item.assignment_history ?? [],
          reserved_for_request_line_id: item.reserved_for_request_line_id,
          cloud_key: item.cloud_key,
          deleted_at: null,
        },
      ]),
      JSON.stringify([
        {
          id: txnId,
          type: move,
          serial_number: item.serial_number,
          item_name: item.product_name,
          date: iso(day),
          client: client ?? "Internal",
          client_id: kase.client_id,
          notes: COMMENTS,
          batch_id: batchId,
          to_location: loc,
          created_by: null,
          metadata: { case_id: caseId, result, grade, outcome, comments: COMMENTS },
          inspection_pool: pool,
        },
      ]),
    ])
    await db.query(`SELECT set_config('app.inspection_case', '', true)`)
    await db.query(
      `INSERT INTO public.kit_case_events (case_id, event_type, actor, at, payload)
       VALUES
         ($1, 'inspection_recorded', auth.uid(), ($2::timestamp AT TIME ZONE 'Africa/Harare'), $3::jsonb),
         ($1, 'outcome_applied', auth.uid(), ($2::timestamp AT TIME ZONE 'Africa/Harare'), $4::jsonb)`,
      [
        caseId,
        at,
        JSON.stringify({ result, comments: COMMENTS, grade }),
        JSON.stringify({
          outcome,
          transaction_id: txnId,
          batch_id: batchId,
          status,
          stock_pool: pool ?? item.stock_pool,
        }),
      ],
    )
    await db.query(
      `UPDATE public.kit_cases
       SET stage = 'closed',
           outcome = $2,
           opened_at = ($3::timestamp AT TIME ZONE 'Africa/Harare'),
           closed_at = ($3::timestamp AT TIME ZONE 'Africa/Harare'),
           closed_by = auth.uid()
       WHERE id = $1`,
      [caseId, outcome, at],
    )
  }

  async function report(from, to) {
    const row = await db.query(`SELECT public.returns_report($1::date, $2::date) AS report`, [from, to])
    return row.rows[0].report
  }

  const beforeRange = flatten(await report(EDGE, ANCHOR))
  const beforeOutside = flatten(await report(OUTSIDE, OUTSIDE))
  const beforeGap = flatten(await report(GAP, GAP))

  const openToday = await decommission(
    `${PREFIX}-open`,
    starId,
    starName,
    siteClientId,
    SITE_CLIENT,
    "Client cancelled",
    REASON_CONTRACT,
  )
  const resell = await decommission(
    `${PREFIX}-resell`,
    starId,
    starName,
    siteClientId,
    SITE_CLIENT,
    "Client cancelled",
    REASON_CONTRACT,
  )
  await inspect(resell.caseId, "Pass", "A", "Resell", "Warehouse A")
  const rentOut = await decommission(
    `${PREFIX}-rentout`,
    starId,
    starName,
    siteClientId,
    SITE_CLIENT,
    "Client cancelled",
    REASON_MOVED,
  )
  await inspect(rentOut.caseId, "Pass", "B", "Rent out", "Warehouse A")
  const dispose = await decommission(
    `${PREFIX}-dispose`,
    otherId,
    otherName,
    noneClientId,
    NONE_CLIENT,
    "Client cancelled",
    REASON_NONE,
  )
  await inspect(dispose.caseId, "Pass", "C", "Dispose", null)
  const failed = await decommission(
    `${PREFIX}-fail`,
    starId,
    starName,
    siteClientId,
    SITE_CLIENT,
    "Service termination",
    REASON_SIGNAL,
  )
  await inspect(failed.caseId, "Fail", "A", "Return to vendor", null)
  const edgeCase = await decommission(
    `${PREFIX}-edge`,
    starId,
    starName,
    siteClientId,
    SITE_CLIENT,
    "Client cancelled",
    REASON_EDGE,
  )
  await backdateOpened(edgeCase.caseId, EDGE)
  const outsideCase = await decommission(
    `${PREFIX}-out`,
    otherId,
    otherName,
    siteClientId,
    SITE_CLIENT,
    "Client cancelled",
    REASON_OUTSIDE,
  )
  await inspectOnDay(outsideCase.caseId, "Pass", "A", "Resell", "Warehouse A", OUTSIDE)

  const rentalSerial = `${PREFIX}-rented`
  const rentalItem = nextId("ITEM")
  await dropMovementPrev(db)
  await db.query(`SELECT public.apply_stock_movement('[]'::jsonb, $1::jsonb, $2::jsonb)`, [
    JSON.stringify([
      {
        id: rentalItem,
        product_id: starId,
        serial_number: rentalSerial,
        status: "In Stock",
        date_added: ANCHOR,
        location: "Warehouse A",
      },
    ]),
    JSON.stringify([
      {
        id: nextId("TXN"),
        type: "Inbound",
        serial_number: rentalSerial,
        item_name: starName,
        date: iso(ANCHOR),
        client: "Internal",
        batch_id: nextId("BATCH"),
        to_location: "Warehouse A",
      },
    ]),
  ])
  await dropMovementPrev(db)
  await db.query(`SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`, [
    JSON.stringify([
      {
        id: rentalItem,
        product_id: starId,
        serial_number: rentalSerial,
        status: "Rented",
        date_added: ANCHOR,
        location: "Client Site",
        client: SITE_CLIENT,
        assigned_to: SITE_CLIENT,
        poc_out_date: ANCHOR,
        return_date: LATER,
      },
    ]),
    JSON.stringify([
      {
        id: nextId("TXN"),
        type: "Rentals",
        serial_number: rentalSerial,
        item_name: starName,
        date: iso(ANCHOR),
        client: SITE_CLIENT,
        client_id: siteClientId,
        batch_id: nextId("BATCH"),
        to_location: "Client Site",
      },
    ]),
  ])

  const returnedSerial = `${PREFIX}-returned`
  const returnedItem = nextId("ITEM")
  await dropMovementPrev(db)
  await db.query(`SELECT public.apply_stock_movement('[]'::jsonb, $1::jsonb, $2::jsonb)`, [
    JSON.stringify([
      {
        id: returnedItem,
        product_id: starId,
        serial_number: returnedSerial,
        status: "In Stock",
        date_added: ANCHOR,
        location: "Warehouse A",
      },
    ]),
    JSON.stringify([
      {
        id: nextId("TXN"),
        type: "Inbound",
        serial_number: returnedSerial,
        item_name: starName,
        date: iso(ANCHOR),
        client: "Internal",
        batch_id: nextId("BATCH"),
        to_location: "Warehouse A",
      },
    ]),
  ])
  await dropMovementPrev(db)
  await db.query(`SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`, [
    JSON.stringify([
      {
        id: returnedItem,
        product_id: starId,
        serial_number: returnedSerial,
        status: "Rented",
        date_added: ANCHOR,
        location: "Client Site",
        client: SITE_CLIENT,
        assigned_to: SITE_CLIENT,
        poc_out_date: ANCHOR,
        return_date: LATER,
      },
    ]),
    JSON.stringify([
      {
        id: nextId("TXN"),
        type: "Rentals",
        serial_number: returnedSerial,
        item_name: starName,
        date: iso(ANCHOR),
        client: SITE_CLIENT,
        client_id: siteClientId,
        batch_id: nextId("BATCH"),
        to_location: "Client Site",
      },
    ]),
  ])
  await dropMovementPrev(db)
  await db.query(`SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`, [
    JSON.stringify([
      {
        id: returnedItem,
        product_id: starId,
        serial_number: returnedSerial,
        status: "Pending Inspection",
        date_added: ANCHOR,
        location: "Warehouse A",
        client: SITE_CLIENT,
      },
    ]),
    JSON.stringify([
      {
        id: nextId("TXN"),
        type: "Rental Return",
        serial_number: returnedSerial,
        item_name: starName,
        date: iso(ANCHOR),
        client: SITE_CLIENT,
        client_id: siteClientId,
        batch_id: nextId("BATCH"),
        to_location: "Warehouse A",
        metadata: { reason_category: "Service termination", reason_text: REASON_RENTAL },
      },
    ]),
  ])

  const range = flatten(await report(EDGE, ANCHOR))
  const outsideReport = flatten(await report(OUTSIDE, OUTSIDE))
  const gapReport = flatten(await report(GAP, GAP))

  const rangeMisses = periodDelta(beforeRange, range, {
    "return:Client cancelled": 5,
    "return:Service termination": 2,
    [`reason:Client cancelled:${REASON_CONTRACT}`]: 2,
    [`reason:Client cancelled:${REASON_MOVED}`]: 1,
    [`reason:Client cancelled:${REASON_NONE}`]: 1,
    [`reason:Client cancelled:${REASON_EDGE}`]: 1,
    [`reason:Service termination:${REASON_SIGNAL}`]: 1,
    [`reason:Service termination:${REASON_RENTAL}`]: 1,
    "outcome:Resell:starlink": 1,
    "outcome:Rent out:starlink": 1,
    "outcome:Dispose:other": 1,
    "outcome:Return to vendor:starlink": 1,
    "result:Pass": 3,
    "result:Fail": 1,
    "grade:A": 2,
    "grade:B": 1,
    "grade:C": 1,
    [`site:${SITE}`]: 4,
    "site:No site": 1,
  })
  if (rangeMisses.length === 0) pass("range_counts", "returns, outcomes, grades, and sites match the 90-day window")
  else fail("range_counts", rangeMisses.join("; "))

  const outsideMisses = periodDelta(beforeOutside, outsideReport, {
    "return:Client cancelled": 1,
    [`reason:Client cancelled:${REASON_OUTSIDE}`]: 1,
    "outcome:Resell:other": 1,
    "result:Pass": 1,
    "grade:A": 1,
    [`site:${SITE}`]: 1,
  })
  if (outsideMisses.length === 0) pass("outside_range", "the backdated case is counted only on its own day")
  else fail("outside_range", outsideMisses.join("; "))

  const gapMisses = periodDelta(beforeGap, gapReport, {})
  if (gapMisses.length === 0) pass("date_filter", "the day before the window has no fixture counts")
  else fail("date_filter", gapMisses.join("; "))

  const nowSame =
    range["wait:Decommissioned"] === outsideReport["wait:Decommissioned"] &&
    range["wait:Rental return"] === outsideReport["wait:Rental return"] &&
    range.rental_out === outsideReport.rental_out &&
    range.oldest === outsideReport.oldest
  const waitDecom = range["wait:Decommissioned"] - (beforeRange["wait:Decommissioned"] ?? 0)
  const waitRental = range["wait:Rental return"] - (beforeRange["wait:Rental return"] ?? 0)
  const rentalDelta = range.rental_out - beforeRange.rental_out
  // oldest_wait_days uses now(); compute expected age from EDGE vs frozen harness now().
  const nowDay = (
    await db.query(`SELECT to_char((now() AT TIME ZONE 'Africa/Harare')::date, 'YYYY-MM-DD') AS d`)
  ).rows[0].d
  const edgeAge = daysBetween(EDGE, nowDay)
  const oldestOk = range.oldest === Math.max(beforeRange.oldest ?? 0, edgeAge)
  if (nowSame && waitDecom === 2 && waitRental === 1 && rentalDelta === 1 && oldestOk) {
    pass("now", `waiting +2 decommissioned, +1 rental return, rental out +1, oldest ${range.oldest} days`)
  } else {
    fail(
      "now",
      JSON.stringify({
        nowSame,
        waitDecom,
        waitRental,
        rentalDelta,
        oldest: range.oldest,
        before: beforeRange.oldest,
        edgeAge,
      }),
    )
  }

  if (openToday.caseId) pass("open_case", "one decommission stays open for the waiting count")

  const viewed = await ctx.asUser(viewerId, async () => flatten(await report(EDGE, ANCHOR)))
  if (JSON.stringify(viewed) === JSON.stringify(range)) pass("viewer_read", "a viewer receives the same report")
  else fail("viewer_read", "viewer report differs from the admin report")

  const blocked = await ctx.asUser(viewerId, async () =>
    ctx.raises(
      `SELECT public.complete_inspection($1, 'Pass', $2, 'A', 'Resell', 'Warehouse A', NULL)`,
      [openToday.caseId, COMMENTS],
      "admin only",
    ),
  )
  if (blocked) fail("viewer_readonly", blocked)
  else pass("viewer_readonly", "a viewer cannot record an inspection")

  const denied = await ctx.asUser(salesId, async () =>
    ctx.raises(`SELECT public.returns_report($1::date, $2::date)`, [EDGE, ANCHOR], "not allowed"),
  )
  if (denied) fail("sales_hidden", denied)
  else pass("sales_hidden", "sales cannot read the returns report")
}

async function main() {
  const { ok, failed, passed } = await withHarness(
    { markers: MARKERS, timeoutMs: 300_000, label: "verify-078" },
    runChecks,
  )
  console.log(ok ? `\n${passed} passed` : `\n${failed} failed`)
  process.exitCode = ok ? 0 : 1
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-078-returns-report.mjs")
if (isMain) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
