/**
 * Copy table/view/function privilege grants from production onto test (best-effort).
 */
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { createRequire } from "module"

const require = createRequire(import.meta.url)
const { Client } = require("pg")
const { projectRefFromUrl, PRODUCTION_SUPABASE_REF } = require("./verify-env.cjs")

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function parse(file) {
  const out = {}
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[match[1]] = value
  }
  return out
}

const prodEnv = parse(path.join(root, ".env.local"))
const testEnv = parse(path.join(root, ".env.test"))
const prodUrl = prodEnv.SUPABASE_DB_URL || prodEnv.DATABASE_URL
const testUrl = testEnv.TEST_DATABASE_URL || testEnv.DATABASE_URL
if (projectRefFromUrl(prodUrl) !== PRODUCTION_SUPABASE_REF) throw new Error("not prod")
if (projectRefFromUrl(testUrl) === PRODUCTION_SUPABASE_REF) throw new Error("test is prod")

const prod = new Client({ connectionString: prodUrl, ssl: { rejectUnauthorized: false } })
const test = new Client({ connectionString: testUrl, ssl: { rejectUnauthorized: false } })
await prod.connect()
await test.connect()
try {
  // Reset broad grants we applied during clone
  await test.query(`
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated, PUBLIC;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated, PUBLIC;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, PUBLIC;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role, postgres;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role, postgres;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, service_role;
  `)

  const grants = await prod.query(`
    SELECT table_name, grantee, privilege_type, table_schema
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND grantee IN ('anon', 'authenticated', 'service_role')
    ORDER BY table_name, grantee, privilege_type
  `)

  let ok = 0
  let fail = 0
  for (const g of grants.rows) {
    try {
      await test.query(
        `GRANT ${g.privilege_type} ON TABLE public."${g.table_name}" TO ${g.grantee}`,
      )
      ok++
    } catch (e) {
      fail++
      if (fail <= 15) console.log("FAIL grant", g.table_name, g.grantee, g.privilege_type, e.message.split("\n")[0])
    }
  }
  console.log(`table grants applied: ${ok} ok, ${fail} failed (of ${grants.rows.length})`)

  // Views that should be locked: revoke from anon/authenticated if prod has no SELECT
  const views = await prod.query(`
    SELECT c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('v','m')
  `)
  for (const v of views.rows) {
    const has = await prod.query(
      `
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema='public' AND table_name=$1 AND grantee='authenticated' AND privilege_type='SELECT'
    `,
      [v.name],
    )
    if (has.rows.length === 0) {
      await test.query(`REVOKE ALL ON TABLE public."${v.name}" FROM anon, authenticated`).catch(() => {})
    }
  }
  console.log("locked views revoked where prod has no authenticated SELECT")
} finally {
  await prod.end()
  await test.end()
}
