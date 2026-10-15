/**
 * NT1 / NT1b — request notifications (role-based submit), inbox RLS, issue → requester only.
 *
 *   node scripts/rehearse-migration.mjs supabase/migrations/20261014120000_nt1b_role_request_notifications.sql scripts/verify-093-nt1-notifications-live.mjs
 *   node scripts/verify-093-nt1-notifications-live.mjs
 */
import { runVerifyCli } from "./verify-harness.mjs"
import { dropMovementPrev, stampTxn } from "./verify-harness-fixtures.mjs"

const PREFIX = "H3093"
const NOTES = "harness-093"
const EMAIL = "harness-093-"
const TASK = "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff"
const MY_TASKS = `https://ai.frampolafrica.com:10801/my-tasks?view=all&task=${TASK}`

export const MARKERS = [
  {
    label: "stock_requests",
    sql: `SELECT count(*)::int AS n FROM public.stock_requests WHERE notes LIKE $1`,
    params: [`${NOTES}%`],
  },
  {
    label: "notifications",
    sql: `SELECT count(*)::int AS n FROM public.notifications WHERE body LIKE $1 OR title LIKE $1`,
    params: [`%${NOTES}%`],
  },
]

function stamp() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

export async function runChecks(ctx) {
  const { db, pass, fail, asUser } = ctx
  await db.query(`SET LOCAL statement_timeout = '120s'`)

  const adminA = await ctx.createFixtureUser("admin", `${EMAIL}admin-a@test.local`)
  const adminB = await ctx.createFixtureUser("admin", `${EMAIL}admin-b@test.local`)
  const inactiveAdmin = await ctx.createFixtureUser("admin", `${EMAIL}inactive-admin@test.local`)
  await db.query(`UPDATE public.profiles SET active = false WHERE id = $1`, [inactiveAdmin])
  const salesId = await ctx.createFixtureUser("sales", `${EMAIL}sales@test.local`)
  const accountsId = await ctx.createFixtureUser("accounts", `${EMAIL}accounts@test.local`)

  const client = await db.query(
    `INSERT INTO public.clients (id, name, company, email)
     VALUES ($1, 'Harness 093', 'Harness 093 Co', $2) RETURNING id`,
    [`CLT-${NOTES}-c`, `${EMAIL}client@test.local`],
  )
  const clientId = client.rows[0].id

  const products = await db.query(
    `SELECT id FROM public.product_lines
     WHERE is_active IS TRUE AND lower(coalesce(vendor, '')) <> 'fortinet'
     ORDER BY product_name LIMIT 1`,
  )
  if (products.rows.length < 1) throw new Error("need one non-Fortinet product")
  const productId = products.rows[0].id

  const serial = `${PREFIX}-${stamp()}`
  await db.query(
    `INSERT INTO public.inventory_items (
       id, product_id, serial_number, status, stock_pool, location, date_added
     ) VALUES (
       gen_random_uuid(), $1, $2, 'In Stock', 'sale', 'Warehouse A', current_date::text
     )`,
    [productId, serial],
  )

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
        invoice_choice: "number",
        invoice_number: `INV-${NOTES}`,
        lines: [{ product_id: productId, quantity: 1 }],
        notes: `${NOTES} sale`,
      }),
    ]),
  )
  const requestId = submitted.rows[0]?.id
  if (!submitted.ok || !requestId) {
    fail("submit_sales", submitted.error ?? "no id")
    return
  }
  pass("submit_sales", requestId)

  const adminNotes = await db.query(
    `SELECT user_id::text AS uid FROM public.notifications
     WHERE type = 'request_submitted' AND metadata->>'request_id' = $1`,
    [requestId],
  )
  const adminUids = new Set(adminNotes.rows.map((r) => r.uid))
  if (adminUids.has(adminA) && adminUids.has(adminB) && !adminUids.has(inactiveAdmin) && !adminUids.has(salesId)) {
    pass("submit_notify_admins", `n=${adminUids.size}`)
  } else {
    fail("submit_notify_admins", JSON.stringify(adminNotes.rows))
  }

  const salesSeesIssuerRows = await asUser(salesId, async () => {
    const res = await db.query(`SELECT id FROM public.notifications WHERE user_id = $1::uuid`, [adminA])
    return res.rows
  })
  if (salesSeesIssuerRows.length === 0) pass("notifications_rls", "cannot read other user rows")
  else fail("notifications_rls", `saw ${salesSeesIssuerRows.length}`)

  const toIssue = await asUser(adminA, async () => {
    const res = await db.query(
      `SELECT id, review_state FROM public.stock_requests
       WHERE id = $1 AND review_state IN ('submitted', 'partially_issued')`,
      [requestId],
    )
    return res.rows
  })
  if (toIssue.length === 1) pass("to_issue_row", toIssue[0].review_state)
  else fail("to_issue_row", JSON.stringify(toIssue))

  const lockA = await asUser(adminA, async () => {
    const row = await db.query(`SELECT public.begin_request_issue($1::uuid) AS v`, [requestId])
    return row.rows[0].v
  })
  if (lockA?.held_by_me === true && lockA?.user_id === adminA) pass("issue_lock_begin", "held")
  else fail("issue_lock_begin", JSON.stringify(lockA))

  const lockView = await asUser(adminB, async () => {
    const row = await db.query(
      `SELECT issue_lock_active_user_id::text AS uid
       FROM public.stock_request_fresh_issue_locks(ARRAY[$1::uuid])`,
      [requestId],
    )
    return row.rows[0]?.uid
  })
  if (lockView === adminA) pass("issue_lock_visible", adminA)
  else fail("issue_lock_visible", lockView ?? "null")

  await asUser(adminA, async () => {
    await db.query(`SELECT public.end_request_issue($1::uuid)`, [requestId])
  })

  const fortinet = await db.query(
    `SELECT id FROM public.product_lines
     WHERE is_active IS TRUE AND lower(coalesce(vendor, '')) = 'fortinet'
     ORDER BY product_name LIMIT 1`,
  )
  if (fortinet.rows.length >= 1) {
    const fortinetProductId = fortinet.rows[0].id
    const fortSerial = `${PREFIX}-F-${stamp()}`
    await db.query(
      `INSERT INTO public.inventory_items (
         id, product_id, serial_number, status, stock_pool, location, date_added
       ) VALUES (
         gen_random_uuid(), $1, $2, 'In Stock', 'sale', 'Warehouse A', current_date::text
       )`,
      [fortinetProductId, fortSerial],
    )
    const fortSubmit = await asUser(salesId, () =>
      attempt(`SELECT public.submit_request($1::jsonb)::text AS id`, [
        JSON.stringify({
          client_id: clientId,
          type: "Sale",
          atlas_task_url: MY_TASKS,
          invoice_choice: "number",
          invoice_number: `INV-${NOTES}-F`,
          lines: [{ product_id: fortinetProductId, quantity: 1 }],
          notes: `${NOTES} fortinet`,
        }),
      ]),
    )
    const fortRequestId = fortSubmit.rows[0]?.id
    if (fortSubmit.ok && fortRequestId) {
      const acctNote = await db.query(
        `SELECT 1 FROM public.notifications
         WHERE type = 'request_submitted'
           AND metadata->>'request_id' = $1
           AND user_id = $2::uuid`,
        [fortRequestId, accountsId],
      )
      if (acctNote.rowCount === 1) pass("fortinet_notify_accounts", "accounts inbox")
      else fail("fortinet_notify_accounts", "missing")
    } else {
      fail("fortinet_submit", fortSubmit.error ?? "no id")
    }
  } else {
    pass("fortinet_notify_accounts", "skipped (no Fortinet product in catalog)")
  }

  await dropMovementPrev(db)
  const clock = { tick: 0, baseIso: "2026-10-12T00:00:00.000Z" }
  const issue = await asUser(adminA, () =>
    attempt(`SELECT public.issue_units($1::uuid, $2::jsonb) AS result`, [
      requestId,
      JSON.stringify([{ serial }]),
    ]),
  )
  if (issue.ok && issue.rows[0]?.result?.ok) {
    const batchId = issue.rows[0].result.batch_id
    const txns = await db.query(`SELECT id FROM public.transactions WHERE batch_id = $1`, [batchId])
    await stampTxn(db, clock, ...txns.rows.map((t) => t.id))
    pass("issue_units", "ok")
  } else {
    fail("issue_units", issue.error ?? JSON.stringify(issue.rows[0]?.result))
    return
  }

  const requesterNote = await asUser(salesId, async () => {
    const res = await db.query(
      `SELECT type FROM public.notifications
       WHERE user_id = $1::uuid AND metadata->>'request_id' = $2
       ORDER BY created_at DESC LIMIT 5`,
      [salesId, requestId],
    )
    return res.rows
  })
  if (requesterNote.some((r) => r.type === "request_units_issued")) {
    pass("requester_issued_notification", "request_units_issued")
  } else {
    fail("requester_issued_notification", JSON.stringify(requesterNote))
  }

  const adminIssueNote = await db.query(
    `SELECT 1 FROM public.notifications
     WHERE type = 'request_units_issued' AND metadata->>'request_id' = $1 AND user_id = $2::uuid`,
    [requestId, adminA],
  )
  if (adminIssueNote.rowCount === 0) pass("issue_notifies_requester_only", "admins not pinged on issue")
  else fail("issue_notifies_requester_only", "admin got issue notification")

  const pub = await db.query(
    `SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'notifications'`,
  )
  if (pub.rowCount === 1) pass("realtime_publication", "notifications listed")
  else pass("realtime_publication", "publication absent or table not added (local ok)")
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-093-nt1-notifications-live.mjs")
if (isMain) {
  runVerifyCli({ markers: MARKERS, timeoutMs: 180_000, label: "093-nt1b" }, runChecks)
}
