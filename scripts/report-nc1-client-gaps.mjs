/**
 * NC1 report-only — counts existing clients that would fail new-client rules (by rule).
 * Does not modify data.
 *
 *   node --require ./scripts/dev/tls-classic.cjs scripts/report-nc1-client-gaps.mjs
 */
import { createRequire } from "module"

const require = createRequire(import.meta.url)
const { loadEnvLocal } = require("./verify-env.cjs")
const { Client } = require("pg")

loadEnvLocal()
const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
if (!dbUrl) {
  console.error("Missing SUPABASE_DB_URL")
  process.exit(1)
}

async function main() {
  const db = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
  await db.connect()
  try {
    const frampol = await db.query(
      `SELECT id, name, company, email, phone
       FROM public.clients
       WHERE lower(coalesce(name, '')) LIKE '%frampol%inves%'
          OR lower(coalesce(company, '')) LIKE '%frampol%inves%'`,
    )
    console.log("\n=== Frampol Investments spelling (manual review) ===")
    for (const r of frampol.rows) {
      console.log(`  ${r.id} | name=${r.name} | company=${r.company}`)
    }
    console.log(`  count: ${frampol.rowCount}`)

    const counts = await db.query(`
      SELECT
        count(*) FILTER (WHERE public.client_is_placeholder(name)) AS bad_name,
        count(*) FILTER (WHERE public.client_is_placeholder(email)) AS bad_email,
        count(*) FILTER (WHERE public.client_email_problem(email) IS NOT NULL) AS email_rule,
        count(*) FILTER (WHERE public.client_phone_problem(phone) IS NOT NULL) AS phone_rule,
        count(*) FILTER (WHERE public.client_sites_have_valid_primary(sites, address) IS NOT NULL) AS address_rule,
        count(*) AS total
      FROM public.clients
    `)
    console.log("\n=== Existing clients failing NC1 checks (would block NEW insert) ===")
    console.log(counts.rows[0])
  } finally {
    await db.end()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
