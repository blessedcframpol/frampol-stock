/**
 * Rehearse a migration inside BEGIN … ROLLBACK, then optionally run a paired
 * harness verify in the same transaction. Never commits.
 *
 * Usage:
 *   node scripts/rehearse-migration.mjs <migration.sql> [verify-script.mjs]
 *
 * Only after a passing rehearsal should the migration be applied for real
 * (supabase db push / MCP apply_migration / existing path).
 */
import fs from "fs"
import path from "path"
import { pathToFileURL } from "url"
import { createRequire } from "module"
import { withHarness, prepareVerifyEnv } from "./verify-harness.mjs"

const require = createRequire(import.meta.url)
const { Client } = require("pg")

function usage() {
  console.error("Usage: node scripts/rehearse-migration.mjs <migration.sql> [verify-script.mjs]")
  process.exit(2)
}

async function main() {
  const migrationPath = process.argv[2]
  const verifyPath = process.argv[3]
  if (!migrationPath) usage()
  const absMigration = path.resolve(migrationPath)
  if (!fs.existsSync(absMigration)) {
    throw new Error(`Migration file not found: ${absMigration}`)
  }
  const sql = fs.readFileSync(absMigration, "utf8")
  if (!sql.trim()) throw new Error("Migration file is empty")

  let runChecks = null
  let markers = [
    { label: "rehearsal_noop", sql: "SELECT 0::int AS n", params: [] },
  ]
  if (verifyPath) {
    const absVerify = path.resolve(verifyPath)
    const mod = await import(pathToFileURL(absVerify).href)
    if (typeof mod.runChecks !== "function") {
      throw new Error(`${absVerify} must export async function runChecks(ctx) for rehearsal`)
    }
    runChecks = mod.runChecks
    if (Array.isArray(mod.MARKERS) && mod.MARKERS.length > 0) markers = mod.MARKERS
  }

  const { dbUrl } = prepareVerifyEnv({ harness: true })

  // When a verify is paired, reuse withHarness so markers/totals/audit are checked.
  if (runChecks) {
    const { ok, failed, passed, results } = await withHarness(
      {
        markers,
        timeoutMs: 300_000,
        label: `rehearse:${path.basename(absMigration)}`,
      },
      async (ctx) => {
        console.log(`REHEARSE  applying ${path.basename(absMigration)} inside transaction…`)
        await ctx.db.query(sql)
        ctx.pass("migration_sql", "applied inside transaction")
        await runChecks(ctx)
      },
    )

    // If markers was empty noop, withHarness requires markers — we always pass at least noop.
    console.log(ok ? `\nREHEARSE PASS (${passed})` : `\nREHEARSE FAIL (${failed})`)
    if (!ok) {
      const fails = Object.entries(results)
        .filter(([, v]) => v.result === "FAIL")
        .map(([k, v]) => `  ${k}: ${v.reason}`)
      console.log(fails.join("\n"))
    }
    process.exitCode = ok ? 0 : 1
    return
  }

  // Migration-only rehearsal (no paired verify).
  const db = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
  await db.connect()
  let ok = false
  try {
    await db.query("BEGIN")
    try {
      await db.query(sql)
      console.log(`PASS  migration_sql — applied ${path.basename(absMigration)} inside transaction`)
      ok = true
    } catch (error) {
      console.log(`FAIL  migration_sql — ${error instanceof Error ? error.message : String(error)}`)
    }
  } finally {
    await db.query("ROLLBACK")
    console.log("REHEARSE  rolled back (nothing applied)")
    await db.end()
  }
  console.log(ok ? "\nREHEARSE PASS" : "\nREHEARSE FAIL")
  process.exitCode = ok ? 0 : 1
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
