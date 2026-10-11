/**
 * RQ2 roles, Fortinet mix, internal client, awaiting-invoice reminders.
 * Rollback harness — never commits.
 *
 * Usage: node scripts/verify-082-rq2-roles.mjs
 */
import { withHarness } from "./verify-harness.mjs"
import { dropMovementPrev } from "./verify-harness-fixtures.mjs"

const NOTES = "harness-082"
const EMAIL = "harness-082-"

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
  {
    label: "items",
    sql: `SELECT count(*)::int AS n FROM public.inventory_items WHERE serial_number LIKE $1 OR id LIKE $1`,
    params: [`%H3082%`],
  },
  {
    label: "transactions",
    sql: `SELECT count(*)::int AS n FROM public.transactions WHERE id LIKE $1 OR batch_id LIKE $1 OR serial_number LIKE $1`,
    params: [`%H3082%`],
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
  return `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

const ATLAS = (t) =>
  `https://ai.frampolafrica.com:10801/projects/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?task=${t}`

export async function runChecks(ctx) {
  const { db, pass, fail } = ctx
  await db.query(`SET LOCAL statement_timeout = '120s'`)

  const settings = await db.query(
    `SELECT internal_client_id FROM public.app_settings WHERE id IS TRUE`,
  )
  const internalId = settings.rows[0]?.internal_client_id
  if (internalId === "CLT-1779783610314-dj3rqr9") {
    pass("internal_client_seed", internalId)
  } else {
    fail("internal_client_seed", `expected Frampol Inhouse id, got ${internalId}`)
  }

  const adminId = await ctx.createFixtureUser("admin", `${EMAIL}admin@test.local`)
  const adminBId = await ctx.createFixtureUser("admin", `${EMAIL}admin-b@test.local`)
  const salesId = await ctx.createFixtureUser("sales", `${EMAIL}sales@test.local`)
  const salesBId = await ctx.createFixtureUser("sales", `${EMAIL}sales-b@test.local`)
  const techId = await ctx.createFixtureUser("technicians", `${EMAIL}tech@test.local`)
  const accountsId = await ctx.createFixtureUser("accounts", `${EMAIL}accounts@test.local`)
  const viewerId = await ctx.createFixtureUser("viewer", `${EMAIL}viewer@test.local`)

  const client = await db.query(
    `INSERT INTO public.clients (id, name, company, email)
     VALUES ($1, 'Harness 082', 'Harness 082 Co', $2) RETURNING id`,
    [`CLT-${NOTES}-c`, `${EMAIL}client@test.local`],
  )
  const clientId = client.rows[0].id

  const products = await db.query(
    `WITH picks AS (
       SELECT id, product_name, vendor,
         CASE WHEN lower(coalesce(vendor,'')) = 'fortinet' THEN 1 ELSE 0 END AS is_f
       FROM public.product_lines WHERE is_active
     )
     SELECT
       (SELECT id FROM picks WHERE is_f = 1 ORDER BY id LIMIT 1) AS fortinet_id,
       (SELECT id FROM picks WHERE is_f = 0 AND product_name ILIKE '%starlink%' ORDER BY id LIMIT 1) AS starlink_id,
       (SELECT id FROM picks WHERE is_f = 0 AND product_name NOT ILIKE '%starlink%' ORDER BY id LIMIT 1) AS other_id`,
  )
  const fortinetId = products.rows[0]?.fortinet_id
  const starlinkId = products.rows[0]?.starlink_id
  const otherId = products.rows[0]?.other_id
  if (!fortinetId || !otherId) {
    throw new Error("need active Fortinet and non-Fortinet product_lines")
  }

  /** RLS-aware actor (SET LOCAL ROLE authenticated). */
  async function asUser(userId, fn) {
    return ctx.asUser(userId, fn)
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

  const tomorrow = await db.query(
    `SELECT (public.stock_request_today() + 7)::text AS d`,
  )
  const returnDate = tomorrow.rows[0].d

  // --- Fortinet mix rejected ---
  {
    const mixed = await asUser(salesId, () =>
      attempt(
        `SELECT public.submit_request($1::jsonb)`,
        [
          JSON.stringify({
            client_id: clientId,
            type: "Sale",
            atlas_task_url: ATLAS("11111111-1111-1111-1111-111111111111"),
            invoice_choice: "pending",
            lines: [
              { product_id: fortinetId, quantity: 1 },
              { product_id: otherId, quantity: 1 },
            ],
            notes: `${NOTES} mix`,
          }),
        ],
      ),
    )
    if (!mixed.ok && /all Fortinet|no Fortinet|mix/i.test(mixed.error ?? "")) {
      pass("fortinet_mix_rejected", mixed.error.split("\n")[0])
    } else {
      fail("fortinet_mix_rejected", mixed.ok ? "accepted mixed lines" : mixed.error)
    }
  }

  // --- Internal client forced ---
  {
    const submitted = await asUser(salesId, () =>
      attempt(
        `SELECT public.submit_request($1::jsonb) AS id`,
        [
          JSON.stringify({
            client_id: clientId,
            type: "Sale",
            atlas_task_url: ATLAS("22222222-2222-2222-2222-222222222222"),
            invoice_choice: "not_invoiced",
            not_invoiced_reason: `${NOTES} internal reason fifteen`,
            not_invoiced_kind: "internal",
            lines: [{ product_id: otherId, quantity: 1 }],
            notes: `${NOTES} internal`,
          }),
        ],
      ),
    )
    if (submitted.ok) {
      const id = submitted.rows[0].id
      const row = await db.query(
        `SELECT client_id, not_invoiced_kind, review_state FROM public.stock_requests WHERE id = $1`,
        [id],
      )
      if (
        row.rows[0]?.client_id === internalId &&
        row.rows[0]?.not_invoiced_kind === "internal" &&
        row.rows[0]?.review_state === "awaiting_approval"
      ) {
        pass("internal_client_forced", internalId)
      } else {
        fail("internal_client_forced", JSON.stringify(row.rows[0]))
      }
    } else {
      fail("internal_client_forced", submitted.error)
    }
  }

  // --- Own-only request visibility ---
  let salesRequestId
  {
    const mine = await asUser(salesId, () =>
      attempt(
        `SELECT public.submit_request($1::jsonb) AS id`,
        [
          JSON.stringify({
            client_id: clientId,
            type: "Sale",
            atlas_task_url: ATLAS("33333333-3333-3333-3333-333333333333"),
            invoice_choice: "pending",
            lines: [{ product_id: otherId, quantity: 1 }],
            notes: `${NOTES} sales-own`,
          }),
        ],
      ),
    )
    salesRequestId = mine.rows[0]?.id
    const otherSales = await asUser(salesBId, () =>
      attempt(`SELECT id FROM public.stock_requests WHERE id = $1`, [salesRequestId]),
    )
    const techSees = await asUser(techId, () =>
      attempt(`SELECT id FROM public.stock_requests WHERE id = $1`, [salesRequestId]),
    )
    const viewerSees = await asUser(viewerId, () =>
      attempt(`SELECT id FROM public.stock_requests WHERE id = $1`, [salesRequestId]),
    )
    const adminSees = await asUser(adminId, () =>
      attempt(`SELECT id FROM public.stock_requests WHERE id = $1`, [salesRequestId]),
    )
    if (
      mine.ok &&
      otherSales.ok &&
      otherSales.rows.length === 0 &&
      techSees.ok &&
      techSees.rows.length === 0 &&
      viewerSees.ok &&
      viewerSees.rows.length === 1 &&
      adminSees.ok &&
      adminSees.rows.length === 1
    ) {
      pass("request_visibility", "sales/tech own-only; viewer+admin see all")
    } else {
      fail(
        "request_visibility",
        `mine=${mine.ok} other=${otherSales.rows?.length} tech=${techSees.rows?.length} viewer=${viewerSees.rows?.length} admin=${adminSees.rows?.length}`,
      )
    }
  }

  // --- Sales/tech cannot issue ---
  {
    const salesIssue = await asUser(salesId, () =>
      attempt(`SELECT public.issue_units($1::uuid, $2::jsonb)`, [
        salesRequestId,
        JSON.stringify([{ serial: "H3082-NOSALE" }]),
      ]),
    )
    const techIssue = await asUser(techId, () =>
      attempt(`SELECT public.issue_units($1::uuid, $2::jsonb)`, [
        salesRequestId,
        JSON.stringify([{ serial: "H3082-NOTECH" }]),
      ]),
    )
    if (
      !salesIssue.ok &&
      /admin or accounts/i.test(salesIssue.error ?? "") &&
      !techIssue.ok &&
      /admin or accounts/i.test(techIssue.error ?? "")
    ) {
      pass("issue_roles", "sales and technicians refused")
    } else {
      fail("issue_roles", `${salesIssue.error} | ${techIssue.error}`)
    }
  }

  // --- Sales/tech cannot apply_stock_movement ---
  {
    const serial = `H3082-MV-${stamp()}`
    const itemId = `ITEM-${serial}`
    const productName = (
      await db.query(`SELECT product_name FROM public.product_lines WHERE id = $1`, [otherId])
    ).rows[0].product_name
    // Create via admin inbound so the kit exists, then probe Transfer as each role.
    await asUser(adminId, async () => {
      await dropMovementPrev(db)
      const created = await attempt(
        `SELECT public.apply_stock_movement('[]'::jsonb, $1::jsonb, $2::jsonb)`,
        [
          JSON.stringify([
            {
              id: itemId,
              product_id: otherId,
              serial_number: serial,
              status: "In Stock",
              date_added: "2026-10-11",
              location: "Warehouse A",
            },
          ]),
          JSON.stringify([
            {
              id: `TXN-H3082-IN-${stamp()}`,
              type: "Inbound",
              serial_number: serial,
              item_name: productName,
              date: "2026-10-11T00:00:00.000Z",
              client: "Internal",
              batch_id: `BATCH-H3082-IN-${stamp()}`,
              to_location: "Warehouse A",
            },
          ]),
        ],
      )
      if (!created.ok) throw new Error(`inbound fixture failed: ${created.error}`)
    })

    function transferPayload(toLocation, txnId) {
      return [
        JSON.stringify([
          {
            id: itemId,
            product_id: otherId,
            serial_number: serial,
            status: "In Stock",
            date_added: "2026-10-11",
            location: toLocation,
          },
        ]),
        JSON.stringify([
          {
            id: txnId,
            type: "Transfer",
            serial_number: serial,
            item_name: productName,
            date: "2026-10-11T00:00:00.000Z",
            client: "Internal",
            batch_id: `BATCH-${txnId}`,
            from_location: "Warehouse A",
            to_location: toLocation,
          },
        ]),
      ]
    }

    const salesMove = await asUser(salesId, async () => {
      await dropMovementPrev(db)
      return attempt(
        `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
        transferPayload("Warehouse B", `TXN-H3082-S-${stamp()}`),
      )
    })
    const techMove = await asUser(techId, async () => {
      await dropMovementPrev(db)
      return attempt(
        `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
        transferPayload("Warehouse C", `TXN-H3082-T-${stamp()}`),
      )
    })
    const adminMove = await asUser(adminId, async () => {
      await dropMovementPrev(db)
      return attempt(
        `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
        transferPayload("Warehouse B", `TXN-H3082-A-${stamp()}`),
      )
    })
    if (
      !salesMove.ok &&
      /Only an admin can record stock movements/i.test(salesMove.error ?? "") &&
      !techMove.ok &&
      /Only an admin can record stock movements/i.test(techMove.error ?? "") &&
      adminMove.ok
    ) {
      pass("movement_roles", "sales/tech refused; admin ok")
    } else {
      fail(
        "movement_roles",
        `sales=${salesMove.error} tech=${techMove.error} admin.ok=${adminMove.ok} admin.err=${adminMove.error}`,
      )
    }
  }

  // --- Viewer reads audit; cannot write profiles role ---
  {
    const audit = await asUser(viewerId, () =>
      attempt(`SELECT public.audit_log_read(NULL, NULL, NULL, NULL, NULL)`),
    )
    if (audit.ok) pass("viewer_audit_read", "audit_log_read allowed")
    else fail("viewer_audit_read", audit.error)

    const profiles = await asUser(viewerId, () =>
      attempt(`SELECT count(*)::int AS n FROM public.profiles`),
    )
    if (profiles.ok && (profiles.rows[0]?.n ?? 0) >= 1) {
      pass("viewer_profiles_read", `${profiles.rows[0].n} profiles`)
    } else {
      fail("viewer_profiles_read", profiles.error ?? "no rows")
    }

    const write = await asUser(viewerId, () =>
      attempt(`UPDATE public.profiles SET display_name = display_name WHERE id = $1`, [viewerId]),
    )
    // may succeed as no-op on own row depending on policy — force a role change refusal
    const roleWrite = await asUser(viewerId, () =>
      attempt(`UPDATE public.profiles SET role = 'admin' WHERE id = $1`, [salesId]),
    )
    if (!roleWrite.ok || (roleWrite.ok && (await db.query(`SELECT role FROM public.profiles WHERE id = $1`, [salesId])).rows[0]?.role) === "sales") {
      pass("viewer_no_role_write", "viewer cannot promote users")
    } else {
      fail("viewer_no_role_write", "viewer changed another user's role")
    }
    void write
  }

  // --- Reminder: weekday sends only for request-linked pending batches ---
  {
    const pending = await asUser(salesId, () =>
      attempt(`SELECT public.submit_request($1::jsonb) AS id`, [
        JSON.stringify({
          client_id: clientId,
          type: "Sale",
          atlas_task_url: ATLAS("44444444-4444-4444-4444-444444444444"),
          invoice_choice: "pending",
          lines: [{ product_id: otherId, quantity: 1 }],
          notes: `${NOTES} pending-inv`,
        }),
      ]),
    )
    const pendingId = pending.rows[0]?.id
    if (!pending.ok || !pendingId) {
      fail("reminder_setup", pending.error ?? "pending request not created")
    }
    const serial = `H3082-REM-${stamp()}`
    const productName = (
      await db.query(`SELECT product_name FROM public.product_lines WHERE id = $1`, [otherId])
    ).rows[0].product_name
    const issued = await asUser(adminId, async () => {
      await dropMovementPrev(db)
      const inbound = await attempt(`SELECT public.apply_stock_movement('[]'::jsonb, $1::jsonb, $2::jsonb)`, [
        JSON.stringify([
          {
            id: `ITEM-${serial}`,
            product_id: otherId,
            serial_number: serial,
            status: "In Stock",
            date_added: "2026-10-11",
            location: "Warehouse A",
            stock_pool: "sale",
          },
        ]),
        JSON.stringify([
          {
            id: `TXN-H3082-REM-IN-${stamp()}`,
            type: "Inbound",
            serial_number: serial,
            item_name: productName,
            date: "2026-10-11T00:00:00.000Z",
            client: "Internal",
            batch_id: `BATCH-H3082-REM-IN-${stamp()}`,
            to_location: "Warehouse A",
          },
        ]),
      ])
      if (!inbound.ok) return { ok: false, error: inbound.error }
      await dropMovementPrev(db)
      const out = await attempt(`SELECT public.issue_units($1::uuid, $2::jsonb) AS result`, [
        pendingId,
        JSON.stringify([{ serial }]),
      ])
      if (!out.ok) return { ok: false, error: out.error }
      const result = out.rows[0]?.result
      return { ok: Boolean(result?.ok), error: JSON.stringify(result), result }
    })
    if (!issued?.ok) {
      fail("reminder_setup", issued?.error ?? "issue_units failed")
    } else {
      const numbered = await db.query(
        `SELECT request_number FROM public.stock_requests WHERE id = $1`,
        [pendingId],
      )
      if (numbered.rows[0]?.request_number?.startsWith("REQ-")) {
        pass("request_number_assigned", numbered.rows[0].request_number)
      } else {
        fail("request_number_assigned", JSON.stringify(numbered.rows[0]))
      }

      const before = await db.query(
        `SELECT count(*)::int AS n FROM public.notifications
         WHERE type = 'request_awaiting_invoice_reminder' AND user_id = $1`,
        [salesId],
      )

      // Saturday 2026-10-10 10:00 UTC ≈ 12:00 Harare Saturday
      const weekend = await db.query(
        `SELECT public.notify_awaiting_invoice_reminders(timestamptz '2026-10-10 10:00:00+00') AS n`,
      )
      if (weekend.rows[0]?.n === 0) pass("reminder_weekend_skip", "Saturday → 0")
      else fail("reminder_weekend_skip", `n=${weekend.rows[0]?.n}`)

      // Dry-run Monday 09:00 Harare — no inserts
      const dry = await db.query(
        `SELECT public.notify_awaiting_invoice_reminders(timestamptz '2026-10-12 07:00:00+00', true) AS n`,
      )
      const afterDry = await db.query(
        `SELECT count(*)::int AS n FROM public.notifications
         WHERE type = 'request_awaiting_invoice_reminder' AND user_id = $1`,
        [salesId],
      )
      if ((dry.rows[0]?.n ?? 0) >= 1 && afterDry.rows[0].n === before.rows[0].n) {
        pass("reminder_dry_run", `would notify ${dry.rows[0].n}, wrote 0`)
      } else {
        fail(
          "reminder_dry_run",
          `dry=${dry.rows[0]?.n} before=${before.rows[0].n} after=${afterDry.rows[0].n}`,
        )
      }

      // Monday 2026-10-12 07:00 UTC = 09:00 Harare — send
      const weekday = await db.query(
        `SELECT public.notify_awaiting_invoice_reminders(timestamptz '2026-10-12 07:00:00+00') AS n`,
      )
      const after = await db.query(
        `SELECT count(*)::int AS n, max(body) AS body FROM public.notifications
         WHERE type = 'request_awaiting_invoice_reminder' AND user_id = $1`,
        [salesId],
      )
      if (
        (weekday.rows[0]?.n ?? 0) >= 1 &&
        after.rows[0].n > before.rows[0].n &&
        String(after.rows[0].body || "").includes(numbered.rows[0].request_number)
      ) {
        pass("reminder_weekday_sends", `n=${weekday.rows[0].n}`)
      } else {
        fail(
          "reminder_weekday_sends",
          `weekday=${weekday.rows[0]?.n} before=${before.rows[0].n} after=${after.rows[0].n} body=${after.rows[0].body}`,
        )
      }
    }
  }

  // --- Accounts still cannot approve 00000; admin B can ---
  {
    const zero = await asUser(adminId, () =>
      attempt(`SELECT public.submit_request($1::jsonb) AS id`, [
        JSON.stringify({
          client_id: clientId,
          type: "Sale",
          atlas_task_url: ATLAS("55555555-5555-5555-5555-555555555555"),
          invoice_choice: "not_invoiced",
          not_invoiced_reason: `${NOTES} zero approve fifteen`,
          not_invoiced_kind: "complimentary",
          lines: [{ product_id: otherId, quantity: 1 }],
          notes: `${NOTES} zero`,
        }),
      ]),
    )
    const zid = zero.rows[0]?.id
    const acc = await asUser(accountsId, () =>
      attempt(`SELECT public.approve_not_invoiced($1::uuid)`, [zid]),
    )
    const ok = await asUser(adminBId, () =>
      attempt(`SELECT public.approve_not_invoiced($1::uuid)`, [zid]),
    )
    if (!acc.ok && ok.ok) pass("accounts_cannot_approve_zero", "admin B approved")
    else fail("accounts_cannot_approve_zero", `${acc.error} | ok=${ok.ok}`)
  }

  void starlinkId
  void adminBId
}

async function main() {
  const { ok, failed, passed } = await withHarness(
    { markers: MARKERS, timeoutMs: 300_000, label: "verify-082" },
    runChecks,
  )
  console.log(ok ? `\n${passed} passed` : `\n${failed} failed (${passed} passed)`)
  process.exitCode = ok ? 0 : 1
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-082-rq2-roles.mjs")
if (isMain) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
