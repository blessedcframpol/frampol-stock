/**
 * NT1c — advisory issue lock: fresh-only list, take-over event, issue_units ignores lock.
 *
 *   node scripts/rehearse-migration.mjs supabase/migrations/20261014150000_nt1c_issue_lock_advisory.sql scripts/verify-094-nt1c-issue-lock-advisory.mjs
 */
import { runVerifyCli } from "./verify-harness.mjs"
import { dropMovementPrev, insertHarnessClient, stampTxn } from "./verify-harness-fixtures.mjs"

const PREFIX = "H3094"
const NOTES = "harness-094"
const EMAIL = "harness-094-"
const TASK = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01"
const MY_TASKS = `https://ai.frampolafrica.com:10801/my-tasks?view=all&task=${TASK}`

export const MARKERS = [
  {
    label: "stock_requests",
    sql: `SELECT count(*)::int AS n FROM public.stock_requests WHERE notes LIKE $1`,
    params: [`${NOTES}%`],
  },
  {
    label: "stock_request_events",
    sql: `SELECT count(*)::int AS n FROM public.stock_request_events WHERE payload::text LIKE $1`,
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
  const salesId = await ctx.createFixtureUser("sales", `${EMAIL}sales@test.local`)

  const clientId = `CLT-${NOTES}-c`
  await insertHarnessClient(db, {
    id: clientId,
    name: "Harness 094",
    company: "Harness 094 Co",
    email: `${EMAIL}client@test.local`,
    phone: "0771118094",
  })

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
    fail("submit", submitted.error ?? "no id")
    return
  }
  pass("submit", requestId)

  await asUser(adminA, async () => {
    await db.query(`SELECT public.begin_request_issue($1::uuid)`, [requestId])
  })

  const freshVisible = await db.query(
    `SELECT issue_lock_active_user_id::text AS uid
     FROM public.stock_request_fresh_issue_locks(ARRAY[$1::uuid])`,
    [requestId],
  )
  if (freshVisible.rows[0]?.uid === adminA) pass("fresh_lock_visible", adminA)
  else fail("fresh_lock_visible", freshVisible.rows[0]?.uid ?? "null")

  await db.query(
    `UPDATE public.stock_requests
     SET issue_lock_since = now() - interval '4 minutes'
     WHERE id = $1`,
    [requestId],
  )

  const staleHidden = await db.query(
    `SELECT issue_lock_active_user_id::text AS uid
     FROM public.stock_request_fresh_issue_locks(ARRAY[$1::uuid])`,
    [requestId],
  )
  if (staleHidden.rows[0]?.uid == null) pass("stale_lock_hidden", "null active holder")
  else fail("stale_lock_hidden", staleHidden.rows[0]?.uid)

  await db.query(
    `UPDATE public.stock_requests
     SET issue_lock_user_id = $2::uuid, issue_lock_since = now()
     WHERE id = $1`,
    [requestId, adminA],
  )

  const lockB = await asUser(adminB, async () => {
    const row = await db.query(`SELECT public.begin_request_issue($1::uuid) AS v`, [requestId])
    return row.rows[0].v
  })
  if (lockB?.needs_takeover === true && lockB?.held_by_me === false) {
    pass("begin_needs_takeover", lockB.display_name ?? adminA)
  } else {
    fail("begin_needs_takeover", JSON.stringify(lockB))
  }

  const takeover = await asUser(adminB, async () => {
    const row = await db.query(`SELECT public.take_over_request_issue($1::uuid) AS v`, [requestId])
    return row.rows[0].v
  })
  if (takeover?.held_by_me === true && takeover?.user_id === adminB) {
    pass("take_over_lock", adminB)
  } else {
    fail("take_over_lock", JSON.stringify(takeover))
  }

  const ev = await db.query(
    `SELECT event_type, payload->>'previous_holder_id' AS prev
     FROM public.stock_request_events
     WHERE request_id = $1 AND event_type = 'issue_lock_takeover'
     ORDER BY created_at DESC LIMIT 1`,
    [requestId],
  )
  if (ev.rowCount === 1 && ev.rows[0].prev === adminA) {
    pass("take_over_event", ev.rows[0].prev)
  } else {
    fail("take_over_event", JSON.stringify(ev.rows))
  }

  await db.query(
    `UPDATE public.stock_requests
     SET issue_lock_user_id = $2::uuid, issue_lock_since = now()
     WHERE id = $1`,
    [requestId, adminA],
  )

  await dropMovementPrev(db)
  const issueDespiteLock = await asUser(adminB, () =>
    attempt(`SELECT public.issue_units($1::uuid, $2::jsonb) AS result`, [
      requestId,
      JSON.stringify([{ serial }]),
    ]),
  )
  if (issueDespiteLock.ok && issueDespiteLock.rows[0]?.result?.ok) {
    const batchId = issueDespiteLock.rows[0].result.batch_id
    const txns = await db.query(`SELECT id FROM public.transactions WHERE batch_id = $1`, [batchId])
    await stampTxn(db, { tick: 0, baseIso: "2026-10-12T00:00:00.000Z" }, ...txns.rows.map((t) => t.id))
    pass("issue_despite_other_lock", "ok")
  } else {
    fail("issue_despite_other_lock", issueDespiteLock.error ?? JSON.stringify(issueDespiteLock.rows[0]?.result))
  }
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-094-nt1c-issue-lock-advisory.mjs")
if (isMain) {
  runVerifyCli({ markers: MARKERS, timeoutMs: 180_000, label: "094-nt1c" }, runChecks)
}
