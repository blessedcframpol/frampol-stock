/**
 * AT1 — Atlas outage mode: optional link, pending flag, set link, restore notifications.
 *
 *   node scripts/rehearse-migration.mjs supabase/migrations/20261015100000_at1_atlas_outage.sql scripts/verify-095-at1-atlas-outage.mjs
 */
import { runVerifyCli } from "./verify-harness.mjs"
import { dropMovementPrev, stampTxn } from "./verify-harness-fixtures.mjs"

const PREFIX = "H3095"
const NOTES = "harness-095"
const EMAIL = "harness-095-"
const TASK = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee95"
const MY_TASKS = `https://ai.frampolafrica.com:10801/my-tasks?view=all&task=${TASK}`
const REASON = "Atlas outage harness test reason"

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

  const adminId = await ctx.createFixtureUser("admin", `${EMAIL}admin@test.local`)
  const salesId = await ctx.createFixtureUser("sales", `${EMAIL}sales@test.local`)
  const accountsId = await ctx.createFixtureUser("accounts", `${EMAIL}accounts@test.local`)

  const client = await db.query(
    `INSERT INTO public.clients (id, name, company, email)
     VALUES ($1, 'Harness 095', 'Harness 095 Co', $2) RETURNING id`,
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

  function salePayload(extra = {}) {
    return {
      client_id: clientId,
      type: "Sale",
      invoice_choice: "number",
      invoice_number: `INV-${NOTES}-${stamp()}`,
      lines: [{ product_id: productId, quantity: 1 }],
      notes: `${NOTES} sale`,
      ...extra,
    }
  }

  const wasRequired = (
    await db.query(`SELECT atlas_link_required FROM public.app_settings WHERE id IS TRUE`)
  ).rows[0]?.atlas_link_required

  async function restoreSetting() {
    const need = wasRequired !== false
    await asUser(adminId, () =>
      attempt(`SELECT public.set_atlas_link_required($1::boolean, $2::text)`, [
        need,
        `${REASON} restore`,
      ]),
    )
  }

  try {
    const off = await asUser(adminId, () =>
      attempt(`SELECT public.set_atlas_link_required(false, $1::text)`, [REASON]),
    )
    if (!off.ok) fail("atlas_off", off.error ?? "failed")
    else pass("atlas_off", "ok")

    const pendingSubmit = await asUser(salesId, () =>
      attempt(`SELECT public.submit_request($1::jsonb)::text AS id`, [JSON.stringify(salePayload())]),
    )
    const pendingId = pendingSubmit.rows[0]?.id
    if (!pendingSubmit.ok || !pendingId) {
      fail("submit_blank_pending", pendingSubmit.error ?? "no id")
      return
    }
    const pendingRow = await db.query(
      `SELECT atlas_link_pending, atlas_task_url FROM public.stock_requests WHERE id = $1`,
      [pendingId],
    )
    if (pendingRow.rows[0]?.atlas_link_pending === true && pendingRow.rows[0]?.atlas_task_url == null) {
      pass("submit_blank_pending", pendingId)
    } else {
      fail("submit_blank_pending", JSON.stringify(pendingRow.rows[0]))
    }

    const junk = await asUser(salesId, () =>
      attempt(`SELECT public.submit_request($1::jsonb)::text AS id`, [
        JSON.stringify(salePayload({ atlas_task_url: "https://example.com/not-atlas" })),
      ]),
    )
    if (!junk.ok) pass("junk_link_rejected", junk.error?.slice(0, 80) ?? "rejected")
    else fail("junk_link_rejected", junk.rows[0]?.id ?? "submitted")

    await dropMovementPrev(db)
    const issued = await asUser(adminId, () =>
      attempt(`SELECT public.issue_units($1::uuid, $2::jsonb) AS result`, [
        pendingId,
        JSON.stringify([{ serial }]),
      ]),
    )
    if (issued.ok && issued.rows[0]?.result?.ok) {
      const batchId = issued.rows[0].result.batch_id
      const txns = await db.query(`SELECT id FROM public.transactions WHERE batch_id = $1`, [batchId])
      await stampTxn(db, { tick: 0, baseIso: "2026-10-15T00:00:00.000Z" }, ...txns.rows.map((t) => t.id))
      pass("issue_while_pending", "ok")
    } else {
      fail("issue_while_pending", issued.error ?? JSON.stringify(issued.rows[0]?.result))
    }

    const setLink = await asUser(salesId, () =>
      attempt(`SELECT public.set_request_atlas_link($1::uuid, $2::text)`, [pendingId, MY_TASKS]),
    )
    if (!setLink.ok) {
      fail("set_atlas_link", setLink.error ?? "failed")
    } else {
      const after = await db.query(
        `SELECT atlas_link_pending, atlas_task_id::text AS tid FROM public.stock_requests WHERE id = $1`,
        [pendingId],
      )
      const ev = await db.query(
        `SELECT event_type FROM public.stock_request_events
         WHERE request_id = $1 AND event_type = 'atlas_link_set'`,
        [pendingId],
      )
      if (
        after.rows[0]?.atlas_link_pending === false &&
        after.rows[0]?.tid === TASK.toLowerCase() &&
        ev.rowCount >= 1
      ) {
        pass("set_atlas_link", after.rows[0].tid)
      } else {
        fail("set_atlas_link", JSON.stringify({ after: after.rows[0], ev: ev.rowCount }))
      }
    }

    const on = await asUser(adminId, () =>
      attempt(`SELECT public.set_atlas_link_required(true, $1::text)`, [`${REASON} required again`]),
    )
    if (!on.ok) fail("atlas_on", on.error ?? "failed")
    else pass("atlas_on", "ok")

    const blankWhenOn = await asUser(salesId, () =>
      attempt(`SELECT public.submit_request($1::jsonb)::text AS id`, [JSON.stringify(salePayload())]),
    )
    if (!blankWhenOn.ok) pass("blank_rejected_when_on", blankWhenOn.error?.slice(0, 80) ?? "rejected")
    else fail("blank_rejected_when_on", blankWhenOn.rows[0]?.id ?? "submitted")

    const accountsToggle = await asUser(accountsId, () =>
      attempt(`SELECT public.set_atlas_link_required(false, $1::text)`, [REASON]),
    )
    if (!accountsToggle.ok && /admin only/i.test(accountsToggle.error ?? "")) {
      pass("accounts_cannot_toggle", "admin only")
    } else {
      fail("accounts_cannot_toggle", accountsToggle.error ?? "unexpected ok")
    }

    const off2 = await asUser(adminId, () =>
      attempt(`SELECT public.set_atlas_link_required(false, $1::text)`, [`${REASON} notify pass`]),
    )
    if (!off2.ok) {
      fail("atlas_off_notify", off2.error ?? "failed")
      return
    }

    const notifyReq = await asUser(salesId, () =>
      attempt(`SELECT public.submit_request($1::jsonb)::text AS id`, [
        JSON.stringify({
          ...salePayload(),
          notes: `${NOTES} notify`,
        }),
      ]),
    )
    const notifyReqId = notifyReq.rows[0]?.id
    if (!notifyReq.ok || !notifyReqId) {
      fail("notify_pending_submit", notifyReq.error ?? "no id")
      return
    }

    const reqNum = (
      await db.query(`SELECT request_number FROM public.stock_requests WHERE id = $1`, [notifyReqId])
    ).rows[0]?.request_number

    await db.query(`DELETE FROM public.notifications WHERE user_id = $1 AND type = 'atlas_link_restored'`, [
      salesId,
    ])

    const restoreOn = await asUser(adminId, () =>
      attempt(`SELECT public.set_atlas_link_required(true, $1::text)`, [`${REASON} notify restore`]),
    )
    if (!restoreOn.ok) {
      fail("atlas_on_notify", restoreOn.error ?? "failed")
      return
    }

    const notif = await db.query(
      `SELECT title, body FROM public.notifications
       WHERE user_id = $1 AND type = 'atlas_link_restored'
       ORDER BY created_at DESC LIMIT 3`,
      [salesId],
    )
    const hit = notif.rows.find(
      (r) => r.title === "Atlas is back" && r.body?.includes(reqNum ?? "REQ"),
    )
    if (hit) pass("notify_on_restore", hit.body)
    else fail("notify_on_restore", JSON.stringify(notif.rows))
  } finally {
    await restoreSetting()
  }
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-095-at1-atlas-outage.mjs")
if (isMain) {
  runVerifyCli({ markers: MARKERS, timeoutMs: 180_000, label: "095-at1" }, runChecks)
}
