/**
 * CT1 — client_contacts validation, one-primary, RLS, audit, dup via contact, request contact_id.
 *
 *   APPLY_MIGRATION_COMMIT=1 APPLY_MIGRATION_ENV=test node --require ./scripts/dev/tls-classic.cjs \
 *     scripts/apply-migrations-commit.mjs supabase/migrations/20261117120000_ct1_client_contacts.sql
 *   APPLY_MIGRATION_COMMIT=1 APPLY_MIGRATION_ENV=test node --require ./scripts/dev/tls-classic.cjs \
 *     scripts/apply-migrations-commit.mjs supabase/migrations/20261117140000_ct1_contact_id_clear_errors.sql
 *   node --require ./scripts/dev/tls-classic.cjs scripts/verify-098-ct1-client-contacts.mjs
 */
import { runVerifyCli } from "./verify-harness.mjs"
import { dropMovementPrev, insertHarnessClient } from "./verify-harness-fixtures.mjs"

const NOTES = "harness-098-ct1"
const EMAIL = "harness-098-"
const TASK = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
const MY_TASKS = `https://ai.frampolafrica.com:10801/my-tasks?view=all&task=${TASK}`

export const MARKERS = [
  {
    label: "client_contacts",
    sql: `SELECT count(*)::int AS n FROM public.client_contacts WHERE notes LIKE $1 OR email LIKE $2`,
    params: [`${NOTES}%`, `${EMAIL}%`],
  },
  {
    label: "clients",
    sql: `SELECT count(*)::int AS n FROM public.clients WHERE id LIKE $1`,
    params: [`CLT-${NOTES}%`],
  },
]

function stamp() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

export async function runChecks(ctx) {
  const { db, pass, fail, asUser } = ctx
  await db.query(`SET LOCAL statement_timeout = '120s'`)

  const salesId = await ctx.createFixtureUser("sales", `${EMAIL}sales@test.local`)
  const adminId = await ctx.createFixtureUser("admin", `${EMAIL}admin@test.local`)

  const clientId = `CLT-${NOTES}-c`
  await insertHarnessClient(db, {
    id: clientId,
    name: "Harness 098 Client",
    company: "Harness 098 Co",
    email: `${EMAIL}client@test.local`,
    phone: "0771118098",
  })

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

  // --- validation ---
  const noReach = await asUser(salesId, () =>
    attempt(
      `INSERT INTO public.client_contacts (client_id, name, role, email, phone, notes)
       VALUES ($1, 'No Reach', 'buyer', NULL, NULL, $2)`,
      [clientId, NOTES],
    ),
  )
  if (!noReach.ok) pass("validation_email_or_phone", noReach.error?.slice(0, 80) ?? "rejected")
  else fail("validation_email_or_phone", "inserted without email/phone")

  const multiEmail = await asUser(salesId, () =>
    attempt(
      `INSERT INTO public.client_contacts (client_id, name, role, email, notes)
       VALUES ($1, 'Multi', 'buyer', 'a@test.local; b@test.local', $2)`,
      [clientId, NOTES],
    ),
  )
  if (!multiEmail.ok) pass("validation_single_email", multiEmail.error?.slice(0, 80) ?? "rejected")
  else fail("validation_single_email", "inserted multi email")

  const placeholder = await asUser(salesId, () =>
    attempt(
      `INSERT INTO public.client_contacts (client_id, name, role, email, notes)
       VALUES ($1, 'N/A', 'buyer', 'ok@test.local', $2)`,
      [clientId, NOTES],
    ),
  )
  if (!placeholder.ok) pass("validation_placeholder_name", placeholder.error?.slice(0, 80) ?? "rejected")
  else fail("validation_placeholder_name", "inserted placeholder name")

  const contactEmail = `${EMAIL}buyer@test.local`
  const insertOk = await asUser(salesId, () =>
    attempt(
      `INSERT INTO public.client_contacts (client_id, name, role, email, phone, is_primary, notes)
       VALUES ($1, 'Buyer One', 'buyer', $2, '0772228098', true, $3)
       RETURNING id, email, phone, is_primary`,
      [clientId, contactEmail, NOTES],
    ),
  )
  if (insertOk.ok) {
    pass("sales_insert", insertOk.rows[0]?.id)
  } else {
    fail("sales_insert", insertOk.error ?? "failed")
  }
  const contactId = insertOk.rows[0]?.id
  if (insertOk.rows[0]?.email === contactEmail.toLowerCase()) pass("email_normalised", insertOk.rows[0].email)
  else fail("email_normalised", JSON.stringify(insertOk.rows[0]))
  if (String(insertOk.rows[0]?.phone || "").startsWith("+263")) pass("phone_normalised", insertOk.rows[0].phone)
  else fail("phone_normalised", JSON.stringify(insertOk.rows[0]))

  // --- one primary ---
  const secondPrimary = await asUser(salesId, () =>
    attempt(
      `INSERT INTO public.client_contacts (client_id, name, role, email, is_primary, notes)
       VALUES ($1, 'Buyer Two', 'buyer', $2, true, $3)
       RETURNING id`,
      [clientId, `${EMAIL}buyer2@test.local`, NOTES],
    ),
  )
  if (!secondPrimary.ok) {
    fail("second_primary_insert", secondPrimary.error ?? "failed")
  } else {
    const primaryCount = await db.query(
      `SELECT count(*)::int AS n FROM public.client_contacts
       WHERE client_id = $1 AND is_primary IS TRUE AND active IS TRUE`,
      [clientId],
    )
    if (primaryCount.rows[0]?.n === 1) pass("one_active_primary", "n=1")
    else fail("one_active_primary", JSON.stringify(primaryCount.rows[0]))
    const first = await db.query(`SELECT is_primary FROM public.client_contacts WHERE id = $1`, [contactId])
    if (first.rows[0]?.is_primary === false) pass("first_demoted", "ok")
    else fail("first_demoted", JSON.stringify(first.rows[0]))
  }
  const contact2Id = secondPrimary.rows[0]?.id

  // --- sales update ---
  const salesEdit = await asUser(salesId, () =>
    attempt(`UPDATE public.client_contacts SET notes = $2 WHERE id = $1 RETURNING notes`, [
      contactId,
      `${NOTES}-edited`,
    ]),
  )
  if (salesEdit.ok) pass("sales_update", salesEdit.rows[0]?.notes)
  else fail("sales_update", salesEdit.error ?? "failed")

  // --- sales cannot hard-delete ---
  const salesDelete = await asUser(salesId, () =>
    attempt(`DELETE FROM public.client_contacts WHERE id = $1`, [contactId]),
  )
  if (!salesDelete.ok) pass("sales_no_hard_delete", salesDelete.error?.slice(0, 80) ?? "blocked")
  else {
    const still = await db.query(`SELECT 1 FROM public.client_contacts WHERE id = $1`, [contactId])
    if (still.rows.length === 0) fail("sales_no_hard_delete", "row deleted")
    else pass("sales_no_hard_delete", "rls blocked (0 rows)")
  }

  // --- audit ---
  const auditId = contact2Id || contactId
  const audit = await db.query(
    `SELECT action FROM public.audit_log
     WHERE table_name = 'client_contacts' AND row_id = $1
     ORDER BY at DESC LIMIT 5`,
    [auditId],
  )
  if (audit.rows.some((r) => r.action === "insert")) {
    pass("audit_row_written", audit.rows.map((r) => r.action).join(","))
  } else if (audit.rows.length > 0) {
    pass("audit_row_written", JSON.stringify(audit.rows[0]))
  } else {
    fail("audit_row_written", "no audit rows")
  }

  // --- duplicate via active contact email (before archive) ---
  const dupEmail = `${EMAIL}buyer2@test.local`
  const dup = await asUser(salesId, () =>
    attempt(`SELECT id, match_on FROM public.find_client_duplicate_candidates($1, NULL, NULL)`, [
      dupEmail,
    ]),
  )
  if (dup.ok && dup.rows.some((r) => r.id === clientId && (r.match_on || []).includes("email"))) {
    pass("dup_via_contact_email", clientId)
  } else fail("dup_via_contact_email", JSON.stringify(dup.rows ?? dup.error))

  // archive via active=false
  const archive = await asUser(salesId, () =>
    attempt(
      `UPDATE public.client_contacts SET active = false WHERE id = $1 RETURNING active, is_primary`,
      [contactId],
    ),
  )
  if (archive.ok && archive.rows[0]?.active === false && archive.rows[0]?.is_primary === false) {
    pass("archive_active_false", "ok")
  } else fail("archive_active_false", JSON.stringify(archive))

  // --- submit_request with contact_id ---
  const products = await db.query(
    `SELECT id FROM public.product_lines
     WHERE is_active IS TRUE AND lower(coalesce(vendor, '')) <> 'fortinet'
     ORDER BY product_name LIMIT 1`,
  )
  if (products.rows.length < 1) throw new Error("need one non-Fortinet product")
  const productId = products.rows[0].id

  // ensure an active contact for the request (contact2 should still be active primary)
  let buyerId = contact2Id
  if (!buyerId) {
    const mk = await asUser(salesId, () =>
      attempt(
        `INSERT INTO public.client_contacts (client_id, name, role, email, notes)
         VALUES ($1, 'Buyer Req', 'buyer', $2, $3) RETURNING id`,
        [clientId, `${EMAIL}req@test.local`, NOTES],
      ),
    )
    buyerId = mk.rows[0]?.id
  }

  await db.query(
    `UPDATE public.app_settings SET atlas_link_required = true WHERE id IS TRUE`,
  )

  // other client's contact → rejected
  const otherClientId = `CLT-${NOTES}-other`
  await insertHarnessClient(db, {
    id: otherClientId,
    name: "Other Client",
    company: "Other Co",
    email: `${EMAIL}other@test.local`,
    phone: "0773338098",
  })
  const otherContact = await asUser(salesId, () =>
    attempt(
      `INSERT INTO public.client_contacts (client_id, name, role, email, notes)
       VALUES ($1, 'Other Buyer', 'buyer', $2, $3) RETURNING id`,
      [otherClientId, `${EMAIL}other-buyer@test.local`, NOTES],
    ),
  )
  const otherContactId = otherContact.rows[0]?.id
  const foreignSubmit = await asUser(salesId, async () => {
    await dropMovementPrev(db)
    return attempt(`SELECT public.submit_request($1::jsonb) AS id`, [
      JSON.stringify({
        client_id: clientId,
        contact_id: otherContactId,
        type: "Sale",
        atlas_task_url: MY_TASKS,
        invoice_choice: "pending",
        notes: NOTES,
        lines: [{ product_id: productId, quantity: 1 }],
      }),
    ])
  })
  if (
    !foreignSubmit.ok &&
    /does not belong to this client/i.test(foreignSubmit.error || "")
  ) {
    pass("reject_foreign_contact", foreignSubmit.error?.slice(0, 80))
  } else fail("reject_foreign_contact", JSON.stringify(foreignSubmit))

  // archived contact → rejected
  const archivedSubmit = await asUser(salesId, async () => {
    await dropMovementPrev(db)
    return attempt(`SELECT public.submit_request($1::jsonb) AS id`, [
      JSON.stringify({
        client_id: clientId,
        contact_id: contactId,
        type: "Sale",
        atlas_task_url: MY_TASKS,
        invoice_choice: "pending",
        notes: NOTES,
        lines: [{ product_id: productId, quantity: 1 }],
      }),
    ])
  })
  if (!archivedSubmit.ok && /archived/i.test(archivedSubmit.error || "")) {
    pass("reject_archived_contact", archivedSubmit.error?.slice(0, 80))
  } else fail("reject_archived_contact", JSON.stringify(archivedSubmit))

  const submit = await asUser(salesId, async () => {
    await dropMovementPrev(db)
    return attempt(
      `SELECT public.submit_request($1::jsonb) AS id`,
      [
        JSON.stringify({
          client_id: clientId,
          contact_id: buyerId,
          type: "Sale",
          atlas_task_url: MY_TASKS,
          invoice_choice: "pending",
          notes: NOTES,
          lines: [{ product_id: productId, quantity: 1 }],
        }),
      ],
    )
  })
  if (!submit.ok) {
    fail("request_saves_contact_id", submit.error ?? "submit failed")
  } else {
    const reqId = submit.rows[0]?.id
    const row = await db.query(`SELECT contact_id FROM public.stock_requests WHERE id = $1`, [reqId])
    if (row.rows[0]?.contact_id === buyerId) pass("request_saves_contact_id", reqId)
    else fail("request_saves_contact_id", JSON.stringify(row.rows[0]))
  }

  // admin can hard-delete (optional sanity)
  if (contactId) {
    const adminDel = await asUser(adminId, () =>
      attempt(`DELETE FROM public.client_contacts WHERE id = $1`, [contactId]),
    )
    if (adminDel.ok) pass("admin_hard_delete", "ok")
    else fail("admin_hard_delete", adminDel.error ?? "failed")
  }
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-098-ct1-client-contacts.mjs")
if (isMain) {
  runVerifyCli({ markers: MARKERS, timeoutMs: 180_000, label: "098-ct1" }, runChecks)
}
