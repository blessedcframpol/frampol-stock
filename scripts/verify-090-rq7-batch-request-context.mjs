/**
 * RQ7 — batch_request_context links issued batches to request number / requester / Atlas.
 *
 *   node scripts/rehearse-migration.mjs supabase/migrations/20261013072919_rq7_batch_request_context.sql scripts/verify-090-rq7-batch-request-context.mjs
 *   (After RQ7c on the target DB, context uses batch_request_context_for — run verify-092 for lockdown.)
 *   node scripts/verify-090-rq7-batch-request-context.mjs
 */
import { runVerifyCli } from "./verify-harness.mjs"
import {
  dropMovementPrev,
  insertHarnessClient,
  resetHarnessSession,
  setJwt,
  stampTxn,
} from "./verify-harness-fixtures.mjs"

const PREFIX = "H3090"
const NOTES = "harness-090"
const EMAIL = "harness-090-"
const TASK = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
const MY_TASKS = `https://ai.frampolafrica.com:10801/my-tasks?view=all&task=${TASK}`

export const MARKERS = [
  {
    label: "stock_requests",
    sql: `SELECT count(*)::int AS n FROM public.stock_requests WHERE notes LIKE $1`,
    params: [`${NOTES}%`],
  },
  {
    label: "items",
    sql: `SELECT count(*)::int AS n FROM public.inventory_items WHERE serial_number LIKE $1`,
    params: [`${PREFIX}%`],
  },
  {
    label: "transactions",
    sql: `SELECT count(*)::int AS n FROM public.transactions WHERE serial_number LIKE $1 OR id LIKE $1 OR batch_id LIKE $1`,
    params: [`%${PREFIX}%`],
  },
  {
    label: "clients",
    sql: `SELECT count(*)::int AS n FROM public.clients WHERE id LIKE $1`,
    params: [`CLT-${NOTES}%`],
  },
  {
    label: "users",
    sql: `SELECT count(*)::int AS n FROM auth.users WHERE email LIKE $1`,
    params: [`${EMAIL}%`],
  },
]

function stamp() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

export async function runChecks(ctx) {
  const { db, pass, fail, asUser } = ctx
  await db.query(`SET LOCAL statement_timeout = '120s'`)

  const view = await db.query(
    `SELECT 1 FROM information_schema.views
     WHERE table_schema = 'public' AND table_name = 'batch_request_context'`,
  )
  if (view.rows.length === 1) pass("view_exists", "batch_request_context")
  else fail("view_exists", "missing")

  const adminId = await ctx.createFixtureUser("admin", `${EMAIL}admin@test.local`)
  const salesId = await ctx.createFixtureUser("sales", `${EMAIL}sales@test.local`)
  await resetHarnessSession(db)
  await setJwt(db, adminId)
  await db.query(`UPDATE public.profiles SET display_name = 'Harness Requester' WHERE id = $1`, [salesId])
  await resetHarnessSession(db)

  const clientId = `CLT-${NOTES}-c`
  await insertHarnessClient(db, {
    id: clientId,
    name: "Harness 090",
    company: "Harness 090 Co",
    email: `${EMAIL}client@test.local`,
    phone: "0771118090",
  })

  const product = await db.query(
    `SELECT id FROM public.product_lines
     WHERE is_active IS TRUE AND lower(coalesce(vendor, '')) <> 'fortinet'
     ORDER BY product_name LIMIT 1`,
  )
  if (product.rows.length === 0) throw new Error("need an active product_line")
  const productId = product.rows[0].id

  const issuedSerial = `${PREFIX}-iss-${stamp()}`
  const directSerial = `${PREFIX}-dir-${stamp()}`
  for (const serial of [issuedSerial, directSerial]) {
    await db.query(
      `INSERT INTO public.inventory_items (
         id, product_id, serial_number, status, stock_pool, location, date_added
       ) VALUES (
         gen_random_uuid(), $1, $2, 'In Stock', 'sale', 'Warehouse A', current_date::text
       )`,
      [productId, serial],
    )
  }

  async function attempt(sql, params = []) {
    const sp = `sp_${Math.random().toString(36).slice(2, 8)}`
    await db.query(`SAVEPOINT ${sp}`)
    try {
      const res = await db.query(sql, params)
      await db.query(`RELEASE SAVEPOINT ${sp}`)
      return { ok: true, rows: res.rows, error: null }
    } catch (e) {
      await db.query(`ROLLBACK TO SAVEPOINT ${sp}`)
      return { ok: false, rows: [], error: e instanceof Error ? e.message : String(e) }
    }
  }

  const submitted = await asUser(salesId, () =>
    attempt(`SELECT public.submit_request($1::jsonb)::text AS id`, [
      JSON.stringify({
        client_id: clientId,
        type: "Sale",
        atlas_task_url: MY_TASKS,
        invoice_choice: "pending",
        lines: [{ product_id: productId, quantity: 1 }],
        notes: `${NOTES} issued sale`,
      }),
    ]),
  )
  const requestId = submitted.rows[0]?.id
  if (!submitted.ok || !requestId) {
    fail("submit", submitted.error ?? "no id")
    return
  }
  pass("submit", requestId)

  const reqMeta = await db.query(
    `SELECT request_number FROM public.stock_requests WHERE id = $1`,
    [requestId],
  )
  const requestNumber = reqMeta.rows[0]?.request_number
  if (!requestNumber) fail("request_number", "missing")
  else pass("request_number", requestNumber)

  await dropMovementPrev(db)
  const issue = await asUser(adminId, () =>
    attempt(`SELECT public.issue_units($1::uuid, $2::jsonb) AS result`, [
      requestId,
      JSON.stringify([{ serial: issuedSerial }]),
    ]),
  )
  const batchId = issue.rows[0]?.result?.batch_id
  if (!issue.ok || !issue.rows[0]?.result?.ok || !batchId) {
    fail("issue", issue.error ?? JSON.stringify(issue.rows[0]?.result))
    return
  }
  const clock = { tick: 0, baseIso: "2026-10-13T00:00:00.000Z" }
  const issuedTxns = await db.query(`SELECT id FROM public.transactions WHERE batch_id = $1`, [batchId])
  await stampTxn(db, clock, ...issuedTxns.rows.map((t) => t.id))
  pass("issue", batchId)

  const ctxRow = await asUser(adminId, async () => {
    const res = await db.query(
      `SELECT request_id::text, request_number, requester_name, atlas_task_url
       FROM public.batch_request_context_for($1::text[])`,
      [[batchId]],
    )
    return res.rows[0]
  })
  if (
    ctxRow?.request_id === requestId &&
    ctxRow?.request_number === requestNumber &&
    ctxRow?.requester_name === "Harness Requester" &&
    ctxRow?.atlas_task_url === MY_TASKS
  ) {
    pass("context_issued", JSON.stringify(ctxRow))
  } else {
    fail("context_issued", JSON.stringify(ctxRow))
  }

  const salesOwn = await asUser(salesId, async () => {
    const res = await db.query(
      `SELECT requester_name, request_number FROM public.batch_request_context_for($1::text[])`,
      [[batchId]],
    )
    return res.rows[0]
  })
  if (salesOwn?.request_number === requestNumber) pass("sales_fn_own_batch", requestNumber)
  else fail("sales_fn_own_batch", JSON.stringify(salesOwn))

  // Own-request RLS still applies on stock_requests itself.
  const otherSales = await ctx.createFixtureUser("sales", `${EMAIL}other@test.local`)
  const otherSeesContext = await asUser(otherSales, async () => {
    const res = await db.query(
      `SELECT 1 FROM public.batch_request_context_for($1::text[])`,
      [[batchId]],
    )
    return res.rows.length
  })
  if (otherSeesContext === 0) pass("sales_fn_other_batch", "0 rows")
  else fail("sales_fn_other_batch", String(otherSeesContext))
  const otherSeesRequest = await asUser(otherSales, async () => {
    const res = await db.query(`SELECT id FROM public.stock_requests WHERE id = $1`, [requestId])
    return res.rows.length
  })
  if (otherSeesRequest === 0) pass("rls_requests_own_only", "other sales cannot SELECT request")
  else fail("rls_requests_own_only", `saw ${otherSeesRequest}`)

  // Direct sale — no request link.
  const directItem = await db.query(
    `SELECT id FROM public.inventory_items WHERE serial_number = $1`,
    [directSerial],
  )
  const directItemId = directItem.rows[0]?.id
  await dropMovementPrev(db)
  const directBatch = `BATCH-${PREFIX}-dir-${stamp()}`
  const directTxn = `TXN-${PREFIX}-dir-${stamp()}`
  const direct = await asUser(adminId, () =>
    attempt(`SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb) AS result`, [
      JSON.stringify([
        {
          id: directItemId,
          product_id: productId,
          serial_number: directSerial,
          status: "Sold",
          date_added: "2026-10-13T00:00:00.000Z",
          location: "Delivered",
          client: "Harness 090",
          client_id: clientId,
          stock_pool: "sale",
        },
      ]),
      JSON.stringify([
        {
          id: directTxn,
          type: "Sale",
          serial_number: directSerial,
          item_name: "Harness product",
          client: "Harness 090",
          client_id: clientId,
          date: "2026-10-13T00:00:00.000Z",
          batch_id: directBatch,
          created_by: adminId,
          metadata: { invoice_choice: "pending" },
        },
      ]),
    ]),
  )
  if (!direct.ok) {
    fail("direct_sale", direct.error)
  } else {
    await stampTxn(db, clock, directTxn)
    pass("direct_sale", directBatch)
  }

  const directCtx = await asUser(adminId, async () => {
    const res = await db.query(
      `SELECT 1 FROM public.batch_request_context_for($1::text[])`,
      [[directBatch]],
    )
    return res.rows.length
  })
  if (directCtx === 0) pass("direct_no_context", "no row")
  else fail("direct_no_context", "unexpected context row")

  // Search by requester name finds the issued batch.
  const byRequester = await asUser(adminId, async () => {
    const res = await db.query(
      `SELECT public.transaction_batch_page(20, 0, NULL, NULL, NULL, $1, true) AS page`,
      ["harness requester"],
    )
    return res.rows[0]?.page
  })
  const batchKeys = (byRequester?.batches ?? []).map((b) => b.batchKey)
  if (batchKeys.includes(`b:${batchId}`)) pass("search_requester", `b:${batchId}`)
  else fail("search_requester", JSON.stringify(batchKeys.slice(0, 5)))

  const byNumber = await asUser(adminId, async () => {
    const res = await db.query(
      `SELECT public.transaction_batch_page(20, 0, NULL, NULL, NULL, $1, true) AS page`,
      [requestNumber.toLowerCase()],
    )
    return res.rows[0]?.page
  })
  const numberKeys = (byNumber?.batches ?? []).map((b) => b.batchKey)
  if (numberKeys.includes(`b:${batchId}`)) pass("search_request_number", requestNumber)
  else fail("search_request_number", JSON.stringify(numberKeys.slice(0, 5)))

  // Dispatched page restored with request fields.
  const dispatched = await asUser(adminId, async () => {
    const res = await db.query(
      `SELECT public.dispatched_page(50, 0, 'Sale', NULL, NULL, $1) AS page`,
      [requestNumber.toLowerCase()],
    )
    return res.rows[0]?.page
  })
  const rows = dispatched?.rows ?? []
  const hit = rows.find((r) => r.requestNumber === requestNumber || r.batchKey === `b:${batchId}`)
  if (hit?.requestedBy === "Harness Requester" && hit?.requestNumber === requestNumber) {
    pass("dispatched_request_fields", hit.batchKey)
  } else {
    fail("dispatched_request_fields", JSON.stringify(hit ?? rows.slice(0, 2)))
  }
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-090-rq7-batch-request-context.mjs")
if (isMain) {
  runVerifyCli({ markers: MARKERS, timeoutMs: 300_000, label: "090-rq7" }, runChecks)
}
