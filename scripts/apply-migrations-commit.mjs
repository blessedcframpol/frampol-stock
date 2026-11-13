/**
 * Apply one or more migration SQL files with COMMIT.
 * SQL + supabase_migrations.schema_migrations insert run in ONE transaction
 * (both succeed or neither). Refuses versions already recorded.
 *
 * Production (default):
 *   APPLY_MIGRATION_COMMIT=1 node --require ./scripts/dev/tls-classic.cjs \
 *     scripts/apply-migrations-commit.mjs path/to.sql ...
 *   Loads .env.local only; refuses non-production refs.
 *
 * Test:
 *   APPLY_MIGRATION_COMMIT=1 APPLY_MIGRATION_ENV=test node --require ./scripts/dev/tls-classic.cjs \
 *     scripts/apply-migrations-commit.mjs path/to.sql ...
 *   Loads .env.test; refuses production ref.
 */
import fs from "fs"
import { createRequire } from "module"
import path from "path"

const require = createRequire(import.meta.url)
const {
  loadEnvFile,
  loadVerifyEnv,
  resolveHarnessDbUrl,
  projectRefFromUrl,
  PRODUCTION_SUPABASE_REF,
  warnIfWorkingHours,
} = require("./verify-env.cjs")
const { Client } = require("pg")

/** Parse version + name from `20261113100000_foo.sql` or `055b_foo.sql`. */
function parseMigrationFilename(filePath) {
  const base = path.basename(filePath).replace(/\.sql$/i, "")
  const m = base.match(/^(\d{14}|[0-9]{3}[a-z]?)_(.+)$/i)
  if (!m) {
    throw new Error(
      `Cannot parse migration version/name from ${path.basename(filePath)} (expected VERSION_name.sql)`,
    )
  }
  return { version: m[1], name: m[2] }
}

async function main() {
  if (process.env.APPLY_MIGRATION_COMMIT !== "1") {
    console.error("Refusing: set APPLY_MIGRATION_COMMIT=1")
    process.exit(1)
  }

  const target = (process.env.APPLY_MIGRATION_ENV || "production").toLowerCase()
  let dbUrl
  let ref

  if (target === "test") {
    const loaded = loadVerifyEnv({ production: false })
    const resolved = resolveHarnessDbUrl(false)
    dbUrl = resolved.dbUrl
    ref = resolved.ref
    if (resolved.production || ref === PRODUCTION_SUPABASE_REF) {
      throw new Error("APPLY_MIGRATION_ENV=test refuses production")
    }
    console.log(`apply-migrations-commit → test (${loaded.source}) ref=${ref}`)
  } else if (target === "production" || target === "prod") {
    delete process.env.TEST_DATABASE_URL
    const ok = loadEnvFile(path.join(process.cwd(), ".env.local"), { override: true })
    if (!ok) {
      console.error("Missing .env.local (production apply)")
      process.exit(1)
    }
    dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
    if (!dbUrl) {
      console.error("Missing SUPABASE_DB_URL or DATABASE_URL in .env.local")
      process.exit(1)
    }
    ref = projectRefFromUrl(dbUrl)
    if (ref !== PRODUCTION_SUPABASE_REF) {
      console.error(
        `Refusing: production target expected ref ${PRODUCTION_SUPABASE_REF} (got ${ref || "unknown"}). For test use APPLY_MIGRATION_ENV=test.`,
      )
      process.exit(1)
    }
    warnIfWorkingHours()
    console.log(`apply-migrations-commit → production ref=${ref}`)
  } else {
    console.error(`Unknown APPLY_MIGRATION_ENV=${target} (use production|test)`)
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
      const abs = path.resolve(file)
      if (!fs.existsSync(abs)) {
        throw new Error(`Migration file not found: ${file}`)
      }
      const { version, name } = parseMigrationFilename(abs)
      const sql = fs.readFileSync(abs, "utf8")

      console.log(`Applying ${file} (version=${version} name=${name})…`)

      await client.query("BEGIN")
      try {
        const existing = await client.query(
          `SELECT version, name FROM supabase_migrations.schema_migrations WHERE version = $1`,
          [version],
        )
        if (existing.rows.length > 0) {
          throw new Error(
            `Refusing: version ${version} already recorded` +
              (existing.rows[0].name ? ` as ${existing.rows[0].name}` : ""),
          )
        }

        await client.query(sql)
        await client.query(
          `INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
           VALUES ($1, $2, $3)`,
          [version, name, [`-- applied by scripts/apply-migrations-commit.mjs from ${path.basename(abs)}`]],
        )
        await client.query("COMMIT")
        console.log(`Applied + recorded ${version} (${name})`)
      } catch (err) {
        await client.query("ROLLBACK")
        throw err
      }
    }
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
