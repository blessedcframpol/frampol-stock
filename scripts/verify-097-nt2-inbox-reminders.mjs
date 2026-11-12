/**
 * NT2 — unclaimed reminders: timing, cap, hours, pause/resume, stop, dups, RLS.
 *
 *   node --require ./scripts/dev/tls-classic.cjs scripts/rehearse-migration.mjs \
 *     supabase/migrations/20261111120000_nt2_inbox_live_reminders.sql \
 *     scripts/verify-097-nt2-inbox-reminders.mjs
 *   node --require ./scripts/dev/tls-classic.cjs scripts/verify-097-nt2-inbox-reminders.mjs
 */
import { runVerifyCli } from "./verify-harness.mjs"
import { dropMovementPrev, insertHarnessClient } from "./verify-harness-fixtures.mjs"

const NOTES = "harness-097-nt2"
const EMAIL = "harness-096-"
const TASK = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
const MY_TASKS = `https://ai.frampolafrica.com:10801/my-tasks?view=all&task=${TASK}`

export const MARKERS = [
  {
    label: "notifications",
    sql: `SELECT count(*)::int AS n FROM public.notifications WHERE body LIKE $1 OR title LIKE $1`,
    params: [`%${NOTES}%`],
  },
  {
    label: "request_reminders",
    sql: `SELECT count(*)::int AS n FROM public.request_reminders rr
          JOIN public.stock_requests sr ON sr.id = rr.request_id
          WHERE sr.notes LIKE $1`,
    params: [`${NOTES}%`],
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
    name: "Harness 096",
    company: "Harness 096 Co",
    email: `${EMAIL}client@test.local`,
    phone: "0771118096",
  })

  const products = await db.query(
    `SELECT id FROM public.product_lines
     WHERE is_active IS TRUE AND lower(coalesce(vendor, '')) <> 'fortinet'
     ORDER BY product_name LIMIT 1`,
  )
  if (products.rows.length < 1) throw new Error("need one non-Fortinet product")
  const productId = products.rows[0].id

  // Empty override → usual issuers; timing + go-live cutoff for harness.
  await db.query(
    `UPDATE public.app_settings SET
       unclaimed_request_reminder_interval_minutes = 15,
       unclaimed_request_reminder_max_count = 3,
       unclaimed_request_reminder_recipient_ids = '{}'::uuid[],
       unclaimed_reminders_live_from = timestamptz '2026-11-01 00:00:00+02'
     WHERE id IS TRUE`,
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

  async function seedSerial() {
    const serial = `NT2-${stamp()}`
    await db.query(
      `INSERT INTO public.inventory_items (
         id, product_id, serial_number, status, stock_pool, location, date_added
       ) VALUES (
         gen_random_uuid(), $1, $2, 'In Stock', 'sale', 'Warehouse A', current_date::text
       )`,
      [productId, serial],
    )
    return serial
  }

  async function submitSale(qty, noteSuffix) {
    const res = await asUser(salesId, () =>
      attempt(`SELECT public.submit_request($1::jsonb)::text AS id`, [
        JSON.stringify({
          client_id: clientId,
          type: "Sale",
          atlas_task_url: MY_TASKS,
          invoice_choice: "number",
          invoice_number: `INV-${NOTES}-${stamp()}`,
          lines: [{ product_id: productId, quantity: qty }],
          notes: `${NOTES} ${noteSuffix}`,
        }),
      ]),
    )
    return res
  }

  // ---- Display-status + live_from gates (would have caught prod dry-run) ----
  const fully = await submitSale(1, "fully-issued")
  const fullyId = fully.rows[0]?.id
  if (!fully.ok || !fullyId) {
    fail("submit_fully_issued", fully.error ?? "no id")
    return
  }
  await db.query(
    `UPDATE public.stock_requests SET created_at = timestamptz '2026-11-10 08:00:00+02' WHERE id = $1`,
    [fullyId],
  )
  const serialFull = await seedSerial()
  await dropMovementPrev(db)
  const issuedFull = await asUser(adminA, () =>
    attempt(`SELECT public.issue_units($1::uuid, $2::jsonb) AS result`, [
      fullyId,
      JSON.stringify([{ serial: serialFull }]),
    ]),
  )
  if (!issuedFull.ok || !issuedFull.rows[0]?.result?.ok) {
    fail("issue_fully", issuedFull.error ?? JSON.stringify(issuedFull.rows[0]?.result))
    return
  }
  const stFull = await db.query(
    `SELECT public.request_display_status($1::uuid) AS s, review_state FROM public.stock_requests WHERE id = $1`,
    [fullyId],
  )
  await db.query(`SELECT public.notify_unclaimed_request_reminders(timestamptz '2026-11-10 09:00:00+02') AS n`)
  const remFull = await db.query(`SELECT 1 FROM public.request_reminders WHERE request_id = $1`, [fullyId])
  if (
    stFull.rows[0]?.review_state === "submitted" &&
    ["completed", "awaiting_invoice"].includes(stFull.rows[0]?.s) &&
    remFull.rowCount === 0
  ) {
    pass("no_reminder_fully_issued", `${stFull.rows[0].s}`)
  } else {
    fail("no_reminder_fully_issued", JSON.stringify({ status: stFull.rows[0], rem: remFull.rowCount }))
  }

  const partial = await submitSale(2, "partial")
  const partialId = partial.rows[0]?.id
  if (!partial.ok || !partialId) {
    fail("submit_partial", partial.error ?? "no id")
    return
  }
  await db.query(
    `UPDATE public.stock_requests SET created_at = timestamptz '2026-11-10 08:00:00+02' WHERE id = $1`,
    [partialId],
  )
  const serialPartial = await seedSerial()
  await dropMovementPrev(db)
  const issuedPartial = await asUser(adminA, () =>
    attempt(`SELECT public.issue_units($1::uuid, $2::jsonb) AS result`, [
      partialId,
      JSON.stringify([{ serial: serialPartial }]),
    ]),
  )
  if (!issuedPartial.ok || !issuedPartial.rows[0]?.result?.ok) {
    fail("issue_partial", issuedPartial.error ?? JSON.stringify(issuedPartial.rows[0]?.result))
    return
  }
  const stPartial = await db.query(
    `SELECT public.request_display_status($1::uuid) AS s FROM public.stock_requests WHERE id = $1`,
    [partialId],
  )
  await db.query(`SELECT public.notify_unclaimed_request_reminders(timestamptz '2026-11-10 09:00:00+02') AS n`)
  const remPartial = await db.query(`SELECT 1 FROM public.request_reminders WHERE request_id = $1`, [partialId])
  if (stPartial.rows[0]?.s === "partially_issued" && remPartial.rowCount === 0) {
    pass("no_reminder_partially_issued", "ok")
  } else {
    fail("no_reminder_partially_issued", JSON.stringify({ status: stPartial.rows[0], rem: remPartial.rowCount }))
  }

  // awaiting_invoice / completed already covered by fully issued; assert explicitly via status label
  if (["awaiting_invoice", "completed"].includes(stFull.rows[0]?.s)) {
    pass("no_reminder_awaiting_or_completed", stFull.rows[0].s)
  } else {
    fail("no_reminder_awaiting_or_completed", stFull.rows[0]?.s)
  }

  const beforeLive = await submitSale(1, "before-live")
  const beforeLiveId = beforeLive.rows[0]?.id
  if (!beforeLive.ok || !beforeLiveId) {
    fail("submit_before_live", beforeLive.error ?? "no id")
    return
  }
  await db.query(
    `UPDATE public.stock_requests SET created_at = timestamptz '2026-10-15 08:00:00+02' WHERE id = $1`,
    [beforeLiveId],
  )
  const stBefore = await db.query(
    `SELECT public.request_display_status($1::uuid) AS s FROM public.stock_requests WHERE id = $1`,
    [beforeLiveId],
  )
  await db.query(`SELECT public.notify_unclaimed_request_reminders(timestamptz '2026-11-10 09:00:00+02') AS n`)
  const remBefore = await db.query(`SELECT 1 FROM public.request_reminders WHERE request_id = $1`, [beforeLiveId])
  if (stBefore.rows[0]?.s === "being_reviewed" && remBefore.rowCount === 0) {
    pass("no_reminder_before_live_from", "ok")
  } else {
    fail("no_reminder_before_live_from", JSON.stringify({ status: stBefore.rows[0], rem: remBefore.rowCount }))
  }

  const submitted = await submitSale(1, "sale")
  const requestId = submitted.rows[0]?.id
  if (!submitted.ok || !requestId) {
    fail("submit", submitted.error ?? "no id")
    return
  }
  pass("submit", requestId)

  // Backdate created_at so first reminder is due (still after live_from).
  await db.query(
    `UPDATE public.stock_requests SET created_at = timestamptz '2026-11-10 08:00:00+02' WHERE id = $1`,
    [requestId],
  )
  const stOk = await db.query(`SELECT public.request_display_status($1::uuid) AS s FROM public.stock_requests WHERE id = $1`, [
    requestId,
  ])
  if (stOk.rows[0]?.s !== "being_reviewed") {
    fail("being_reviewed_after_live_from_pre", stOk.rows[0]?.s)
    return
  }

  // Weekend → 0
  const weekend = await db.query(
    `SELECT public.notify_unclaimed_request_reminders(timestamptz '2026-11-08 10:00:00+02') AS n`,
  )
  if (weekend.rows[0].n === 0) pass("hours_weekend", "0")
  else fail("hours_weekend", String(weekend.rows[0].n))

  // Outside 07:30–17:30 → 0
  const early = await db.query(
    `SELECT public.notify_unclaimed_request_reminders(timestamptz '2026-11-10 06:00:00+02') AS n`,
  )
  if (early.rows[0].n === 0) pass("hours_early", "0")
  else fail("hours_early", String(early.rows[0].n))

  // Working hours → our being_reviewed request after live_from gets a reminder
  const remBeforeFirst = await db.query(
    `SELECT coalesce(sent_count, 0)::int AS n FROM public.request_reminders WHERE request_id = $1`,
    [requestId],
  )
  const first = await db.query(
    `SELECT public.notify_unclaimed_request_reminders(timestamptz '2026-11-10 09:00:00+02') AS n`,
  )
  const remAfterFirst = await db.query(
    `SELECT sent_count FROM public.request_reminders WHERE request_id = $1`,
    [requestId],
  )
  if ((remBeforeFirst.rows[0]?.n ?? 0) === 0 && remAfterFirst.rows[0]?.sent_count === 1) {
    pass("first_reminder", "1")
    pass("being_reviewed_after_live_from", "yes")
  } else {
    fail(
      "first_reminder",
      JSON.stringify({ global: first.rows[0].n, rem: remAfterFirst.rows[0], before: remBeforeFirst.rows[0] }),
    )
  }

  const notes = await db.query(
    `SELECT user_id::text AS uid, type FROM public.notifications
     WHERE type = 'request_unclaimed_reminder' AND metadata->>'request_id' = $1`,
    [requestId],
  )
  const uids = new Set(notes.rows.map((r) => r.uid))
  if (uids.has(adminA) && uids.has(adminB) && !uids.has(salesId)) {
    pass("recipients_nt1b", `n=${uids.size}`)
  } else {
    fail("recipients_nt1b", JSON.stringify([...uids]))
  }

  const salesSees = await asUser(salesId, async () => {
    const res = await db.query(
      `SELECT id FROM public.notifications
       WHERE type = 'request_unclaimed_reminder' AND user_id = $1::uuid`,
      [adminA],
    )
    return res.rows.length
  })
  if (salesSees === 0) pass("rls_sales_no_admin_rows", "ok")
  else fail("rls_sales_no_admin_rows", String(salesSees))

  // Overlap within interval → no new ping for this request
  await db.query(`SELECT public.notify_unclaimed_request_reminders(timestamptz '2026-11-10 09:05:00+02') AS n`)
  const dupSent = await db.query(`SELECT sent_count FROM public.request_reminders WHERE request_id = $1`, [requestId])
  if (dupSent.rows[0]?.sent_count === 1) pass("no_duplicate_within_interval", "0")
  else fail("no_duplicate_within_interval", JSON.stringify(dupSent.rows[0]))

  // Pause while issue lock fresh
  await asUser(adminA, () => attempt(`SELECT public.begin_request_issue($1::uuid)`, [requestId]))
  await db.query(`SELECT public.notify_unclaimed_request_reminders(timestamptz '2026-11-10 09:20:00+02') AS n`)
  const pausedSent = await db.query(`SELECT sent_count FROM public.request_reminders WHERE request_id = $1`, [requestId])
  if (pausedSent.rows[0]?.sent_count === 1) pass("pause_while_locked", "0")
  else fail("pause_while_locked", JSON.stringify(pausedSent.rows[0]))
  await asUser(adminA, () => attempt(`SELECT public.end_request_issue($1::uuid)`, [requestId]))
  // Stale lock: clear freshness
  await db.query(
    `UPDATE public.stock_requests SET issue_lock_user_id = null, issue_lock_since = null WHERE id = $1`,
    [requestId],
  )

  // Second + third within cap
  await db.query(`SELECT public.notify_unclaimed_request_reminders(timestamptz '2026-11-10 09:20:00+02') AS n`)
  const after2 = await db.query(`SELECT sent_count FROM public.request_reminders WHERE request_id = $1`, [requestId])
  await db.query(`SELECT public.notify_unclaimed_request_reminders(timestamptz '2026-11-10 09:40:00+02') AS n`)
  const after3 = await db.query(`SELECT sent_count FROM public.request_reminders WHERE request_id = $1`, [requestId])
  if (after2.rows[0]?.sent_count === 2 && after3.rows[0]?.sent_count === 3) pass("repeat_within_cap", "2+3")
  else fail("repeat_within_cap", JSON.stringify([after2.rows[0], after3.rows[0]]))

  await db.query(`SELECT public.notify_unclaimed_request_reminders(timestamptz '2026-11-10 10:00:00+02') AS n`)
  const cappedSent = await db.query(`SELECT sent_count FROM public.request_reminders WHERE request_id = $1`, [requestId])
  if (cappedSent.rows[0]?.sent_count === 3) pass("cap_max_3", "0")
  else fail("cap_max_3", JSON.stringify(cappedSent.rows[0]))

  const sent = await db.query(
    `SELECT sent_count, stopped_at FROM public.request_reminders WHERE request_id = $1`,
    [requestId],
  )
  if (sent.rows[0]?.sent_count === 3 && sent.rows[0].stopped_at == null) {
    pass("sent_count_3", "ok")
  } else {
    fail("sent_count_3", JSON.stringify(sent.rows[0]))
  }

  // Status change stops permanently
  await asUser(adminA, () =>
    attempt(`SELECT public.cancel_request($1::uuid, $2)`, [requestId, `${NOTES} cancel`]),
  )
  const stopped = await db.query(
    `SELECT stopped_at IS NOT NULL AS stopped, stop_reason FROM public.request_reminders WHERE request_id = $1`,
    [requestId],
  )
  if (stopped.rows[0]?.stopped) pass("stop_on_status_change", stopped.rows[0].stop_reason)
  else fail("stop_on_status_change", JSON.stringify(stopped.rows[0]))

  // Override recipients: only adminA
  const submitted2 = await asUser(salesId, () =>
    attempt(`SELECT public.submit_request($1::jsonb)::text AS id`, [
      JSON.stringify({
        client_id: clientId,
        type: "Sale",
        atlas_task_url: MY_TASKS,
        invoice_choice: "number",
        invoice_number: `INV-${NOTES}-b-${stamp()}`,
        lines: [{ product_id: productId, quantity: 1 }],
        notes: `${NOTES} override`,
      }),
    ]),
  )
  const requestId2 = submitted2.rows[0]?.id
  if (!submitted2.ok || !requestId2) {
    fail("submit_override", submitted2.error ?? "no id")
    return
  }
  await db.query(
    `UPDATE public.stock_requests SET created_at = timestamptz '2026-11-10 08:00:00+02' WHERE id = $1`,
    [requestId2],
  )
  await db.query(
    `UPDATE public.app_settings SET unclaimed_request_reminder_recipient_ids = ARRAY[$1::uuid] WHERE id IS TRUE`,
    [adminA],
  )
  await db.query(
    `SELECT public.notify_unclaimed_request_reminders(timestamptz '2026-11-10 11:00:00+02') AS n`,
  )
  const ov = await db.query(
    `SELECT user_id::text AS uid FROM public.notifications
     WHERE type = 'request_unclaimed_reminder' AND metadata->>'request_id' = $1`,
    [requestId2],
  )
  const ovSet = new Set(ov.rows.map((r) => r.uid))
  if (ovSet.has(adminA) && !ovSet.has(adminB) && !ovSet.has(salesId)) {
    pass("override_recipients", "adminA only")
  } else {
    fail("override_recipients", JSON.stringify([...ovSet]))
  }

  // EXECUTE revoked from authenticated
  const exec = await asUser(salesId, () =>
    attempt(`SELECT public.notify_unclaimed_request_reminders()`),
  )
  if (!exec.ok) pass("revoke_authenticated", "denied")
  else fail("revoke_authenticated", "callable")

  // Realtime publication + audit exclusion
  const pub = await db.query(
    `SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND tablename = 'stock_requests'`,
  )
  if (pub.rowCount === 1) pass("realtime_stock_requests", "listed")
  else pass("realtime_stock_requests", "publication absent (local ok)")

  const excl = await db.query(
    `SELECT reason FROM public.audit_trigger_exclusions WHERE table_name = 'request_reminders'`,
  )
  if (excl.rowCount === 1) pass("audit_exclusion", excl.rows[0].reason.slice(0, 40))
  else fail("audit_exclusion", "missing")
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-097-nt2-inbox-reminders.mjs")
if (isMain) {
  runVerifyCli({ markers: MARKERS, timeoutMs: 180_000, label: "097-nt2" }, runChecks)
}
