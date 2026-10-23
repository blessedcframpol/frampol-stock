/**
 * HF1 — requester happy path: catalogue + clients, My-tasks Atlas link, submit,
 * admin issue, accounts sees pending invoice queue. Sales/tech cannot read serials.
 *
 *   node scripts/rehearse-migration.mjs supabase/migrations/20261012140354_hf1_requester_atlas_catalogue.sql scripts/verify-088-hf1-requester-flow.mjs
 *   node scripts/verify-088-hf1-requester-flow.mjs
 */
import { runVerifyCli } from "./verify-harness.mjs"
import { dropMovementPrev, insertHarnessClient, stampTxn } from "./verify-harness-fixtures.mjs"

const PREFIX = "H3088"
const NOTES = "harness-088"
const EMAIL = "harness-088-"
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

  const adminId = await ctx.createFixtureUser("admin", `${EMAIL}admin@test.local`)
  const salesId = await ctx.createFixtureUser("sales", `${EMAIL}sales@test.local`)
  const techId = await ctx.createFixtureUser("technicians", `${EMAIL}tech@test.local`)
  const accountsId = await ctx.createFixtureUser("accounts", `${EMAIL}accounts@test.local`)

  const clientId = `CLT-${NOTES}-c`
  await insertHarnessClient(db, {
    id: clientId,
    name: "Harness 088",
    company: "Harness 088 Co",
    email: `${EMAIL}client@test.local`,
    phone: "0771118088",
  })

  const products = await db.query(
    `SELECT id, product_name, vendor
     FROM public.product_lines
     WHERE is_active IS TRUE
       AND lower(coalesce(vendor, '')) <> 'fortinet'
     ORDER BY product_name
     LIMIT 2`,
  )
  if (products.rows.length < 2) throw new Error("need two active non-Fortinet product_lines")
  const p1 = products.rows[0]
  const p2 = products.rows[1]

  // Four In Stock kits — two per requester role so each happy-path can issue both lines.
  const serialPairs = { sales: [], technicians: [] }
  for (const role of ["sales", "technicians"]) {
    for (const product of [p1, p2]) {
      const serial = `${PREFIX}-${role.slice(0, 1)}-${stamp()}`
      serialPairs[role].push(serial)
      await db.query(
        `INSERT INTO public.inventory_items (
           id, product_id, serial_number, status, stock_pool, location, date_added
         ) VALUES (
           gen_random_uuid(), $1, $2, 'In Stock', 'sale', 'Warehouse A', current_date::text
         )`,
        [product.id, serial],
      )
    }
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

  // --- Atlas shapes via shared SQL function ---
  {
    const shapes = [
      MY_TASKS,
      `https://ai.frampolafrica.com:10801/projects/11111111-1111-4111-8111-111111111111?task=${TASK}&x=1`,
      `http://ai.frampolafrica.com/my-tasks?task=${TASK}&view=all`,
      `  ${MY_TASKS}  `,
    ]
    const bad = [
      `https://evil.example/my-tasks?task=${TASK}`,
      `https://ai.frampolafrica.com:9999/my-tasks?task=${TASK}`,
      `https://ai.frampolafrica.com:10801/my-tasks?view=all`,
    ]
    let ok = true
    for (const link of shapes) {
      const r = await db.query(`SELECT public.atlas_task_id_from_url($1)::text AS id`, [link])
      if (r.rows[0]?.id !== TASK) {
        ok = false
        fail("atlas_sql_accept", `${link} → ${r.rows[0]?.id}`)
        break
      }
    }
    for (const link of bad) {
      const r = await db.query(`SELECT public.atlas_task_id_from_url($1) AS id`, [link])
      if (r.rows[0]?.id != null) {
        ok = false
        fail("atlas_sql_reject", link)
        break
      }
    }
    if (ok) pass("atlas_sql_shapes", `${shapes.length} ok / ${bad.length} rejected`)
  }

  // --- Catalogue + clients for sales and technicians ---
  for (const [role, uid] of [
    ["sales", salesId],
    ["technicians", techId],
  ]) {
    const cat = await asUser(uid, async () => {
      const res = await db.query(`SELECT * FROM public.product_catalogue()`)
      return res.rows
    })
    const cols = cat[0] ? Object.keys(cat[0]).sort() : []
    const expected = ["is_active", "product_id", "product_name", "requires_cloud_key", "vendor"]
    const hasBoth = cat.some((r) => r.product_id === p1.id) && cat.some((r) => r.product_id === p2.id)
    const noLeak = !cols.some((c) => /serial|location|client|history|price/i.test(c))
    if (hasBoth && cols.join(",") === expected.join(",") && noLeak) {
      pass(`catalogue_${role}`, `${cat.length} products`)
    } else {
      fail(`catalogue_${role}`, JSON.stringify({ n: cat.length, cols, hasBoth }))
    }

    const clients = await asUser(uid, async () => {
      const res = await db.query(`SELECT id FROM public.clients WHERE id = $1`, [clientId])
      return res.rows
    })
    if (clients.length === 1) pass(`clients_${role}`, clientId)
    else fail(`clients_${role}`, `n=${clients.length}`)

    // Cannot read kit serials
    const kits = await asUser(uid, async () => {
      const res = await db.query(
        `SELECT serial_number FROM public.inventory_items WHERE serial_number LIKE $1`,
        [`${PREFIX}%`],
      )
      return res.rows
    })
    if (kits.length === 0) pass(`no_serials_${role}`, "0 inventory rows")
    else fail(`no_serials_${role}`, `saw ${kits.length} serials`)
  }

  // --- Happy path per requester role ---
  const clock = { tick: 0, baseIso: "2026-10-12T00:00:00.000Z" }
  for (const [role, uid] of [
    ["sales", salesId],
    ["technicians", techId],
  ]) {
    const submitted = await asUser(uid, () =>
      attempt(`SELECT public.submit_request($1::jsonb)::text AS id`, [
        JSON.stringify({
          client_id: clientId,
          type: "Sale",
          atlas_task_url: MY_TASKS,
          invoice_choice: "pending",
          lines: [
            { product_id: p1.id, quantity: 1 },
            { product_id: p2.id, quantity: 1 },
          ],
          notes: `${NOTES} ${role} sale`,
        }),
      ]),
    )
    const requestId = submitted.rows[0]?.id
    if (!submitted.ok || !requestId) {
      fail(`submit_${role}`, submitted.error ?? "no id")
      continue
    }

    const stored = await db.query(
      `SELECT atlas_task_url, atlas_task_id::text AS tid, invoice_status, created_by::text AS by
       FROM public.stock_requests WHERE id = $1`,
      [requestId],
    )
    const row = stored.rows[0]
    if (
      row?.atlas_task_url === MY_TASKS &&
      row?.tid === TASK &&
      row?.invoice_status === "pending" &&
      row?.by === uid
    ) {
      pass(`submit_${role}`, requestId)
    } else {
      fail(`submit_${role}_store`, JSON.stringify(row))
    }

    const mine = await asUser(uid, async () => {
      const res = await db.query(
        `SELECT id FROM public.stock_requests WHERE created_by = $1 AND notes = $2`,
        [uid, `${NOTES} ${role} sale`],
      )
      return res.rows
    })
    if (mine.some((r) => r.id === requestId)) pass(`my_requests_${role}`, "listed")
    else fail(`my_requests_${role}`, JSON.stringify(mine))

    // Admin issues both lines (one serial each). Drop temp table as superuser first.
    const pair = serialPairs[role]
    await dropMovementPrev(db)
    const issue = await asUser(adminId, () =>
      attempt(`SELECT public.issue_units($1::uuid, $2::jsonb) AS result`, [
        requestId,
        JSON.stringify([{ serial: pair[0] }, { serial: pair[1] }]),
      ]),
    )
    if (issue.ok && issue.rows[0]?.result?.ok && issue.rows[0].result.batch_id) {
      const batchId = issue.rows[0].result.batch_id
      const txns = await db.query(`SELECT id FROM public.transactions WHERE batch_id = $1`, [batchId])
      await stampTxn(db, clock, ...txns.rows.map((t) => t.id))
      pass(`issue_${role}`, "admin issued")
    } else {
      fail(`issue_${role}`, issue.error ?? JSON.stringify(issue.rows[0]?.result))
    }

    // Accounts sees it in the pending-invoice home set
    const pending = await asUser(accountsId, async () => {
      const res = await db.query(
        `SELECT id, request_number, invoice_status
         FROM public.stock_requests
         WHERE id = $1 AND invoice_status = 'pending'
           AND review_state NOT IN ('rejected', 'cancelled', 'closed')`,
        [requestId],
      )
      return res.rows
    })
    if (pending.length === 1) pass(`accounts_pending_${role}`, pending[0].request_number)
    else fail(`accounts_pending_${role}`, `n=${pending.length}`)
  }

  // Accounts still sees inventory (Fortinet issue path); sales still cannot.
  {
    const accKits = await asUser(accountsId, async () => {
      const res = await db.query(
        `SELECT count(*)::int AS n FROM public.inventory_items WHERE deleted_at IS NULL`,
      )
      return res.rows[0]?.n ?? 0
    })
    if (accKits > 0) pass("accounts_can_read_inventory", `n=${accKits}`)
    else fail("accounts_can_read_inventory", "0 rows")
  }
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-088-hf1-requester-flow.mjs")
if (isMain) {
  runVerifyCli({ markers: MARKERS, timeoutMs: 300_000, label: "088-hf1" }, runChecks)
}
