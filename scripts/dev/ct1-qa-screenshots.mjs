/**
 * CT1 QA screenshots → docs/qa/ct1/
 *   node --require ./scripts/dev/tls-classic.cjs scripts/dev/ct1-qa-screenshots.mjs
 * Refuses any project other than the test ref (czowbmhtunbjnpcvvyap).
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"
import { createClient } from "@supabase/supabase-js"
import pg from "pg"
import { chromium } from "playwright"

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
const root = process.cwd()
const outDir = path.join(root, "docs/qa/ct1")
fs.mkdirSync(outDir, { recursive: true })

const sessionPath = path.join(outDir, "seed-session.json")
if (!fs.existsSync(sessionPath)) {
  throw new Error("missing docs/qa/ct1/seed-session.json — run ct1-qa-seed.mjs first")
}
const seed = JSON.parse(fs.readFileSync(sessionPath, "utf8"))
const projectRef = TEST_REF
const base = process.env.VERIFY_APP_URL || "http://localhost:3000"
const host = new URL(base).hostname

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const apiRef = projectRefFromUrl(url || "")
const { ref: dbRef, production } = resolveHarnessDbUrl(false)
if (
  production ||
  apiRef === PRODUCTION_SUPABASE_REF ||
  dbRef === PRODUCTION_SUPABASE_REF ||
  apiRef !== TEST_REF ||
  dbRef !== TEST_REF
) {
  throw new Error(
    `ct1-qa-screenshots refuses non-test project (api=${apiRef || "unknown"} db=${dbRef || "unknown"}; expected ${TEST_REF})`,
  )
}
const browserSb = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } })
const signed = await browserSb.auth.signInWithPassword({
  email: seed.email,
  password: seed.password,
})
if (signed.error || !signed.data.session) throw signed.error || new Error("signIn failed")
const session = signed.data.session

const payload = {
  access_token: session.access_token,
  refresh_token: session.refresh_token,
  expires_at: session.expires_at,
  expires_in: session.expires_in ?? 3600,
  token_type: "bearer",
  user: session.user,
}
const cookieVal = "base64-" + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
console.log("cookieLen", cookieVal.length)

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.addCookies([
  {
    name: `sb-${projectRef}-auth-token`,
    value: cookieVal,
    domain: host,
    path: "/",
    httpOnly: false,
    secure: false,
    sameSite: "Lax",
  },
])

const page = await context.newPage()
page.on("console", (msg) => {
  if (msg.type() === "error") console.log("console.error", msg.text().slice(0, 200))
})

async function shot(name, pathname, readyText) {
  await page.goto(`${base}${pathname}`, { waitUntil: "domcontentloaded", timeout: 60_000 })
  if (readyText) {
    try {
      await page.getByText(readyText, { exact: false }).first().waitFor({ timeout: 45_000 })
    } catch (e) {
      console.warn("ready wait failed for", name, String(e).slice(0, 120))
      await page.waitForTimeout(3000)
    }
  } else {
    await page.waitForTimeout(4000)
  }
  const dest = path.join(outDir, `${name}.png`)
  await page.screenshot({ path: dest, fullPage: true })
  console.log("wrote", dest, "url=", page.url())
}

await shot("client-detail-contacts", seed.clientPath, "Buyer Person")

await page.goto(`${base}${seed.newRequestPath}`, { waitUntil: "domcontentloaded", timeout: 60_000 })
await page.getByText("Contact (buyer)", { exact: false }).first().waitFor({ timeout: 45_000 }).catch(() => {})
const clientTrigger = page.getByRole("combobox").filter({ hasText: /Search existing client|CT1 QA/i }).first()
await clientTrigger.click({ timeout: 20_000 }).catch(async () => {
  await page.getByText(/Search existing client/i).first().click({ timeout: 10_000 })
})
await page.waitForTimeout(400)
const clientSearch = page.getByPlaceholder(/Search clients/i)
await clientSearch.fill("CT1 QA Contact")
await page.waitForTimeout(900)
await page.getByText("CT1 QA Contact", { exact: false }).first().click({ timeout: 15_000 })
await page.waitForTimeout(900)
await page.getByText("Buyer Person", { exact: false }).first().waitFor({ timeout: 20_000 }).catch(() => {})
await page.screenshot({
  path: path.join(outDir, "new-request-contact-picker.png"),
  fullPage: true,
})
console.log("wrote new-request-contact-picker.png")

await shot("search-contact-email", `/search?q=${encodeURIComponent(seed.searchQ)}`, "via contact")

// Archive the contact after it was used on the request — detail should show "(archived)".
const dbUrl = process.env.TEST_DATABASE_URL || process.env.SUPABASE_DB_URL
const db = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
await db.connect()
try {
  await db.query(
    `UPDATE public.client_contacts SET active = false, is_primary = false WHERE id = $1`,
    [seed.contactId],
  )
} finally {
  await db.end()
}
await shot("request-detail-buyer", seed.requestPath, "Buyer Person (archived)")

await browser.close()
console.log("done")
