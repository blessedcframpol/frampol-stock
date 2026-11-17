/**
 * Seed CT1 QA fixtures on the test project for screenshots.
 *   node --require ./scripts/dev/tls-classic.cjs scripts/dev/ct1-qa-seed.mjs
 * Refuses any project other than the test ref (czowbmhtunbjnpcvvyap).
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"
import { createClient } from "@supabase/supabase-js"
import pg from "pg"

const require = createRequire(import.meta.url)
const {
  loadVerifyEnv,
  projectRefFromUrl,
  resolveHarnessDbUrl,
  PRODUCTION_SUPABASE_REF,
  TEST_SUPABASE_REF_HINT,
} = require("../verify-env.cjs")

loadVerifyEnv({ production: false })

const TEST_REF = TEST_SUPABASE_REF_HINT || "czowbmhtunbjnpcvvyap"
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const service = process.env.SUPABASE_SERVICE_ROLE_KEY
const dbUrl = process.env.TEST_DATABASE_URL || process.env.SUPABASE_DB_URL
if (!url || !anon || !service || !dbUrl) throw new Error("missing test env")

const apiRef = projectRefFromUrl(url)
const { ref: dbRef, production } = resolveHarnessDbUrl(false)
if (
  production ||
  apiRef === PRODUCTION_SUPABASE_REF ||
  dbRef === PRODUCTION_SUPABASE_REF ||
  apiRef !== TEST_REF ||
  dbRef !== TEST_REF
) {
  throw new Error(
    `ct1-qa-seed refuses non-test project (api=${apiRef || "unknown"} db=${dbRef || "unknown"}; expected ${TEST_REF})`,
  )
}

const stamp = Date.now().toString(36)
const email = `ct1-qa-${stamp}@test.local`
const password = `Ct1Qa-${stamp}!`
const clientId = `CLT-ct1-qa-${stamp}`
const contactEmail = `ct1-buyer-${stamp}@test.local`
const atlas =
  "https://ai.frampolafrica.com:10801/my-tasks?view=all&task=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

const admin = createClient(url, service, { auth: { autoRefreshToken: false, persistSession: false } })
const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
if (created.error) throw created.error
const userId = created.data.user.id

const db = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
await db.connect()
let contactId
let productId
try {
  // Admin so /clients and /search screenshots are reachable (sales lands on /requests).
  await db.query(
    `INSERT INTO public.profiles (id, email, role, active, display_name)
     VALUES ($1, $2, 'admin', true, 'CT1 QA Admin')
     ON CONFLICT (id) DO UPDATE SET role = 'admin', active = true, email = EXCLUDED.email`,
    [userId, email],
  )
  await db.query(
    `INSERT INTO public.clients (id, name, company, email, phone, address, sites)
     VALUES ($1, 'CT1 QA Contact', 'CT1 QA Co', $2, '0771118001',
             '12 Harness Example Street, Harare',
             $3::jsonb)`,
    [
      clientId,
      `ct1-main-${stamp}@test.local`,
      JSON.stringify([{ address: "12 Harness Example Street, Harare" }]),
    ],
  )
  const contact = await db.query(
    `INSERT INTO public.client_contacts (client_id, name, role, email, phone, is_primary, notes, created_by)
     VALUES ($1, 'Buyer Person', 'buyer', $2, '0772228001', true, 'ct1-qa', $3)
     RETURNING id`,
    [clientId, contactEmail, userId],
  )
  contactId = contact.rows[0].id
  const product = await db.query(
    `SELECT id FROM public.product_lines
     WHERE is_active IS TRUE AND lower(coalesce(vendor, '')) <> 'fortinet'
     ORDER BY product_name LIMIT 1`,
  )
  productId = product.rows[0].id
} finally {
  await db.end()
}

const browser = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } })
const signed = await browser.auth.signInWithPassword({ email, password })
if (signed.error) throw signed.error

const submit = await browser.rpc("submit_request", {
  p_payload: {
    client_id: clientId,
    contact_id: contactId,
    type: "Sale",
    atlas_task_url: atlas,
    invoice_choice: "pending",
    notes: "ct1-qa",
    lines: [{ product_id: productId, quantity: 1 }],
  },
})
if (submit.error) {
  console.error("submit failed", submit.error)
  process.exit(1)
}

const out = {
  email,
  password,
  userId,
  clientId,
  contactId,
  contactEmail,
  requestId: submit.data,
  clientPath: `/clients/${clientId}`,
  requestPath: `/requests/${submit.data}`,
  newRequestPath: `/requests/new`,
  searchQ: contactEmail.split("@")[0],
}
const outDir = path.join(process.cwd(), "docs/qa/ct1")
fs.mkdirSync(outDir, { recursive: true })
const sessionPath = path.join(outDir, "seed-session.json")
const publicPath = path.join(outDir, "seed.json")
fs.writeFileSync(sessionPath, JSON.stringify(out, null, 2))
fs.writeFileSync(
  publicPath,
  JSON.stringify(
    {
      clientId: out.clientId,
      contactId: out.contactId,
      contactEmail: out.contactEmail,
      requestId: out.requestId,
      clientPath: out.clientPath,
      requestPath: out.requestPath,
      newRequestPath: out.newRequestPath,
      searchQ: out.searchQ,
    },
    null,
    2,
  ),
)
console.log(JSON.stringify(out, null, 2))
console.log("wrote", sessionPath)
