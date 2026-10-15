/**
 * Apply one or more migration SQL files with COMMIT (production path).
 * Requires APPLY_MIGRATION_COMMIT=1.
 *
 *   APPLY_MIGRATION_COMMIT=1 node --require ./scripts/dev/tls-classic.cjs scripts/apply-migrations-commit.mjs path/to.sql ...
 */
import fs from "fs"
import { createRequire } from "module"

const require = createRequire(import.meta.url)
const { loadEnvLocal } = require("./verify-env.cjs")
const { Client } = require("pg")

async function main() {
  if (process.env.APPLY_MIGRATION_COMMIT !== "1") {
    console.error("Refusing: set APPLY_MIGRATION_COMMIT=1")
    process.exit(1)
  }
  loadEnvLocal()
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
  if (!dbUrl) {
    console.error("Missing SUPABASE_DB_URL or DATABASE_URL")
    process.exit(1)
  }
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
