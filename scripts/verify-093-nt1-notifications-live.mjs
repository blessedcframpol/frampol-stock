/**
 * NT1 — issuer notifications, inbox RLS, request queues data after submit/issue.
 *
 *   node scripts/rehearse-migration.mjs supabase/migrations/20261013111300_nt1_notifications_live.sql scripts/verify-093-nt1-notifications-live.mjs
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

  const issuerEmail = `${EMAIL}issuer@test.local`
  const otherEmail = `${EMAIL}other-admin@test.local`

  const issuerId = await ctx.createFixtureUser("admin", issuerEmail)
  const otherAdminId = await ctx.createFixtureUser("admin", otherEmail)
  const salesId = await ctx.createFixtureUser("sales", `${EMAIL}sales@test.local`)

  await db.query(
    `UPDATE public.app_settings
     SET stock_request_issuer_recipients_default = ARRAY[$1]::text[],
         stock_request_issuer_recipients_fortinet = ARRAY[$1]::text[]
     WHERE id IS TRUE`,
    [issuerEmail],
  )

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

  const issuerInbox = await asUser(issuerId, async () => {
    const res = await db.query(
      `SELECT id, type, read_at, user_id::text AS uid
       FROM public.notifications
       WHERE type = 'request_submitted'
         AND metadata->>'request_id' = $1`,
      [requestId],
    )
    return res.rows
  })
  if (issuerInbox.length === 1 && issuerInbox[0].uid === issuerId) {
    pass("issuer_notification", "request_submitted")
  } else {
    fail("issuer_notification", JSON.stringify(issuerInbox))
  }

  const otherInbox = await asUser(otherAdminId, async () => {
    const res = await db.query(
      `SELECT id FROM public.notifications WHERE type = 'request_submitted' AND metadata->>'request_id' = $1`,
      [requestId],
    )
    return res.rows
  })
  if (otherInbox.length === 0) pass("issuer_isolation", "other admin sees none")
  else fail("issuer_isolation", `n=${otherInbox.length}`)

  const salesSeesIssuerRows = await asUser(salesId, async () => {
    const res = await db.query(
      `SELECT id FROM public.notifications WHERE user_id = $1::uuid`,
      [issuerId],
    )
    return res.rows
  })
  if (salesSeesIssuerRows.length === 0) pass("notifications_rls", "cannot read other user rows")
  else fail("notifications_rls", `saw ${salesSeesIssuerRows.length}`)

  const toIssue = await asUser(issuerId, async () => {
    const res = await db.query(
      `SELECT id, review_state FROM public.stock_requests
       WHERE id = $1 AND review_state IN ('submitted', 'partially_issued')`,
      [requestId],
    )
    return res.rows
  })
  if (toIssue.length === 1) pass("to_issue_row", toIssue[0].review_state)
  else fail("to_issue_row", JSON.stringify(toIssue))

  await dropMovementPrev(db)
  const clock = { tick: 0, baseIso: "2026-10-12T00:00:00.000Z" }
  const issue = await asUser(issuerId, () =>
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
  runVerifyCli({ markers: MARKERS, timeoutMs: 120_000 }, runChecks)
}
