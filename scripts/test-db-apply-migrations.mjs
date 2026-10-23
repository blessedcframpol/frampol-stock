/**
 * Apply every supabase/migrations/*.sql file (sorted) to the TEST database.
 * Also applies supabase/schema.sql first as the pre-migration baseline
 * (repo migrations assume core tables already exist).
 *
 *   node --require ./scripts/dev/tls-classic.cjs scripts/test-db-apply-migrations.mjs
 *
 * Never touches production.
 */
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { createRequire } from "module"

const require = createRequire(import.meta.url)
const { Client } = require("pg")
const { loadVerifyEnv, resolveHarnessDbUrl, PRODUCTION_SUPABASE_REF } = require("./verify-env.cjs")

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")
const migrationsDir = path.join(root, "supabase", "migrations")
const schemaPath = path.join(root, "supabase", "schema.sql")

function listMigrations() {
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql") && !f.includes(".DRAFT"))
    .sort((a, b) => a.localeCompare(b, "en"))
}

async function applyFile(client, absPath, label) {
  const sql = fs.readFileSync(absPath, "utf8")
  if (!sql.trim()) {
    return { ok: true, skipped: true, label, reason: "empty" }
  }
  try {
    await client.query(sql)
    return { ok: true, label }
  } catch (error) {
    // Multi-statement failures leave the session in an aborted txn; clear it.
    try {
      await client.query("ROLLBACK")
    } catch {
      /* idle / no txn */
    }
    return {
      ok: false,
      label,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

async function main() {
  const loaded = loadVerifyEnv({ production: false })
  const { dbUrl, production, ref } = resolveHarnessDbUrl(false)
  if (production || ref === PRODUCTION_SUPABASE_REF) {
    throw new Error("test-db-apply-migrations refuses production")
  }
  console.log(`test-db-apply-migrations → ${loaded.source} ref=${ref}`)

  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20_000,
  })
  try {
    await client.connect()
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (error?.code === "28P01" || /password authentication failed/i.test(msg)) {
      throw new Error(
        `TEST_DATABASE_URL password rejected for ref ${ref}. In Supabase Dashboard → Project Settings → Database, reset the DB password if needed, copy the Session pooler URI, and set TEST_DATABASE_URL in .env.test.`,
      )
    }
    throw error
  }

  const results = []
  try {
    if (fs.existsSync(schemaPath)) {
      console.log("Applying bootstrap supabase/schema.sql …")
      const r = await applyFile(client, schemaPath, "schema.sql (bootstrap)")
      results.push(r)
      console.log(r.ok ? `  OK  ${r.label}` : `  FAIL ${r.label}: ${r.reason}`)
    }

    const files = listMigrations()
    console.log(`Applying ${files.length} migration files …`)
    for (const file of files) {
      const abs = path.join(migrationsDir, file)
      process.stdout.write(`  ${file} … `)
      const r = await applyFile(client, abs, file)
      results.push(r)
      if (r.ok) console.log("OK")
      else console.log(`FAIL\n    ${r.reason.split("\n")[0]}`)
    }
  } finally {
    await client.end()
  }

  const failed = results.filter((r) => !r.ok)
  console.log("\n========== migration apply summary ==========")
  console.log(`${results.length - failed.length} ok, ${failed.length} failed`)
  if (failed.length) {
    console.log("\nFailed:")
    for (const f of failed) {
      console.log(`- ${f.label}`)
      console.log(`  ${f.reason.split("\n")[0]}`)
    }
  }
  process.exitCode = failed.length ? 1 : 0
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
