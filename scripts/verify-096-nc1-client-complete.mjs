/**
 * NC1 — client completeness trigger + duplicate lookup.
 *
 *   node scripts/rehearse-migration.mjs supabase/migrations/20261015120000_nc1_client_complete.sql scripts/verify-096-nc1-client-complete.mjs
 */
import { runVerifyCli } from "./verify-harness.mjs"

const NOTES = "harness-096"
const EMAIL = "harness-096-"
const TASK_EMAIL = `${EMAIL}new@test.local`
const TASK_PHONE = "0771234567"

export const MARKERS = [
  {
    label: "clients",
    sql: `SELECT count(*)::int AS n FROM public.clients WHERE id LIKE $1`,
    params: [`CLT-${NOTES}%`],
  },
]

function stamp() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function goodPayload(suffix) {
  return {
    id: `CLT-${NOTES}-${suffix}-${stamp()}`,
    name: `Harness Contact ${suffix}`,
    company: `Harness Co ${suffix}`,
    email: `${EMAIL}${suffix}@test.local`,
    phone: TASK_PHONE,
    address: "12 Example Street, Harare",
    sites: [{ name: "HQ", address: "12 Example Street, Harare" }],
    total_orders: 0,
    total_spent: 0,
    last_order: null,
  }
}

export async function runChecks(ctx) {
  const { db, pass, fail, asUser } = ctx
  await db.query(`SET LOCAL statement_timeout = '120s'`)

  const salesId = await ctx.createFixtureUser("sales", `${EMAIL}sales@test.local`)

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

  const badEmail = await attempt(
    `INSERT INTO public.clients (id, name, company, email, phone, address, sites)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      goodPayload("bad").id,
      "Harness Bad",
      "Harness Co",
      "N/A",
      TASK_PHONE,
      "12 Example Street, Harare",
      JSON.stringify([{ address: "12 Example Street, Harare" }]),
    ],
  )
  if (!badEmail.ok) pass("placeholder_email_rejected", badEmail.error?.slice(0, 60) ?? "rejected")
  else fail("placeholder_email_rejected", "inserted")

  const individual = goodPayload("ind")
  individual.company = null
  individual.name = "Harness Individual"
  individual.email = `${EMAIL}ind@test.local`
  const indOk = await attempt(
    `INSERT INTO public.clients (id, name, company, email, phone, address, sites)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      individual.id,
      individual.name,
      null,
      individual.email,
      individual.phone,
      individual.address,
      JSON.stringify(individual.sites),
    ],
  )
  if (indOk.ok) pass("individual_insert", individual.id)
  else fail("individual_insert", indOk.error ?? "failed")

  const company = goodPayload("co")
  const coOk = await attempt(
    `INSERT INTO public.clients (id, name, company, email, phone, address, sites)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      company.id,
      company.name,
      company.company,
      company.email,
      company.phone,
      company.address,
      JSON.stringify(company.sites),
    ],
  )
  if (coOk.ok) pass("company_insert", company.id)
  else fail("company_insert", coOk.error ?? "failed")

  const legacyId = `CLT-${NOTES}-legacy-${stamp()}`
  await db.query(`ALTER TABLE public.clients DISABLE TRIGGER tr_clients_nc1_validate`)
  await db.query(
    `INSERT INTO public.clients (id, name, company, email, phone, address, sites)
     VALUES ($1, 'Legacy', 'Legacy Co', 'bad-email', 'N/A', 'N/A', $2::jsonb)`,
    [legacyId, JSON.stringify([{ address: "N/A" }])],
  )
  await db.query(`ALTER TABLE public.clients ENABLE TRIGGER tr_clients_nc1_validate`)

  const legacyPhone = await attempt(
    `UPDATE public.clients SET phone = $2 WHERE id = $1`,
    [legacyId, "0779876543"],
  )
  if (legacyOk(legacyPhone)) pass("legacy_partial_update", legacyId)
  else fail("legacy_partial_update", legacyPhone.error ?? "failed")

  function legacyOk(r) {
    return r.ok
  }

  const dup = await asUser(salesId, () =>
    attempt(`SELECT * FROM public.find_client_duplicate_candidates($1, $2, $3)`, [
      company.email,
      company.phone,
      company.name,
    ]),
  )
  if (dup.ok && dup.rows.some((r) => r.id === company.id)) {
    pass("duplicate_lookup", company.id)
  } else {
    fail("duplicate_lookup", JSON.stringify(dup.rows ?? dup.error))
  }

  const landline = goodPayload("land")
  landline.phone = "0242123456"
  const landOk = await attempt(
    `INSERT INTO public.clients (id, name, company, email, phone, address, sites)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      landline.id,
      landline.name,
      landline.company,
      landline.email,
      landline.phone,
      landline.address,
      JSON.stringify(landline.sites),
    ],
  )
  if (landOk.ok) {
    const norm = await db.query(`SELECT phone FROM public.clients WHERE id = $1`, [landline.id])
    if (norm.rows[0]?.phone === "+263242123456") pass("phone_local_02", norm.rows[0].phone)
    else fail("phone_local_02", norm.rows[0]?.phone ?? "missing")
  } else fail("phone_local_02", landOk.error ?? "insert failed")

  const sa = goodPayload("za")
  sa.phone = "+27 82 123 4567"
  const saOk = await attempt(
    `INSERT INTO public.clients (id, name, company, email, phone, address, sites)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [sa.id, sa.name, sa.company, sa.email, sa.phone, sa.address, JSON.stringify(sa.sites)],
  )
  if (saOk.ok) {
    const norm = await db.query(`SELECT phone FROM public.clients WHERE id = $1`, [sa.id])
    if (norm.rows[0]?.phone === "+27821234567") pass("phone_za", norm.rows[0].phone)
    else fail("phone_za", norm.rows[0]?.phone ?? "missing")
  } else fail("phone_za", saOk.error ?? "insert failed")

  const zm = goodPayload("zm")
  zm.phone = "+260 97 123 4567"
  const zmOk = await attempt(
    `INSERT INTO public.clients (id, name, company, email, phone, address, sites)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [zm.id, zm.name, zm.company, zm.email, zm.phone, zm.address, JSON.stringify(zm.sites)],
  )
  if (zmOk.ok) {
    const norm = await db.query(`SELECT phone FROM public.clients WHERE id = $1`, [zm.id])
    if (norm.rows[0]?.phone === "+260971234567") pass("phone_zm", norm.rows[0].phone)
    else fail("phone_zm", norm.rows[0]?.phone ?? "missing")
  } else fail("phone_zm", zmOk.error ?? "insert failed")

  const badPhone = await attempt(
    `INSERT INTO public.clients (id, name, company, email, phone, address, sites)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      goodPayload("phbad").id,
      "Harness Bad Phone",
      "Harness Co",
      `${EMAIL}phbad@test.local`,
      "N/A",
      "12 Example Street, Harare",
      JSON.stringify([{ address: "12 Example Street, Harare" }]),
    ],
  )
  if (!badPhone.ok) pass("placeholder_phone_rejected", badPhone.error?.slice(0, 60) ?? "rejected")
  else fail("placeholder_phone_rejected", "inserted")

  // --- duplicate_override_reason ---
  const adminId = await ctx.createFixtureUser("admin", `${EMAIL}admin@test.local`)
  const reasonText = "Separate billing entity despite same phone"

  const overrideAsAdmin = await asUser(adminId, () =>
    attempt(
      `INSERT INTO public.clients (id, name, company, email, phone, address, sites, duplicate_override_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        goodPayload("ovr").id,
        "Harness Override",
        "Harness Override Co",
        `${EMAIL}ovr@test.local`,
        "0771112233",
        "12 Example Street, Harare",
        JSON.stringify([{ address: "12 Example Street, Harare" }]),
        reasonText,
      ],
    ),
  )
  if (overrideAsAdmin.ok) {
    const stored = await db.query(
      `SELECT duplicate_override_reason FROM public.clients WHERE email = $1`,
      [`${EMAIL}ovr@test.local`],
    )
    if (stored.rows[0]?.duplicate_override_reason === reasonText) {
      pass("override_reason_stored", reasonText)
    } else {
      fail("override_reason_stored", JSON.stringify(stored.rows[0] ?? null))
    }
  } else {
    fail("override_reason_stored", overrideAsAdmin.error ?? "insert failed")
  }

  const normalCreate = await attempt(
    `INSERT INTO public.clients (id, name, company, email, phone, address, sites)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      goodPayload("norm").id,
      "Harness Normal",
      "Harness Normal Co",
      `${EMAIL}norm@test.local`,
      "0771113344",
      "12 Example Street, Harare",
      JSON.stringify([{ address: "12 Example Street, Harare" }]),
    ],
  )
  if (normalCreate.ok) {
    const stored = await db.query(
      `SELECT duplicate_override_reason FROM public.clients WHERE email = $1`,
      [`${EMAIL}norm@test.local`],
    )
    if (stored.rows[0]?.duplicate_override_reason == null) pass("override_null_on_normal", "null")
    else fail("override_null_on_normal", JSON.stringify(stored.rows[0]))
  } else {
    fail("override_null_on_normal", normalCreate.error ?? "insert failed")
  }

  const shortReason = await asUser(adminId, () =>
    attempt(
      `INSERT INTO public.clients (id, name, company, email, phone, address, sites, duplicate_override_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        goodPayload("short").id,
        "Harness Short",
        "Harness Short Co",
        `${EMAIL}short@test.local`,
        "0771114455",
        "12 Example Street, Harare",
        JSON.stringify([{ address: "12 Example Street, Harare" }]),
        "too short",
      ],
    ),
  )
  if (!shortReason.ok && /at least 10/i.test(shortReason.error ?? "")) {
    pass("override_short_rejected", shortReason.error.slice(0, 80))
  } else if (!shortReason.ok) {
    pass("override_short_rejected", shortReason.error?.slice(0, 80) ?? "rejected")
  } else {
    fail("override_short_rejected", "inserted")
  }

  const salesSetsReason = await asUser(salesId, () =>
    attempt(
      `INSERT INTO public.clients (id, name, company, email, phone, address, sites, duplicate_override_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        goodPayload("salesovr").id,
        "Harness Sales Ovr",
        "Harness Sales Ovr Co",
        `${EMAIL}salesovr@test.local`,
        "0771115566",
        "12 Example Street, Harare",
        JSON.stringify([{ address: "12 Example Street, Harare" }]),
        reasonText,
      ],
    ),
  )
  if (!salesSetsReason.ok && /admin/i.test(salesSetsReason.error ?? "")) {
    pass("override_non_admin_insert_refused", salesSetsReason.error.slice(0, 80))
  } else if (!salesSetsReason.ok) {
    pass("override_non_admin_insert_refused", salesSetsReason.error?.slice(0, 80) ?? "rejected")
  } else {
    fail("override_non_admin_insert_refused", "inserted")
  }

  const ovrId = (
    await db.query(`SELECT id FROM public.clients WHERE email = $1`, [`${EMAIL}ovr@test.local`])
  ).rows[0]?.id
  if (ovrId) {
    const alter = await asUser(adminId, () =>
      attempt(`UPDATE public.clients SET duplicate_override_reason = $2 WHERE id = $1`, [
        ovrId,
        "Changed after create which must fail",
      ]),
    )
    if (!alter.ok && /cannot be changed/i.test(alter.error ?? "")) {
      pass("override_immutable_on_update", alter.error.slice(0, 80))
    } else if (!alter.ok) {
      pass("override_immutable_on_update", alter.error?.slice(0, 80) ?? "rejected")
    } else {
      fail("override_immutable_on_update", "updated")
    }
  } else {
    fail("override_immutable_on_update", "missing override row")
  }
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-096-nc1-client-complete.mjs")
if (isMain) {
  runVerifyCli({ markers: MARKERS, timeoutMs: 120_000, label: "096-nc1" }, runChecks)
}
