/**
 * RQ1 stock requests model — rollback harness (BEGIN…ROLLBACK, never commits).
 *
 * Usage:
 *   node scripts/rehearse-migration.mjs supabase/migrations/20261009140000_rq1_requests_model.sql scripts/verify-081-rq1-requests.mjs
 *   node scripts/verify-081-rq1-requests.mjs
 */
import { runVerifyCli } from "./verify-harness.mjs"
import { dropMovementPrev, setJwt, stampTxn } from "./verify-harness-fixtures.mjs"

const PREFIX = "H3081"
const ATLAS =
  "https://ai.frampolafrica.com:10801/projects/11111111-1111-1111-1111-111111111111?task=22222222-2222-2222-2222-222222222222"
const ZERO_REASON = "Complimentary kit for a launch partner"
const POOL_REASON = "Harness group move for RQ1 checks"
const REVERSE_REASON = "Harness reversal of an issued request batch"
const CLOSE_REASON = "Client no longer needs the remaining units"
const CHANGE_REASON = "Corrected the invoice number on the request"

let seq = 0
function nextId(kind) {
  seq += 1
  return `${kind}-${PREFIX}-${seq}`
}

/** issue_units names its own batches; collected here so markers can find them after ROLLBACK. */
const ISSUED_BATCHES = []

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
    sql: `SELECT count(*)::int AS n FROM public.batch_invoices
          WHERE batch_id LIKE $1 OR batch_id = ANY ($2::text[])`,
    params: [`BATCH-${PREFIX}%`, ISSUED_BATCHES],
  },
  {
    label: "batch_reversals",
    sql: `SELECT count(*)::int AS n FROM public.batch_reversals WHERE batch_id = ANY ($1::text[])`,
    params: [ISSUED_BATCHES],
  },
  {
    label: "stock_pool_changes",
    sql: `SELECT count(*)::int AS n FROM public.stock_pool_changes WHERE serial_number LIKE $1`,
    params: [`${PREFIX}%`],
  },
  {
    label: "stock_requests",
    sql: `SELECT count(*)::int AS n FROM public.stock_requests WHERE notes LIKE $1 OR client_id LIKE $2`,
    params: [`${PREFIX}%`, `${PREFIX}%`],
  },
  {
    label: "stock_request_events",
    sql: `SELECT count(*)::int AS n FROM public.stock_request_events WHERE payload->>'client_id' LIKE $1`,
    params: [`${PREFIX}%`],
  },
  {
    label: "clients",
    sql: `SELECT count(*)::int AS n FROM public.clients WHERE id LIKE $1`,
    params: [`${PREFIX}%`],
  },
  {
    label: "product_lines",
    sql: `SELECT count(*)::int AS n FROM public.product_lines WHERE id LIKE $1`,
    params: [`${PREFIX}%`],
  },
  {
    label: "users",
    sql: `SELECT count(*)::int AS n FROM auth.users WHERE email LIKE 'harness-081-%@test.local'`,
    params: [],
  },
]

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

export async function runChecks(ctx) {
  const db = ctx.db
  const pass = (name, reason) => ctx.pass(name, reason)
  const fail = (name, reason) => ctx.fail(name, reason)

  const days = await db.query(
    `SELECT to_char(public.stock_request_today(), 'YYYY-MM-DD') AS today,
            to_char(public.stock_request_today() + 14, 'YYYY-MM-DD') AS due`,
  )
  const { today, due } = days.rows[0]
  const dateIso = `${today}T00:00:00.000Z`
  const clock = { tick: 0, baseIso: dateIso }

  // --- Fixtures -------------------------------------------------------------
  const adminA = await ctx.createFixtureUser("admin", "harness-081-admin-a@test.local")
  const adminB = await ctx.createFixtureUser("admin", "harness-081-admin-b@test.local")
  const accounts = await ctx.createFixtureUser("accounts", "harness-081-accounts@test.local")
  const sales = await ctx.createFixtureUser("sales", "harness-081-sales@test.local")
  const tech = await ctx.createFixtureUser("technicians", "harness-081-tech@test.local")

  const clientId = `${PREFIX}-CLIENT`
  await db.query(
    `INSERT INTO public.clients (id, name, company, email) VALUES ($1, $2, $3, $4)`,
    [clientId, `${PREFIX} Client`, `${PREFIX} Company`, "harness-081-client@test.local"],
  )

  const PL = {
    fg: { id: `${PREFIX}-PL-FG`, name: `${PREFIX} FortiGate Harness`, vendor: "Fortinet", key: true },
    ap: { id: `${PREFIX}-PL-AP`, name: `${PREFIX} FortiAP Harness`, vendor: "Fortinet", key: false },
    sl: { id: `${PREFIX}-PL-SL`, name: `${PREFIX} Starlink Harness`, vendor: "Starlink", key: false },
    ot: { id: `${PREFIX}-PL-OT`, name: `${PREFIX} Other Vendor Harness`, vendor: "General", key: false },
  }
  for (const line of Object.values(PL)) {
    await db.query(
      `INSERT INTO public.product_lines (id, product_name, vendor, requires_serial, requires_cloud_key, is_active)
       VALUES ($1, $2, $3, true, $4, true)`,
      [line.id, line.name, line.vendor, line.key],
    )
  }

  const itemIds = new Map()
  async function inbound(serial, line, cloudKey = null) {
    const itemId = nextId("ITEM")
    const txnId = nextId("TXN")
    await setJwt(db, adminA)
    await dropMovementPrev(db)
    await db.query(`SELECT public.apply_stock_movement('[]'::jsonb, $1::jsonb, $2::jsonb)`, [
      JSON.stringify([
        {
          id: itemId,
          product_id: line.id,
          serial_number: serial,
          status: "In Stock",
          date_added: today,
          location: "Warehouse A",
          stock_pool: "sale",
          cloud_key: cloudKey,
        },
      ]),
      JSON.stringify([
        {
          id: txnId,
          type: "Inbound",
          serial_number: serial,
          item_name: line.name,
          date: dateIso,
          client: "Internal",
          batch_id: nextId("BATCH"),
          to_location: "Warehouse A",
        },
      ]),
    ])
    await stampTxn(db, clock, txnId)
    itemIds.set(serial, itemId)
  }

  async function setPool(serial, pool) {
    await setJwt(db, adminA)
    await db.query(`SELECT public.change_stock_pool($1, $2, $3)`, [itemIds.get(serial), pool, POOL_REASON])
  }

  const S = (name) => `${PREFIX}-${name}`
  for (const name of ["SALE-1", "SALE-2", "SALE-3", "SALE-RP", "ZERO-1", "INVK-1", "INVK-2", "CLOSE-1"]) {
    await inbound(S(name), PL.ap)
  }
  // POC Out fixtures are non-Fortinet only (RQ2 forbids mixing Fortinet with other vendors).
  await inbound(S("POC-OK"), PL.ot)
  await inbound(S("POC-OT-SOLD"), PL.ot)
  for (const name of ["RENT-DEMO", "RENT-OK", "POC-RP", "POC-SL-OK"]) await inbound(S(name), PL.sl)
  await inbound(S("FG-1"), PL.fg)
  await inbound(S("FG-2"), PL.fg, `CK-${PREFIX}-PRESET`)
  await inbound(S("OT-1"), PL.ot)

  // Rental pool is Starlink-only. Demo covers non-Starlink “wrong pool” for Sale.
  await setPool(S("SALE-RP"), "demo")
  await setPool(S("POC-RP"), "rental")
  await setPool(S("RENT-DEMO"), "demo")
  await setPool(S("RENT-OK"), "rental")

  // --- Helpers --------------------------------------------------------------
  async function attempt(sql, params = []) {
    const sp = `sp_${Math.random().toString(36).slice(2, 10)}`
    await db.query(`SAVEPOINT ${sp}`)
    try {
      const result = await db.query(sql, params)
      await db.query(`RELEASE SAVEPOINT ${sp}`)
      return { ok: true, rows: result.rows }
    } catch (error) {
      await db.query(`ROLLBACK TO SAVEPOINT ${sp}`)
      return { ok: false, error: message(error) }
    }
  }

  async function raisesAs(userId, sql, params, needle) {
    await setJwt(db, userId)
    return ctx.raises(sql, params, needle)
  }

  function payload(type, label, overrides = {}) {
    return {
      client_id: clientId,
      type,
      atlas_task_url: ATLAS,
      notes: `${PREFIX} ${label}`,
      invoice_choice: "pending",
      ...(type === "Sale" ? {} : { return_date: due }),
      ...overrides,
    }
  }

  async function submit(userId, body) {
    await setJwt(db, userId)
    const result = await attempt(`SELECT public.submit_request($1::jsonb)::text AS id`, [JSON.stringify(body)])
    return result.ok ? { id: result.rows[0].id } : { id: null, error: result.error }
  }

  async function submitRejected(userId, body, needle) {
    return raisesAs(userId, `SELECT public.submit_request($1::jsonb)`, [JSON.stringify(body)], needle)
  }

  async function issue(userId, requestId, scans) {
    await setJwt(db, userId)
    await dropMovementPrev(db)
    const result = await attempt(`SELECT public.issue_units($1::uuid, $2::jsonb) AS result`, [
      requestId,
      JSON.stringify(scans),
    ])
    if (!result.ok) return { ok: false, error: result.error, failures: [], batchId: null }
    const body = result.rows[0].result
    if (body?.ok && body.batch_id) {
      ISSUED_BATCHES.push(body.batch_id)
      const txns = await db.query(`SELECT id FROM public.transactions WHERE batch_id = $1 ORDER BY id`, [
        body.batch_id,
      ])
      await stampTxn(db, clock, ...txns.rows.map((row) => row.id))
    }
    return { ok: Boolean(body?.ok), failures: body?.failures ?? [], batchId: body?.batch_id ?? null, body }
  }

  function reasonFor(failures, serial) {
    return failures.find((entry) => entry.serial === serial)?.reason ?? ""
  }

  async function requestRow(id) {
    const row = await db.query(
      `SELECT id::text, review_state, type, return_date::text, invoice_status, invoice_number,
              invoice_approval, invoice_approved_by::text, not_invoiced_kind,
              reject_reason_code, rejected_by::text, closed_reason
       FROM public.stock_requests WHERE id = $1::uuid`,
      [id],
    )
    return row.rows[0] ?? null
  }

  const seenStatus = new Set()
  async function displayIs(id, expected) {
    const row = await db.query(`SELECT public.request_display_status($1::uuid) AS status`, [id])
    const status = row.rows[0]?.status ?? null
    if (status === expected) seenStatus.add(status)
    return status === expected ? null : `display ${status}, expected ${expected}`
  }

  async function lineIssued(id) {
    const rows = await db.query(
      `SELECT line.product_id, line.quantity_requested AS requested, public.line_issued_count(line) AS issued
       FROM public.stock_request_lines AS line
       WHERE line.request_id = $1::uuid
       ORDER BY line.sort_order, line.id`,
      [id],
    )
    return Object.fromEntries(rows.rows.map((row) => [row.product_id, row]))
  }

  async function requestTxnCount(id) {
    const row = await db.query(`SELECT count(*)::int AS n FROM public.transactions WHERE request_id = $1::uuid`, [id])
    return row.rows[0].n
  }

  async function item(serial) {
    const row = await db.query(
      `SELECT status, location, stock_pool, cloud_key, return_date
       FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
      [serial],
    )
    return row.rows[0] ?? null
  }

  async function batchInvoice(batchId) {
    const row = await db.query(`SELECT * FROM public.batch_invoices WHERE batch_id = $1`, [batchId])
    return row.rows[0] ?? null
  }

  const requests = {}

  // --- 2. Return date rules -------------------------------------------------
  {
    const poc = await submitRejected(
      sales,
      payload("POC Out", "bad poc", { return_date: undefined, lines: [{ product_id: PL.ap.id, quantity: 1 }] }),
      "POC Out needs a return date",
    )
    const rent = await submitRejected(
      sales,
      payload("Rentals", "bad rent", { return_date: undefined, lines: [{ product_id: PL.sl.id, quantity: 1 }] }),
      "Rentals needs a return date",
    )
    if (!poc && !rent) pass("return_date_required", "POC Out and Rentals without a return date are rejected")
    else fail("return_date_required", poc || rent)

    const saleDate = await submitRejected(
      sales,
      payload("Sale", "bad sale", { return_date: due, lines: [{ product_id: PL.ap.id, quantity: 1 }] }),
      "does not take a return date",
    )
    const todayDate = await submitRejected(
      sales,
      payload("POC Out", "bad today", { return_date: today, lines: [{ product_id: PL.ap.id, quantity: 1 }] }),
      "after today",
    )
    if (!saleDate && !todayDate) pass("return_date_rules", "Sale with a return date and a return date of today are rejected")
    else fail("return_date_rules", saleDate || todayDate)
  }

  // --- 3. Atlas link --------------------------------------------------------
  {
    const bad = [
      "https://example.com/projects/11111111-1111-1111-1111-111111111111?task=22222222-2222-2222-2222-222222222222",
      "https://ai.frampolafrica.com:10801/projects/11111111-1111-1111-1111-111111111111",
      "https://ai.frampolafrica.com:9999/my-tasks?task=22222222-2222-2222-2222-222222222222",
      "https://ai.frampolafrica.com:10801/my-tasks?task=not-a-uuid",
      "",
    ]
    const problems = []
    for (const link of bad) {
      const problem = await submitRejected(
        sales,
        payload("Sale", "bad atlas", { atlas_task_url: link, lines: [{ product_id: PL.ap.id, quantity: 1 }] }),
        "Atlas task link",
      )
      if (problem) problems.push(`${link || "(blank)"}: ${problem}`)
    }
    if (problems.length === 0) pass("atlas_link_rejected", `${bad.length} bad or missing Atlas links rejected`)
    else fail("atlas_link_rejected", problems.join(" | "))
  }

  // --- 1. Submit each type --------------------------------------------------
  {
    const sale = await submit(
      sales,
      payload("Sale", "SALE", {
        invoice_choice: "number",
        invoice_number: `${PREFIX}-INV-1`,
        lines: [{ product_id: PL.ap.id, quantity: 2 }],
      }),
    )
    const poc = await submit(
      sales,
      payload("POC Out", "POC", {
        lines: [
          { product_id: PL.ot.id, quantity: 2 },
          { product_id: PL.sl.id, quantity: 1 },
        ],
      }),
    )
    const rent = await submit(sales, payload("Rentals", "RENT", { lines: [{ product_id: PL.sl.id, quantity: 1 }] }))
    requests.sale = sale.id
    requests.poc = poc.id
    requests.rent = rent.id
    const rows = await Promise.all([sale, poc, rent].map((entry) => (entry.id ? requestRow(entry.id) : null)))
    const ok =
      rows.every((row) => row?.review_state === "submitted") &&
      rows[0].type === "Sale" &&
      rows[0].return_date === null &&
      rows[0].invoice_status === "invoiced" &&
      rows[1].type === "POC Out" &&
      rows[1].return_date === due &&
      rows[2].type === "Rentals" &&
      rows[2].return_date === due
    const status = sale.id ? await displayIs(sale.id, "being_reviewed") : "no sale id"
    if (ok && !status) pass("submit_three_types", "Sale, POC Out, and Rentals submitted; Sale has no return date")
    else fail("submit_three_types", JSON.stringify({ errors: [sale.error, poc.error, rent.error], rows, status }))

    const rentAp = await submitRejected(
      sales,
      payload("Rentals", "bad rent ap", { lines: [{ product_id: PL.ap.id, quantity: 1 }] }),
      "Rentals is only for Starlink",
    )
    if (!rentAp) pass("rentals_starlink_only", "a Rentals request with a non-Starlink line is rejected")
    else fail("rentals_starlink_only", rentAp)
  }

  // --- 7 (pool) / 6. Sale: pool rule, partial issue, completion ----------------
  if (requests.sale) {
    const id = requests.sale
    const pool = await issue(adminA, id, [{ serial: S("SALE-RP") }])
    const poolItem = await item(S("SALE-RP"))
    if (
      !pool.ok &&
      reasonFor(pool.failures, S("SALE-RP")).includes("Sale requires a sellable kit") &&
      poolItem?.status === "In Stock" &&
      (await requestTxnCount(id)) === 0
    ) {
      pass("pool_rule_sale", "a demo-group kit cannot be issued on a Sale and nothing is written")
    } else {
      fail("pool_rule_sale", JSON.stringify({ pool, poolItem }))
    }

    const first = await issue(adminA, id, [{ serial: S("SALE-1") }])
    const afterFirst = await lineIssued(id)
    const partialStatus = await displayIs(id, "partially_issued")
    if (first.ok && afterFirst[PL.ap.id]?.issued === 1 && !partialStatus) {
      pass("partial_issue", "1 of 2 issued; display is partially_issued")
    } else {
      fail("partial_issue", JSON.stringify({ first, afterFirst, partialStatus }))
    }

    const second = await issue(adminA, id, [{ serial: S("SALE-2") }])
    const afterSecond = await lineIssued(id)
    const doneStatus = await displayIs(id, "completed")
    const sold = await item(S("SALE-2"))
    const invoice = second.batchId ? await batchInvoice(second.batchId) : null
    if (
      second.ok &&
      afterSecond[PL.ap.id]?.issued === 2 &&
      !doneStatus &&
      sold?.status === "Sold" &&
      invoice?.status === "invoiced" &&
      invoice.invoice_number === `${PREFIX}-INV-1`
    ) {
      pass("issue_completion", "second batch completes the line; invoiced request shows completed")
    } else {
      fail("issue_completion", JSON.stringify({ second, afterSecond, doneStatus, sold, invoice }))
    }

    const over = await issue(adminA, id, [{ serial: S("SALE-3") }])
    if (!over.ok && reasonFor(over.failures, S("SALE-3")).includes("already issued") && (await item(S("SALE-3")))?.status === "In Stock") {
      pass("over_issue_rejected", "a fully issued line refuses another unit")
    } else {
      fail("over_issue_rejected", JSON.stringify(over))
    }
  } else {
    fail("partial_issue", "Sale request was not created")
  }

  // --- 7 / 10. POC Out: failures write nothing --------------------------------
  if (requests.poc) {
    const id = requests.poc
    // Sell one OT unit so "Not in stock" is available against a line on this request.
    await issue(adminA, id, [{ serial: S("POC-OT-SOLD") }])
    const bad = await issue(adminA, id, [
      { serial: S("FG-1") },
      { serial: S("POC-OT-SOLD") },
      { serial: S("NOPE") },
      { serial: S("NOPE") },
      { serial: S("POC-RP") },
    ])
    const reasons = {
      mismatched: reasonFor(bad.failures, S("FG-1")),
      unavailable: reasonFor(bad.failures, S("POC-OT-SOLD")),
      pool: reasonFor(bad.failures, S("POC-RP")),
    }
    const unknown = bad.failures.filter((entry) => entry.serial === S("NOPE")).map((entry) => entry.reason)
    const untouched =
      (await item(S("FG-1")))?.status === "In Stock" &&
      (await item(S("POC-RP")))?.status === "In Stock" &&
      (await item(S("POC-OT-SOLD")))?.status === "POC" &&
      (await requestTxnCount(id)) === 1
    if (
      !bad.ok &&
      bad.failures.length === 5 &&
      reasons.mismatched.includes("is not on this request") &&
      reasons.unavailable.includes("Not in stock") &&
      reasons.pool.includes("POC Out is not allowed from the rental group") &&
      unknown.some((reason) => reason.includes("not in inventory")) &&
      unknown.some((reason) => reason.includes("Scanned more than once")) &&
      untouched
    ) {
      pass("scan_failures_write_nothing", "mismatched product, unavailable, unknown, duplicate, and pool failures all reported; nothing written")
    } else {
      fail("scan_failures_write_nothing", JSON.stringify({ bad, untouched, reasons }))
    }

    const mixed = await issue(adminA, id, [{ serial: S("POC-OK") }, { serial: S("NOPE-2") }])
    const goodItem = await item(S("POC-OK"))
    if (
      !mixed.ok &&
      mixed.failures.length === 1 &&
      mixed.failures[0].serial === S("NOPE-2") &&
      goodItem?.status === "In Stock" &&
      (await requestTxnCount(id)) === 1
    ) {
      pass("mixed_scan_writes_nothing", "one bad serial stops the good serial in the same scan")
    } else {
      fail("mixed_scan_writes_nothing", JSON.stringify({ mixed, goodItem }))
    }

    const good = await issue(adminA, id, [{ serial: S("POC-OK") }, { serial: S("POC-SL-OK") }])
    const out = await item(S("POC-OK"))
    const outSl = await item(S("POC-SL-OK"))
    const status = await displayIs(id, "awaiting_invoice")
    if (
      good.ok &&
      out?.status === "POC" &&
      out.location === "Client Site" &&
      out.return_date === due &&
      outSl?.status === "POC" &&
      !status
    ) {
      pass("poc_issue_ok", "POC Out issued with the request return date; pending invoice shows awaiting_invoice")
    } else {
      fail("poc_issue_ok", JSON.stringify({ good, out, outSl, status }))
    }
  } else {
    fail("scan_failures_write_nothing", "POC Out request was not created")
  }

  // --- 7. Rentals pool rules ------------------------------------------------
  if (requests.rent) {
    const id = requests.rent
    const demo = await issue(adminA, id, [{ serial: S("RENT-DEMO") }])
    const demoItem = await item(S("RENT-DEMO"))
    const good = await issue(adminA, id, [{ serial: S("RENT-OK") }])
    const rented = await item(S("RENT-OK"))
    if (
      !demo.ok &&
      reasonFor(demo.failures, S("RENT-DEMO")).includes("Rentals is not allowed from the demo group") &&
      demoItem?.status === "In Stock" &&
      good.ok &&
      rented?.status === "Rented" &&
      rented.stock_pool === "rental"
    ) {
      pass("rental_pool_rules", "a demo-group kit is refused for Rentals; a rental-group Starlink is rented")
    } else {
      fail("rental_pool_rules", JSON.stringify({ demo, demoItem, good, rented }))
    }
  } else {
    fail("rental_pool_rules", "Rentals request was not created")
  }

  // --- 4. 00000 not invoiced ------------------------------------------------
  {
    const short = await submitRejected(
      adminA,
      payload("Sale", "zero short", {
        invoice_choice: "not_invoiced",
        not_invoiced_reason: "too short",
        not_invoiced_kind: "internal",
        lines: [{ product_id: PL.ap.id, quantity: 1 }],
      }),
      "at least 15 characters",
    )
    const noKind = await submitRejected(
      adminA,
      payload("Sale", "zero nokind", {
        invoice_choice: "not_invoiced",
        not_invoiced_reason: ZERO_REASON,
        lines: [{ product_id: PL.ap.id, quantity: 1 }],
      }),
      "needs a kind",
    )
    if (!short && !noKind) pass("zero_validation", "00000 needs a reason of 15+ characters and a kind")
    else fail("zero_validation", short || noKind)

    const zero = await submit(
      adminA,
      payload("Sale", "ZERO", {
        invoice_choice: "not_invoiced",
        not_invoiced_reason: ZERO_REASON,
        not_invoiced_kind: "complimentary",
        lines: [{ product_id: PL.ap.id, quantity: 1 }],
      }),
    )
    requests.zero = zero.id
    const zeroSales = await submit(
      sales,
      payload("Sale", "ZERO-SALES", {
        invoice_choice: "not_invoiced",
        not_invoiced_reason: ZERO_REASON,
        not_invoiced_kind: "internal",
        lines: [{ product_id: PL.ap.id, quantity: 1 }],
      }),
    )

    if (zero.id) {
      const id = zero.id
      const row = await requestRow(id)
      const status = await displayIs(id, "awaiting_approval")
      if (row?.review_state === "awaiting_approval" && row.invoice_approval === "awaiting" && !status) {
        pass("zero_awaiting_approval", "00000 request starts awaiting_approval")
      } else {
        fail("zero_awaiting_approval", JSON.stringify({ row, status, error: zero.error }))
      }

      const blocked = await issue(adminB, id, [{ serial: S("ZERO-1") }])
      if (!blocked.ok && (blocked.error ?? "").includes("awaiting 00000 approval") && (await item(S("ZERO-1")))?.status === "In Stock") {
        pass("zero_issue_blocked", "issuing is blocked until another admin approves")
      } else {
        fail("zero_issue_blocked", JSON.stringify(blocked))
      }

      const self = await raisesAs(adminA, `SELECT public.approve_not_invoiced($1::uuid)`, [id], "cannot approve a 00000 you requested")
      if (!self) pass("zero_self_approve_denied", "the requesting admin cannot approve their own 00000")
      else fail("zero_self_approve_denied", self)

      const salesApprove = zeroSales.id
        ? await raisesAs(sales, `SELECT public.approve_not_invoiced($1::uuid)`, [zeroSales.id], "Only an admin")
        : `sales 00000 not created: ${zeroSales.error}`
      const accountsApprove = await raisesAs(accounts, `SELECT public.approve_not_invoiced($1::uuid)`, [id], "Only an admin")
      if (!salesApprove && !accountsApprove) pass("zero_non_admin_denied", "the sales requester and accounts cannot approve 00000")
      else fail("zero_non_admin_denied", salesApprove || accountsApprove)

      await setJwt(db, adminB)
      const approved = await attempt(`SELECT public.approve_not_invoiced($1::uuid)`, [id])
      const after = await requestRow(id)
      if (
        approved.ok &&
        after?.review_state === "submitted" &&
        after.invoice_approval === "approved" &&
        after.invoice_approved_by === adminB
      ) {
        pass("zero_approved", "a second admin approves; request returns to submitted")
      } else {
        fail("zero_approved", JSON.stringify({ approved, after }))
      }

      const issued = await issue(adminB, id, [{ serial: S("ZERO-1") }])
      const invoice = issued.batchId ? await batchInvoice(issued.batchId) : null
      const done = await displayIs(id, "completed")
      if (
        issued.ok &&
        invoice?.status === "not_invoiced" &&
        invoice.approval === "approved" &&
        invoice.not_invoiced_kind === "complimentary" &&
        !done
      ) {
        pass("zero_issued_completed", "approved 00000 issues; batch invoice mirrors approved 00000; display completed")
      } else {
        fail("zero_issued_completed", JSON.stringify({ issued, invoice, done }))
      }
    } else {
      fail("zero_awaiting_approval", `00000 request not created: ${zero.error}`)
    }
  }

  // --- 5. Reject → resubmit → cancel ----------------------------------------
  {
    const rej = await submit(sales, payload("Sale", "REJ", { lines: [{ product_id: PL.ap.id, quantity: 1 }] }))
    requests.rej = rej.id
    if (rej.id) {
      const id = rej.id
      const noNote = await raisesAs(adminA, `SELECT public.reject_request($1::uuid, 'other', NULL)`, [id], "Explain the rejection")
      const salesReject = await raisesAs(sales, `SELECT public.reject_request($1::uuid, 'no_atlas_task', NULL)`, [id], "Only an admin")
      await setJwt(db, adminA)
      const rejected = await attempt(`SELECT public.reject_request($1::uuid, 'no_atlas_task', NULL)`, [id])
      const row = await requestRow(id)
      const status = await displayIs(id, "rejected")
      if (
        !noNote &&
        !salesReject &&
        rejected.ok &&
        row?.review_state === "rejected" &&
        row.reject_reason_code === "no_atlas_task" &&
        row.rejected_by === adminA &&
        !status
      ) {
        pass("reject_request", "admin rejects with a reason code; Other needs a note; sales cannot reject")
      } else {
        fail("reject_request", JSON.stringify({ noNote, salesReject, rejected, row, status }))
      }

      const blocked = await issue(adminA, id, [{ serial: S("SALE-3") }])
      if (!blocked.ok && (blocked.error ?? "").includes("was rejected")) pass("rejected_issue_blocked", "a rejected request cannot be issued")
      else fail("rejected_issue_blocked", JSON.stringify(blocked))

      const techResubmit = await raisesAs(
        tech,
        `SELECT public.resubmit_request($1::uuid, $2::jsonb)`,
        [id, JSON.stringify({ notes: `${PREFIX} REJ tech` })],
        "Only the requester",
      )
      if (!techResubmit) pass("resubmit_requester_only", "only the requester can resubmit")
      else fail("resubmit_requester_only", techResubmit)

      await setJwt(db, sales)
      const resubmitted = await attempt(`SELECT public.resubmit_request($1::uuid, $2::jsonb)`, [
        id,
        JSON.stringify({ notes: `${PREFIX} REJ resubmitted`, lines: [{ product_id: PL.ap.id, quantity: 2 }] }),
      ])
      const after = await requestRow(id)
      const lines = await lineIssued(id)
      const sameCount = await db.query(`SELECT count(*)::int AS n FROM public.stock_requests WHERE notes LIKE $1`, [
        `${PREFIX} REJ%`,
      ])
      const reviewing = await displayIs(id, "being_reviewed")
      if (
        resubmitted.ok &&
        after?.id === id &&
        after.review_state === "submitted" &&
        after.reject_reason_code === null &&
        lines[PL.ap.id]?.requested === 2 &&
        sameCount.rows[0].n === 1 &&
        !reviewing
      ) {
        pass("resubmit_same_id", "resubmit keeps the same request id, clears the rejection, and replaces lines")
      } else {
        fail("resubmit_same_id", JSON.stringify({ resubmitted, after, lines, same: sameCount.rows[0].n, reviewing }))
      }

      await setJwt(db, sales)
      const cancelled = await attempt(`SELECT public.cancel_request($1::uuid, $2)`, [id, "Client changed their mind"])
      const cancelRow = await requestRow(id)
      const cancelStatus = await displayIs(id, "cancelled")
      if (cancelled.ok && cancelRow?.review_state === "cancelled" && !cancelStatus) {
        pass("cancel_request", "the requester cancels a request with nothing issued")
      } else {
        fail("cancel_request", JSON.stringify({ cancelled, cancelRow, cancelStatus }))
      }
    } else {
      fail("reject_request", `request not created: ${rej.error}`)
    }
  }

  // --- 8 / 9 / 11. Cloud key, accounts, reversal --------------------------------
  // RQ2: Fortinet and non-Fortinet cannot share a request — split into two.
  {
    const acc = await submit(
      sales,
      payload("Sale", "ACC", {
        invoice_choice: "number",
        invoice_number: `${PREFIX}-INV-2`,
        lines: [{ product_id: PL.fg.id, quantity: 2 }],
      }),
    )
    requests.acc = acc.id
    const otherReq = await submit(
      sales,
      payload("Sale", "ACC-OT", {
        invoice_choice: "number",
        invoice_number: `${PREFIX}-INV-2B`,
        lines: [{ product_id: PL.ot.id, quantity: 1 }],
      }),
    )
    requests.accOt = otherReq.id
    if (acc.id) {
      const id = acc.id
      const noKey = await issue(adminA, id, [{ serial: S("FG-1") }])
      const fgBefore = await item(S("FG-1"))
      if (
        !noKey.ok &&
        reasonFor(noKey.failures, S("FG-1")).includes("Cloud key is required") &&
        fgBefore?.status === "In Stock" &&
        !fgBefore.cloud_key &&
        (await requestTxnCount(id)) === 0
      ) {
        pass("cloud_key_required", "a cloud-key product with no key on the kit or scan is refused")
      } else {
        fail("cloud_key_required", JSON.stringify({ noKey, fgBefore }))
      }

      if (otherReq.id) {
        const accountsOther = await issue(accounts, otherReq.id, [{ serial: S("OT-1") }])
        const otStill = await item(S("OT-1"))
        if (
          !accountsOther.ok &&
          reasonFor(accountsOther.failures, S("OT-1")).includes("Accounts can only issue Fortinet units") &&
          otStill?.status === "In Stock" &&
          (await requestTxnCount(otherReq.id)) === 0
        ) {
          pass("accounts_fortinet_only", "accounts cannot issue a non-Fortinet unit")
        } else {
          fail("accounts_fortinet_only", JSON.stringify({ accountsOther, otStill }))
        }
      } else {
        fail("accounts_fortinet_only", `other request not created: ${otherReq.error}`)
      }

      const withKey = await issue(accounts, id, [{ serial: S("FG-1"), cloud_key: `CK-${PREFIX}-1` }])
      const fgSold = await item(S("FG-1"))
      if (withKey.ok && fgSold?.status === "Sold" && fgSold.cloud_key === `CK-${PREFIX}-1`) {
        pass("cloud_key_saved", "accounts issues a Fortinet unit and the scanned cloud key is saved on the kit")
        pass("accounts_fortinet_issue", "accounts can issue Fortinet lines")
      } else {
        fail("cloud_key_saved", JSON.stringify({ withKey, fgSold }))
        fail("accounts_fortinet_issue", JSON.stringify(withKey))
      }

      const preset = await issue(accounts, id, [{ serial: S("FG-2") }])
      const fg2 = await item(S("FG-2"))
      if (preset.ok && fg2?.status === "Sold" && fg2.cloud_key === `CK-${PREFIX}-PRESET`) {
        pass("cloud_key_existing_ok", "a kit that already has a cloud key needs none at scan")
      } else {
        fail("cloud_key_existing_ok", JSON.stringify({ preset, fg2 }))
      }

      if (otherReq.id) {
        const other = await issue(adminA, otherReq.id, [{ serial: S("OT-1") }])
        const completed = await displayIs(otherReq.id, "completed")
        if (!other.ok || completed) {
          fail("reverse_reopens_line", JSON.stringify({ other, completed }))
        } else {
          await setJwt(db, adminA)
          const reversed = await attempt(
            `SELECT public.reverse_quick_scan_batch($1, $2, NULL, '[]'::jsonb, '[]'::jsonb) AS result`,
            [other.batchId, REVERSE_REASON],
          )
          const lines = await lineIssued(otherReq.id)
          const back = await item(S("OT-1"))
          // Fully reversing the only issued unit returns the request to being_reviewed (0 issued).
          const reopened = await displayIs(otherReq.id, "being_reviewed")
          if (
            reversed.ok &&
            lines[PL.ot.id]?.issued === 0 &&
            back?.status === "In Stock" &&
            !reopened
          ) {
            pass("reverse_reopens_line", "reversing the issue batch drops the issued count and reopens the line")
          } else {
            fail("reverse_reopens_line", JSON.stringify({ reversed, lines, back, reopened }))
          }

          const again = await issue(adminA, otherReq.id, [{ serial: S("OT-1") }])
          const doneAgain = await displayIs(otherReq.id, "completed")
          if (again.ok && !doneAgain) pass("reissue_after_reverse", "the reopened line can be issued again")
          else fail("reissue_after_reverse", JSON.stringify({ again, doneAgain }))
        }
      }
    } else {
      fail("cloud_key_required", `request not created: ${acc.error}`)
    }
  }

  // --- 13. One invoice across two partial batches -------------------------------
  {
    const inv = await submit(sales, payload("Sale", "INV", { lines: [{ product_id: PL.ap.id, quantity: 2 }] }))
    requests.inv = inv.id
    if (inv.id) {
      const id = inv.id
      const b1 = await issue(adminA, id, [{ serial: S("INVK-1") }])
      const b2 = await issue(adminA, id, [{ serial: S("INVK-2") }])
      const awaiting = await displayIs(id, "awaiting_invoice")
      const pendingRows = [b1.batchId && (await batchInvoice(b1.batchId)), b2.batchId && (await batchInvoice(b2.batchId))]

      await setJwt(db, sales)
      const set = await attempt(`SELECT public.set_request_invoice($1::uuid, 'number', $2, NULL, NULL)`, [
        id,
        `${PREFIX}-INV-3`,
      ])
      const rows = [await batchInvoice(b1.batchId), await batchInvoice(b2.batchId)]
      const txns = await db.query(
        `SELECT DISTINCT invoice_number FROM public.transactions WHERE batch_id = ANY ($1::text[]) AND type = 'Sale'`,
        [[b1.batchId, b2.batchId]],
      )
      const done = await displayIs(id, "completed")
      if (
        b1.ok &&
        b2.ok &&
        b1.batchId !== b2.batchId &&
        !awaiting &&
        pendingRows.every((row) => row?.status === "pending") &&
        set.ok &&
        rows.every((row) => row?.status === "invoiced" && row.invoice_number === `${PREFIX}-INV-3`) &&
        txns.rows.length === 1 &&
        txns.rows[0].invoice_number === `${PREFIX}-INV-3` &&
        !done
      ) {
        pass("invoice_two_batches", "one set_request_invoice invoices both partial batches; display completed")
      } else {
        fail("invoice_two_batches", JSON.stringify({ b1, b2, awaiting, pendingRows, set, rows, txns: txns.rows, done }))
      }

      const salesChange = await raisesAs(
        sales,
        `SELECT public.set_request_invoice($1::uuid, 'number', $2, $3, NULL)`,
        [id, `${PREFIX}-INV-4`, CHANGE_REASON],
        "Only admin or accounts",
      )
      const shortChange = await raisesAs(
        accounts,
        `SELECT public.set_request_invoice($1::uuid, 'number', $2, 'too short', NULL)`,
        [id, `${PREFIX}-INV-4`],
        "at least 15 characters",
      )
      await setJwt(db, accounts)
      const changed = await attempt(`SELECT public.set_request_invoice($1::uuid, 'number', $2, $3, NULL)`, [
        id,
        `${PREFIX}-INV-4`,
        CHANGE_REASON,
      ])
      const changedRows = [await batchInvoice(b1.batchId), await batchInvoice(b2.batchId)]
      if (
        !salesChange &&
        !shortChange &&
        changed.ok &&
        changedRows.every((row) => row?.invoice_number === `${PREFIX}-INV-4`)
      ) {
        pass("invoice_change_needs_reason", "after entry only admin/accounts change it, with a reason; both batches follow")
      } else {
        fail("invoice_change_needs_reason", JSON.stringify({ salesChange, shortChange, changed, changedRows }))
      }

      const locked = await raisesAs(
        accounts,
        `SELECT public.set_batch_invoice($1, 'number', $2, $3, NULL)`,
        [b1.batchId, `${PREFIX}-INV-5`, CHANGE_REASON],
        "issued from a stock request",
      )
      if (!locked) pass("batch_invoice_request_locked", "set_batch_invoice refuses a request-linked batch")
      else fail("batch_invoice_request_locked", locked)
    } else {
      fail("invoice_two_batches", `request not created: ${inv.error}`)
    }
  }

  // --- Close outstanding ------------------------------------------------------
  {
    const close = await submit(sales, payload("Sale", "CLOSE", { lines: [{ product_id: PL.ap.id, quantity: 2 }] }))
    requests.close = close.id
    if (close.id) {
      const id = close.id
      const issued = await issue(adminA, id, [{ serial: S("CLOSE-1") }])
      const salesClose = await raisesAs(sales, `SELECT public.close_outstanding($1::uuid, $2)`, [id, CLOSE_REASON], "Only an admin")
      const shortClose = await raisesAs(adminA, `SELECT public.close_outstanding($1::uuid, 'short')`, [id], "at least 15 characters")
      await setJwt(db, adminA)
      const closed = await attempt(`SELECT public.close_outstanding($1::uuid, $2)`, [id, CLOSE_REASON])
      const row = await requestRow(id)
      const status = await displayIs(id, "closed")
      const after = await issue(adminA, id, [{ serial: S("SALE-3") }])
      if (
        issued.ok &&
        !salesClose &&
        !shortClose &&
        closed.ok &&
        row?.review_state === "closed" &&
        row.closed_reason === CLOSE_REASON &&
        !status &&
        !after.ok &&
        (after.error ?? "").includes("is closed")
      ) {
        pass("close_outstanding", "admin closes outstanding units with a reason; a closed request cannot be issued")
      } else {
        fail("close_outstanding", JSON.stringify({ issued, salesClose, shortClose, closed, row, status, after }))
      }
    } else {
      fail("close_outstanding", `request not created: ${close.error}`)
    }
  }

  // --- 12. Display status for every state ------------------------------------
  {
    const all = [
      "being_reviewed",
      "awaiting_approval",
      "rejected",
      "partially_issued",
      "awaiting_invoice",
      "completed",
      "cancelled",
      "closed",
    ]
    const missing = all.filter((status) => !seenStatus.has(status))
    if (missing.length === 0) pass("display_status_all", `observed ${all.join(", ")}`)
    else fail("display_status_all", `never observed: ${missing.join(", ")}`)
  }

  // --- 14. Events for every action ---------------------------------------------
  {
    async function eventCounts(id) {
      if (!id) return {}
      const rows = await db.query(
        `SELECT event_type, count(*)::int AS n FROM public.stock_request_events WHERE request_id = $1::uuid GROUP BY event_type`,
        [id],
      )
      return Object.fromEntries(rows.rows.map((row) => [row.event_type, row.n]))
    }
    const expected = {
      sale: { submitted: 1, units_issued: 2 },
      // POC: one issue for the sold fixture unit, then the successful 2-serial issue.
      poc: { submitted: 1, units_issued: 2 },
      rent: { submitted: 1, units_issued: 1 },
      zero: { submitted: 1, not_invoiced_approved: 1, units_issued: 1 },
      rej: { submitted: 1, rejected: 1, resubmitted: 1, cancelled: 1 },
      acc: { submitted: 1, units_issued: 2 },
      inv: { submitted: 1, units_issued: 2, invoice_set: 2 },
      close: { submitted: 1, units_issued: 1, closed_outstanding: 1 },
    }
    const problems = []
    for (const [key, want] of Object.entries(expected)) {
      const got = await eventCounts(requests[key])
      const keys = new Set([...Object.keys(want), ...Object.keys(got)])
      for (const type of keys) {
        if ((got[type] ?? 0) !== (want[type] ?? 0)) problems.push(`${key}.${type} ${got[type] ?? 0}≠${want[type] ?? 0}`)
      }
    }
    const actors = requests.zero && requests.rej
      ? await db.query(
          `SELECT event_type, actor_id::text AS actor FROM public.stock_request_events
           WHERE (request_id = $1::uuid AND event_type = 'not_invoiced_approved')
              OR (request_id = $2::uuid AND event_type = 'rejected')`,
          [requests.zero, requests.rej],
        )
      : { rows: [] }
    const actorOf = Object.fromEntries(actors.rows.map((row) => [row.event_type, row.actor]))
    if (actorOf.not_invoiced_approved !== adminB) problems.push("approval actor is not admin B")
    if (actorOf.rejected !== adminA) problems.push("reject actor is not admin A")
    if (problems.length === 0) pass("events_logged", "every request action wrote exactly one event with the acting user")
    else fail("events_logged", problems.join("; "))

    const poc = await eventCounts(requests.poc)
    const acc = await eventCounts(requests.acc)
    // Successful POC issues only (failed scans must not add units_issued).
    if (poc.units_issued === 2 && acc.units_issued === 2) {
      pass("failed_issue_no_event", "failed scans wrote no units_issued event")
    } else {
      fail("failed_issue_no_event", JSON.stringify({ poc, acc }))
    }
  }
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-081-rq1-requests.mjs")
if (isMain) {
  runVerifyCli({ markers: MARKERS, timeoutMs: 300_000, label: "verify-081" }, runChecks)
}
