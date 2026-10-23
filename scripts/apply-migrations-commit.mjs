/**
 * Apply one or more migration SQL files with COMMIT (production path only).
 * Requires APPLY_MIGRATION_COMMIT=1. Loads .env.local — never .env.test.
 *
 *   APPLY_MIGRATION_COMMIT=1 node --require ./scripts/dev/tls-classic.cjs scripts/apply-migrations-commit.mjs path/to.sql ...
 */
import fs from "fs"
import { createRequire } from "module"

const require = createRequire(import.meta.url)
const {
  loadEnvFile,
  projectRefFromUrl,
  PRODUCTION_SUPABASE_REF,
  warnIfWorkingHours,
} = require("./verify-env.cjs")
const { Client } = require("pg")
const path = require("path")

async function main() {
  if (process.env.APPLY_MIGRATION_COMMIT !== "1") {
    console.error("Refusing: set APPLY_MIGRATION_COMMIT=1")
    process.exit(1)
  }
  // Production-only: ignore .env.test / TEST_DATABASE_URL.
  delete process.env.TEST_DATABASE_URL
  const ok = loadEnvFile(path.join(process.cwd(), ".env.local"), { override: true })
  if (!ok) {
    console.error("Missing .env.local (apply-migrations-commit is production-only)")
    process.exit(1)
  }
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
  if (!dbUrl) {
    console.error("Missing SUPABASE_DB_URL or DATABASE_URL in .env.local")
    process.exit(1)
  }
  const ref = projectRefFromUrl(dbUrl)
  if (ref !== PRODUCTION_SUPABASE_REF) {
    console.error(
      `Refusing: apply-migrations-commit targets production only (got ref ${ref || "unknown"}, expected ${PRODUCTION_SUPABASE_REF}). For the test DB use scripts/test-db-apply-migrations.mjs.`,
    )
    process.exit(1)
  }
  warnIfWorkingHours()

  const files = process.argv.slice(2)
  if (files.length === 0) {
    console.error("Usage: apply-migrations-commit.mjs <migration.sql> ...")
    process.exit(1)
  }

  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
  await client.connect()
  try {
    for (const file of files) {
      const sql = fs.readFileSync(file, "utf8")
      console.log(`Applying ${file}…`)
      await client.query(sql)
      console.log(`Applied ${file}`)
    }
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
