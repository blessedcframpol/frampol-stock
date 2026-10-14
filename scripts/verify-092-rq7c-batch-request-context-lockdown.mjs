/**
 * RQ7c — batch_request_context locked down; batch_request_context_for enforces visibility.
 *
 *   node scripts/rehearse-migration.mjs supabase/migrations/20261013104900_rq7c_batch_request_context_lockdown.sql scripts/verify-092-rq7c-batch-request-context-lockdown.mjs
 *   node scripts/verify-092-rq7c-batch-request-context-lockdown.mjs
 */
import { withHarness } from "./verify-harness.mjs"
import { dropMovementPrev, stampTxn } from "./verify-harness-fixtures.mjs"

const PREFIX = "H3092"
const NOTES = "harness-092"
const EMAIL = "harness-092-"
const TASK = "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff"
const MY_TASKS = `https://ai.frampolafrica.com:10801/my-tasks?view=all&task=${TASK}`

export const MARKERS = [
  {
    label: "stock_requests",
    sql: `SELECT count(*)::int AS n FROM public.stock_requests WHERE notes LIKE $1`,
    params: [`${NOTES}%`],
  },
  {
    label: "transactions",
    sql: `SELECT count(*)::int AS n FROM public.transactions WHERE batch_id LIKE $1`,
    params: [`%${PREFIX}%`],
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

async function attempt(db, sql, params = []) {
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

export async function runChecks(ctx) {
  const { db, pass, fail, asUser } = ctx
  await db.query(`SET LOCAL statement_timeout = '120s'`)

  const fn = await db.query(
    `SELECT 1 FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'batch_request_context_for'`,
  )
  if (fn.rows.length === 1) pass("fn_exists", "batch_request_context_for")
  else fail("fn_exists", "missing")

  const viewPriv = await db.query(
    `SELECT has_table_privilege('authenticated', 'public.batch_request_context'::regclass, 'SELECT') AS auth,
            has_table_privilege('anon', 'public.batch_request_context'::regclass, 'SELECT') AS anon`,
  )
  if (viewPriv.rows[0]?.auth === false && viewPriv.rows[0]?.anon === false) {
    pass("view_revoked", "anon/authenticated cannot SELECT view")
  } else {
    fail("view_revoked", JSON.stringify(viewPriv.rows[0]))
  }

  const adminId = await ctx.createFixtureUser("admin", `${EMAIL}admin@test.local`)
  const salesId = await ctx.createFixtureUser("sales", `${EMAIL}sales@test.local`)
  const viewerId = await ctx.createFixtureUser("viewer", `${EMAIL}viewer@test.local`)
  const accountsId = await ctx.createFixtureUser("accounts", `${EMAIL}accounts@test.local`)
  await db.query(`UPDATE public.profiles SET display_name = 'Harness Requester' WHERE id = $1`, [salesId])

  const client = await db.query(
    `INSERT INTO public.clients (id, name, company, email)
     VALUES ($1, 'Harness 092', 'Harness 092 Co', $2) RETURNING id`,
    [`CLT-${NOTES}-c`, `${EMAIL}client@test.local`],
  )
  const clientId = client.rows[0].id

  const product = await db.query(
    `SELECT id FROM public.product_lines
     WHERE is_active IS TRUE AND lower(coalesce(vendor, '')) <> 'fortinet'
     ORDER BY product_name LIMIT 1`,
  )
  const productId = product.rows[0].id
  const serial = `${PREFIX}-iss-${stamp()}`
  await db.query(
    `INSERT INTO public.inventory_items (
       id, product_id, serial_number, status, stock_pool, location, date_added
     ) VALUES (
       gen_random_uuid(), $1, $2, 'In Stock', 'sale', 'Warehouse A', current_date::text
     )`,
    [productId, serial],
  )

  const submitted = await asUser(salesId, () =>
    attempt(
      db,
      `SELECT public.submit_request($1::jsonb)::text AS id`,
      [
        JSON.stringify({
          client_id: clientId,
          type: "Sale",
          atlas_task_url: MY_TASKS,
          invoice_choice: "pending",
          lines: [{ product_id: productId, quantity: 1 }],
          notes: `${NOTES}-req`,
        }),
      ],
    ),
  )
  const requestId = submitted.rows[0]?.id
  if (!submitted.ok || !requestId) {
    fail("submit", submitted.error ?? "no id")
    return
  }
  const reqMeta = await db.query(
    `SELECT request_number FROM public.stock_requests WHERE id = $1`,
    [requestId],
  )
  const requestNumber = reqMeta.rows[0]?.request_number
  if (!requestNumber) {
    fail("request_number", "missing")
    return
  }

  await dropMovementPrev(db)
  const issue = await asUser(adminId, () =>
    attempt(
      db,
      `SELECT public.issue_units($1::uuid, $2::jsonb) AS result`,
      [requestId, JSON.stringify([{ serial }])],
    ),
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

  const anonView = await attempt(
    db,
    `SET LOCAL ROLE anon; SELECT 1 FROM public.batch_request_context WHERE batch_id = $1`,
    [batchId],
  )
  if (!anonView.ok) pass("anon_view_denied", anonView.error?.slice(0, 80) ?? "denied")
  else fail("anon_view_denied", "unexpected row")

  const salesView = await asUser(salesId, () =>
    attempt(db, `SELECT 1 FROM public.batch_request_context WHERE batch_id = $1`, [batchId]),
  )
  if (!salesView.ok) pass("sales_view_denied", salesView.error?.slice(0, 80) ?? "denied")
  else fail("sales_view_denied", "unexpected access")

  const salesFn = await asUser(salesId, async () => {
    const res = await db.query(
      `SELECT request_number, requester_name FROM public.batch_request_context_for($1::text[])`,
      [[batchId]],
    )
    return res.rows[0]
  })
  if (salesFn?.request_number === requestNumber) pass("sales_fn_own", requestNumber)
  else fail("sales_fn_own", JSON.stringify(salesFn))

  const otherSales = await ctx.createFixtureUser("sales", `${EMAIL}other@test.local`)
  const otherFn = await asUser(otherSales, async () => {
    const res = await db.query(
      `SELECT request_number FROM public.batch_request_context_for($1::text[])`,
      [[batchId]],
    )
    return res.rows.length
  })
  if (otherFn === 0) pass("sales_fn_other_denied", "0 rows")
  else fail("sales_fn_other_denied", String(otherFn))

  for (const [label, userId] of [
    ["admin", adminId],
    ["accounts", accountsId],
    ["viewer", viewerId],
  ]) {
    const row = await asUser(userId, async () => {
      const res = await db.query(
        `SELECT request_number FROM public.batch_request_context_for($1::text[])`,
        [[batchId]],
      )
      return res.rows[0]
    })
    if (row?.request_number === requestNumber) pass(`${label}_fn_all`, requestNumber)
    else fail(`${label}_fn_all`, JSON.stringify(row))
  }
}

const isMain =
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("verify-092-rq7c-batch-request-context-lockdown.mjs")
if (isMain) {
  await withHarness({ markers: MARKERS, timeoutMs: 300_000, label: "092-rq7c" }, runChecks)
}
