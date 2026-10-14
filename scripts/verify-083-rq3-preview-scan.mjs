/**
 * RQ3 preview_issue_scan — rollback harness (BEGIN…ROLLBACK, never commits).
 *
 * Usage: node scripts/verify-083-rq3-preview-scan.mjs
 */
import { runVerifyCli } from "./verify-harness.mjs"
import { dropMovementPrev, setJwt, stampTxn } from "./verify-harness-fixtures.mjs"

const PREFIX = "H3083"
const ATLAS =
  "https://ai.frampolafrica.com:10801/projects/11111111-1111-1111-1111-111111111111?task=33333333-3333-3333-3333-333333333333"

let seq = 0
function nextId(kind) {
  seq += 1
  return `${kind}-${PREFIX}-${seq}`
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
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
    label: "stock_requests",
    sql: `SELECT count(*)::int AS n FROM public.stock_requests WHERE notes LIKE $1 OR client_id LIKE $2`,
    params: [`${PREFIX}%`, `${PREFIX}%`],
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
    sql: `SELECT count(*)::int AS n FROM auth.users WHERE email LIKE 'harness-083-%@test.local'`,
    params: [],
  },
]

export async function runChecks(ctx) {
  const { db, pass, fail, raises } = ctx
  await db.query(`SET LOCAL statement_timeout = '120s'`)

  const days = await db.query(
    `SELECT to_char(public.stock_request_today(), 'YYYY-MM-DD') AS today`,
  )
  const today = days.rows[0].today
  const dateIso = `${today}T00:00:00.000Z`
  const clock = { tick: 0, baseIso: dateIso }

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

  const admin = await ctx.createFixtureUser("admin", "harness-083-admin@test.local")
  const sales = await ctx.createFixtureUser("sales", "harness-083-sales@test.local")
  const accounts = await ctx.createFixtureUser("accounts", "harness-083-accounts@test.local")
  const tech = await ctx.createFixtureUser("technicians", "harness-083-tech@test.local")
  const viewer = await ctx.createFixtureUser("viewer", "harness-083-viewer@test.local")

  const clientId = `${PREFIX}-CLIENT`
  await db.query(`INSERT INTO public.clients (id, name, company, email) VALUES ($1, $2, $3, $4)`, [
    clientId,
    `${PREFIX} Client`,
    `${PREFIX} Co`,
    "harness-083-client@test.local",
  ])

  const PL = {
    fg: { id: `${PREFIX}-PL-FG`, name: `${PREFIX} FortiGate`, vendor: "Fortinet", key: true },
    ap: { id: `${PREFIX}-PL-AP`, name: `${PREFIX} FortiAP`, vendor: "Fortinet", key: false },
    sl: { id: `${PREFIX}-PL-SL`, name: `${PREFIX} Starlink Mini Kit`, vendor: "Starlink", key: false },
  }
  for (const line of Object.values(PL)) {
    await db.query(
      `INSERT INTO public.product_lines (id, product_name, vendor, requires_serial, requires_cloud_key, is_active)
       VALUES ($1, $2, $3, true, $4, true)`,
      [line.id, line.name, line.vendor, line.key],
    )
  }

  async function inbound(serial, line, cloudKey = null) {
    const itemId = nextId("ITEM")
    const txnId = nextId("TXN")
    await setJwt(db, admin)
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
  }

  const S = (n) => `${PREFIX}-${n}`
  await inbound(S("AP-1"), PL.ap)
  await inbound(S("AP-2"), PL.ap)
  await inbound(S("FG-1"), PL.fg)
  await inbound(S("SL-1"), PL.sl)

  await setJwt(db, sales)
  const submitted = await attempt(`SELECT public.submit_request($1::jsonb)::text AS id`, [
    JSON.stringify({
      client_id: clientId,
      type: "Sale",
      atlas_task_url: ATLAS,
      notes: `${PREFIX} preview`,
      invoice_choice: "pending",
      lines: [{ product_id: PL.ap.id, quantity: 2 }],
    }),
  ])
  if (!submitted.ok) {
    fail("submit", submitted.error)
    return
  }
  const requestId = submitted.rows[0].id

  await setJwt(db, admin)
  async function preview(serial, already = [], cloudKey = null) {
    const result = await attempt(
      `SELECT public.preview_issue_scan($1::uuid, $2, $3::text[], $4) AS result`,
      [requestId, serial, already, cloudKey],
    )
    return result.ok ? result.rows[0].result : { ok: false, reason: result.error, serial }
  }

  async function writeSnapshot(serial) {
    const tx = await db.query(`SELECT count(*)::int AS n FROM public.transactions`)
    const item = await db.query(
      `SELECT status, location, cloud_key, stock_pool FROM public.inventory_items
       WHERE serial_number = $1 AND deleted_at IS NULL`,
      [serial],
    )
    const audit = await db.query(`SELECT count(*)::int AS n FROM public.audit_log`)
    const events = await db.query(
      `SELECT count(*)::int AS n FROM public.stock_request_events WHERE request_id = $1::uuid`,
      [requestId],
    )
    const req = await db.query(
      `SELECT review_state, invoice_status FROM public.stock_requests WHERE id = $1::uuid`,
      [requestId],
    )
    return {
      tx: tx.rows[0].n,
      item: item.rows[0] ?? null,
      audit: audit.rows[0].n,
      events: events.rows[0].n,
      req: req.rows[0] ?? null,
    }
  }

  const beforeWrite = await writeSnapshot(S("AP-1"))
  const ok1 = await preview(S("AP-1"))
  const afterWrite = await writeSnapshot(S("AP-1"))
  if (ok1.ok && ok1.line_id && ok1.needs_cloud_key === false) {
    pass("preview_ok", "In Stock AP assigns to the request line")
  } else {
    fail("preview_ok", JSON.stringify(ok1))
  }
  if (
    beforeWrite.tx === afterWrite.tx &&
    beforeWrite.audit === afterWrite.audit &&
    beforeWrite.events === afterWrite.events &&
    JSON.stringify(beforeWrite.item) === JSON.stringify(afterWrite.item) &&
    JSON.stringify(beforeWrite.req) === JSON.stringify(afterWrite.req)
  ) {
    pass(
      "preview_no_writes",
      "preview_issue_scan left transactions, inventory, audit_log, events, and request untouched",
    )
  } else {
    fail("preview_no_writes", JSON.stringify({ beforeWrite, afterWrite }))
  }

  const dup = await preview(S("AP-1"), [S("AP-1")])
  if (!dup.ok && /already scanned/i.test(dup.reason ?? "")) {
    pass("preview_already", "already-scanned list is refused in plain words")
  } else {
    fail("preview_already", JSON.stringify(dup))
  }

  const wrong = await preview(S("SL-1"))
  if (!wrong.ok && /wrong product/i.test(wrong.reason ?? "") && /Mini Kit/i.test(wrong.reason ?? "")) {
    pass("preview_wrong_product", wrong.reason)
  } else {
    fail("preview_wrong_product", JSON.stringify(wrong))
  }

  const missing = await preview(`${PREFIX}-NOPE`)
  if (!missing.ok && /not in inventory/i.test(missing.reason ?? "")) {
    pass("preview_missing", "unknown serial refused")
  } else {
    fail("preview_missing", JSON.stringify(missing))
  }

  // Issue AP-2 on a separate request so preview explains "not in stock — sold to …".
  const nashId = `${PREFIX}-NASH`
  await db.query(`INSERT INTO public.clients (id, name, company, email) VALUES ($1, $2, $3, $4)`, [
    nashId,
    "Nash Paints",
    "Nash Paints",
    "harness-083-nash@test.local",
  ])
  await setJwt(db, sales)
  const nashReq = await attempt(`SELECT public.submit_request($1::jsonb)::text AS id`, [
    JSON.stringify({
      client_id: nashId,
      type: "Sale",
      atlas_task_url: ATLAS,
      notes: `${PREFIX} nash`,
      invoice_choice: "pending",
      lines: [{ product_id: PL.ap.id, quantity: 1 }],
    }),
  ])
  if (!nashReq.ok) {
    fail("preview_sold", `nash submit: ${nashReq.error}`)
  } else {
    await setJwt(db, admin)
    await dropMovementPrev(db)
    const soldIssue = await attempt(`SELECT public.issue_units($1::uuid, $2::jsonb) AS result`, [
      nashReq.rows[0].id,
      JSON.stringify([{ serial: S("AP-2") }]),
    ])
    const soldBody = soldIssue.ok ? soldIssue.rows[0].result : null
    if (!soldBody?.ok) {
      fail("preview_sold", JSON.stringify(soldBody ?? soldIssue.error))
    } else {
      const sold = await preview(S("AP-2"))
      if (!sold.ok && /not in stock/i.test(sold.reason ?? "") && /Nash Paints/i.test(sold.reason ?? "")) {
        pass("preview_sold", sold.reason)
      } else {
        fail("preview_sold", JSON.stringify(sold))
      }
    }
  }

  // Cloud-key prompt on a Fortinet request.
  await setJwt(db, sales)
  const fgReq = await attempt(`SELECT public.submit_request($1::jsonb)::text AS id`, [
    JSON.stringify({
      client_id: clientId,
      type: "Sale",
      atlas_task_url: ATLAS,
      notes: `${PREFIX} fg`,
      invoice_choice: "pending",
      lines: [{ product_id: PL.fg.id, quantity: 1 }],
    }),
  ])
  let fgRequestId = null
  if (!fgReq.ok) {
    fail("fg_submit", fgReq.error)
  } else {
    fgRequestId = fgReq.rows[0].id
    await setJwt(db, admin)
    const ck = await attempt(
      `SELECT public.preview_issue_scan($1::uuid, $2, '{}'::text[], NULL) AS result`,
      [fgRequestId, S("FG-1")],
    )
    const body = ck.ok ? ck.rows[0].result : null
    if (body?.ok && body.needs_cloud_key && /Scan the cloud key for/i.test(body.cloud_key_prompt ?? "")) {
      pass("preview_cloud_key", body.cloud_key_prompt)
    } else {
      fail("preview_cloud_key", JSON.stringify(body ?? ck.error))
    }
  }

  // Only admin and accounts may call preview (reasons can name other clients).
  const roleDenials = []
  for (const [label, userId] of [
    ["sales", sales],
    ["technicians", tech],
    ["viewer", viewer],
  ]) {
    await setJwt(db, userId)
    const denied = await raises(
      `SELECT public.preview_issue_scan($1::uuid, $2, '{}'::text[], NULL)`,
      [requestId, S("AP-1")],
      "Only admin or accounts",
    )
    if (denied !== null) roleDenials.push(`${label}: ${denied}`)
  }
  if (roleDenials.length === 0) {
    pass("preview_roles_denied", "sales, technicians, and viewers cannot call preview_issue_scan")
  } else {
    fail("preview_roles_denied", roleDenials.join("; "))
  }

  await setJwt(db, admin)
  const adminOk = await attempt(
    `SELECT public.preview_issue_scan($1::uuid, $2, '{}'::text[], NULL) AS result`,
    [requestId, S("AP-1")],
  )
  const adminBody = adminOk.ok ? adminOk.rows[0].result : null
  if (adminBody?.ok) pass("preview_admin_ok", "admin can call preview_issue_scan")
  else fail("preview_admin_ok", JSON.stringify(adminBody ?? adminOk.error))

  // Accounts can preview Fortinet.
  if (fgRequestId) {
    await setJwt(db, accounts)
    const acc = await attempt(
      `SELECT public.preview_issue_scan($1::uuid, $2, '{}'::text[], NULL) AS result`,
      [fgRequestId, S("FG-1")],
    )
    const accBody = acc.ok ? acc.rows[0].result : null
    if (accBody?.ok && accBody.needs_cloud_key) {
      pass("preview_accounts", "accounts can preview Fortinet cloud-key units")
    } else {
      fail("preview_accounts", JSON.stringify(accBody ?? acc.error))
    }
  }

  // issue_units still works after a clean preview (no write from preview).
  await setJwt(db, admin)
  await dropMovementPrev(db)
  const issued = await attempt(`SELECT public.issue_units($1::uuid, $2::jsonb) AS result`, [
    requestId,
    JSON.stringify([{ serial: S("AP-1") }]),
  ])
  const issuedBody = issued.ok ? issued.rows[0].result : null
  if (issuedBody?.ok) {
    pass("issue_units_still", "issue_units succeeds after preview-only checks")
  } else {
    fail("issue_units_still", JSON.stringify(issuedBody ?? issued.error))
  }
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-083-rq3-preview-scan.mjs")
if (isMain) {
  runVerifyCli({ markers: MARKERS, timeoutMs: 180_000, label: "verify-083" }, runChecks)
}
