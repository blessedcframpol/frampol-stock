/**
 * PF1a2 — request_display_statuses batch == single; sales sees only own rows.
 *
 *   node --require ./scripts/dev/tls-classic.cjs scripts/rehearse-migration.mjs \
 *     supabase/migrations/20261026120000_pf1a2_request_display_statuses.sql \
 *     scripts/verify-pf1a2-batch-status.mjs
 *   node --require ./scripts/dev/tls-classic.cjs scripts/verify-pf1a2-batch-status.mjs
 */
import { runVerifyCli } from "./verify-harness.mjs"
import { insertHarnessClient, resetHarnessSession } from "./verify-harness-fixtures.mjs"

const EMAIL = "harness-pf1a2-"
const NOTES = "harness-pf1a2"

export const MARKERS = [
  {
    label: "users",
    sql: `SELECT count(*)::int AS n FROM auth.users WHERE email LIKE $1`,
    params: [`${EMAIL}%`],
  },
  {
    label: "stock_requests",
    sql: `SELECT count(*)::int AS n FROM public.stock_requests WHERE notes LIKE $1`,
    params: [`${NOTES}%`],
  },
  {
    label: "clients",
    sql: `SELECT count(*)::int AS n FROM public.clients WHERE id LIKE $1`,
    params: [`CLT-${NOTES}%`],
  },
]

export async function runChecks(ctx) {
  const { db, pass, fail, asUser } = ctx
  await db.query(`SET LOCAL statement_timeout = '180s'`)

  const fn = await db.query(
    `SELECT p.prosecdef AS is_definer,
            has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
            has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'request_display_statuses'
       AND pg_get_function_identity_arguments(p.oid) = 'p_request_ids uuid[]'`,
  )
  if (fn.rows.length !== 1) {
    fail("fn_exists", "request_display_statuses(uuid[]) missing")
    return
  }
  const meta = fn.rows[0]
  if (meta.is_definer === false) pass("security_invoker", "SECURITY INVOKER")
  else fail("security_invoker", "expected INVOKER, got DEFINER")
  if (meta.anon_exec === false && meta.public_exec === false) {
    pass("grants_revoked", "anon/PUBLIC cannot EXECUTE")
  } else {
    fail("grants_revoked", JSON.stringify(meta))
  }
  if (meta.auth_exec === true) pass("grants_auth", "authenticated can EXECUTE")
  else fail("grants_auth", "authenticated missing EXECUTE")

  const all = await db.query(`SELECT id FROM public.stock_requests ORDER BY id`)
  const ids = all.rows.map((r) => r.id)
  if (ids.length === 0) {
    fail("parity", "no stock_requests on test DB")
    return
  }

  const singles = await db.query(
    `SELECT id, public.request_display_status(id) AS status
     FROM public.stock_requests
     ORDER BY id`,
  )
  const singleMap = new Map(singles.rows.map((r) => [r.id, r.status]))

  const CHUNK = 500
  const batchMap = new Map()
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const batch = await db.query(
      `SELECT request_id, status FROM public.request_display_statuses($1::uuid[])`,
      [chunk],
    )
    for (const row of batch.rows) batchMap.set(row.request_id, row.status)
  }

  if (batchMap.size !== singleMap.size) {
    fail("parity_count", `batch ${batchMap.size} vs single ${singleMap.size}`)
  } else {
    pass("parity_count", `${batchMap.size} requests`)
  }

  const mismatches = []
  for (const [id, expected] of singleMap) {
    const got = batchMap.get(id)
    if (got !== expected) mismatches.push({ id, expected, got })
  }
  if (mismatches.length === 0) pass("parity_values", "batch == single for every request")
  else fail("parity_values", JSON.stringify(mismatches.slice(0, 5)))

  // Sales: only statuses for requests they can see (own rows under RQ2 RLS).
  const adminId = await ctx.createFixtureUser("admin", `${EMAIL}admin@test.local`)
  const salesId = await ctx.createFixtureUser("sales", `${EMAIL}sales@test.local`)
  await resetHarnessSession(db)

  const clientId = `CLT-${NOTES}-c`
  await insertHarnessClient(db, {
    id: clientId,
    name: "PF1a2",
    company: "PF1a2 Co",
    email: `${EMAIL}client@test.local`,
  })

  const ATLAS =
    "https://ai.frampolafrica.com:10801/my-tasks?view=all&task=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

  async function insertRequest(ownerId, noteSuffix) {
    const res = await db.query(
      `INSERT INTO public.stock_requests (
         client_id, created_by, review_state, type, notes, invoice_status, atlas_task_url
       ) VALUES ($1, $2::uuid, 'submitted', 'Sale', $3, 'pending', $4)
       RETURNING id`,
      [clientId, ownerId, `${NOTES}-${noteSuffix}`, ATLAS],
    )
    return res.rows[0].id
  }

  const salesReq = await insertRequest(salesId, "sales-own")
  const adminReq = await insertRequest(adminId, "admin-other")

  const asSales = await asUser(salesId, async () => {
    const res = await db.query(
      `SELECT request_id::text AS id, status
       FROM public.request_display_statuses($1::uuid[])
       ORDER BY request_id`,
      [[salesReq, adminReq]],
    )
    return res.rows
  })

  const returned = asSales.map((r) => r.id)
  if (returned.length === 1 && returned[0] === String(salesReq)) {
    pass("sales_visibility", "sales gets only own request status")
  } else {
    fail("sales_visibility", `got ${JSON.stringify(returned)} expected ${salesReq}`)
  }

  const expectedSales = (
    await db.query(`SELECT public.request_display_status($1::uuid) AS status`, [salesReq])
  ).rows[0]?.status
  if (asSales[0]?.status === expectedSales) {
    pass("sales_status_matches", expectedSales)
  } else {
    fail("sales_status_matches", `${asSales[0]?.status} vs ${expectedSales}`)
  }
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-pf1a2-batch-status.mjs")
if (isMain) {
  runVerifyCli({ markers: MARKERS, timeoutMs: 300_000, label: "pf1a2-batch-status" }, runChecks)
}
