/**
 * Copy production public-schema data (read-only) into the test DB, scrambling
 * personal fields on clients and profiles. Products, inventory, transactions,
 * requests and counts stay real (same ids / numbers).
 *
 *   npm run test-db:refresh
 *
 * Never writes to production.
 */
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { createRequire } from "module"
import crypto from "crypto"

const require = createRequire(import.meta.url)
const { Client } = require("pg")
const { projectRefFromUrl, PRODUCTION_SUPABASE_REF } = require("./verify-env.cjs")

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")

function parseEnv(file) {
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

function hashTag(id) {
  return crypto.createHash("sha256").update(String(id)).digest("hex").slice(0, 8)
}

function asJsonValue(value) {
  if (value == null) return null
  if (typeof value === "string") {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
}

function scrambleClient(row) {
  const tag = hashTag(row.id)
  const rawSites = asJsonValue(row.sites)
  const sites = Array.isArray(rawSites)
    ? rawSites.map((s, i) => ({
        ...(s && typeof s === "object" ? s : {}),
        name: s?.name ? `Site ${tag}-${i + 1}` : s?.name,
        address: `Scrambled Address ${tag}-${i + 1}, Harare`,
      }))
    : rawSites
  return {
    ...row,
    name: `Contact ${tag}`,
    company: row.company == null || row.company === "" ? row.company : `Company ${tag}`,
    email: `client-${tag}@example.test`,
    phone: `+2637711${String(parseInt(tag.slice(0, 4), 16) % 100000).padStart(5, "0")}`,
    address: row.address == null ? null : `Scrambled Address ${tag}, Harare`,
    sites,
  }
}

function scrambleProfile(row) {
  const tag = hashTag(row.id)
  return {
    ...row,
    email: `user-${tag}@example.test`,
    display_name: row.display_name == null ? null : `User ${tag}`,
  }
}

async function listPublicTables(db) {
  const r = await db.query(`
    SELECT c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname NOT LIKE 'pg_%'
    ORDER BY c.relname
  `)
  return r.rows.map((x) => x.name)
}

async function tableColumns(db, table) {
  const r = await db.query(
    `
    SELECT column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `,
    [table],
  )
  return r.rows
}

async function primaryKeyColumns(db, table) {
  const r = await db.query(
    `
    SELECT a.attname AS name
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = $1 AND i.indisprimary
    ORDER BY array_position(i.indkey, a.attnum)
  `,
    [table],
  )
  return r.rows.map((x) => x.name)
}

async function identityColumns(db, table) {
  const r = await db.query(
    `
    SELECT a.attname AS name
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = $1
      AND a.attnum > 0 AND NOT a.attisdropped
      AND a.attidentity IN ('a', 'd')
  `,
    [table],
  )
  return new Set(r.rows.map((x) => x.name))
}

function bindValue(value, udtName) {
  if (value == null) return null
  if (udtName === "json" || udtName === "jsonb") {
    // Prefer text from SELECT ::text (preserves numeric scale). Objects → JSON text.
    if (typeof value === "string") return value
    return JSON.stringify(value)
  }
  // timestamptz selected as ::text — keep the string so microseconds survive insert.
  if ((udtName === "timestamptz" || udtName === "timestamp") && typeof value === "string") {
    return value
  }
  return value
}

async function copyTable(prod, test, table) {
  const cols = await tableColumns(prod, table)
  if (cols.length === 0) return { table, rows: 0 }

  const identity = await identityColumns(prod, table)
  const insertCols = cols.filter((c) => !identity.has(c.column_name))
  const colNames = insertCols.map((c) => c.column_name)
  const udtByCol = Object.fromEntries(insertCols.map((c) => [c.column_name, c.udt_name]))
  const quoted = colNames.map((c) => `"${c}"`).join(", ")
  // Round-trip via text for types node-pg mangles (breaks audit_row_canonical):
  // - timestamptz/timestamp → JS Date drops microseconds
  // - jsonb/json → JS object re-stringify drops numeric scale (0.00 → 0)
  const selectQuoted = cols
    .map((c) => {
      if (
        c.udt_name === "timestamptz" ||
        c.udt_name === "timestamp" ||
        c.udt_name === "jsonb" ||
        c.udt_name === "json"
      ) {
        return `"${c.column_name}"::text AS "${c.column_name}"`
      }
      return `"${c.column_name}"`
    })
    .join(", ")
  const pk = await primaryKeyColumns(prod, table)
  const orderBy =
    pk.length > 0
      ? pk.map((c) => `"${c}"`).join(", ")
      : cols.map((c) => `"${c.column_name}"`).join(", ")

  const batchSize = 500
  let offset = 0
  let total = 0

  for (;;) {
    const { rows } = await prod.query(
      `SELECT ${selectQuoted} FROM public."${table}" ORDER BY ${orderBy} LIMIT ${batchSize} OFFSET ${offset}`,
    )
    if (rows.length === 0) break

    const scrambled = rows.map((row) => {
      if (table === "clients") return scrambleClient(row)
      if (table === "profiles") return scrambleProfile(row)
      return row
    })

    const values = []
    const placeholders = scrambled.map((row, ri) => {
      const parts = colNames.map((col, ci) => {
        values.push(bindValue(row[col], udtByCol[col]))
        return `$${ri * colNames.length + ci + 1}`
      })
      return `(${parts.join(",")})`
    })

    await test.query(
      `INSERT INTO public."${table}" (${quoted}) VALUES ${placeholders.join(",")}`,
      values,
    )
    total += scrambled.length
    offset += batchSize
    if (rows.length < batchSize) break
  }
  return { table, rows: total }
}

async function main() {
  const prodEnv = parseEnv(path.join(root, ".env.local"))
  const testEnv = parseEnv(path.join(root, ".env.test"))
  const prodUrl = prodEnv.SUPABASE_DB_URL || prodEnv.DATABASE_URL
  const testUrl = testEnv.TEST_DATABASE_URL || testEnv.DATABASE_URL
  if (!prodUrl || !testUrl) throw new Error("Need DATABASE_URL in .env.local and TEST_DATABASE_URL/.env.test")

  if (projectRefFromUrl(prodUrl) !== PRODUCTION_SUPABASE_REF) {
    throw new Error("Source must be production (.env.local)")
  }
  if (projectRefFromUrl(testUrl) === PRODUCTION_SUPABASE_REF) {
    throw new Error("Target must be the test project (.env.test)")
  }

  console.log(
    `test-db:refresh  prod=${projectRefFromUrl(prodUrl)} → test=${projectRefFromUrl(testUrl)}`,
  )

  const prod = new Client({
    connectionString: prodUrl,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 30_000,
  })
  const test = new Client({
    connectionString: testUrl,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 30_000,
  })
  await prod.connect()
  await test.connect()

  try {
    // Read-only intent on prod (best-effort; pooler may ignore)
    await prod.query(`SET default_transaction_read_only = on`).catch(() => {})
    await test.query(`SET session_replication_role = replica`)

    const prodTables = await listPublicTables(prod)
    const testTables = new Set(await listPublicTables(test))
    const tables = prodTables.filter((t) => testTables.has(t))
    const missingOnTest = prodTables.filter((t) => !testTables.has(t))
    if (missingOnTest.length) {
      console.warn(
        `WARN  ${missingOnTest.length} prod tables missing on test (skipped): ${missingOnTest.slice(0, 20).join(", ")}`,
      )
    }

    // Prefer parents before children: rough order — lookup tables first
    const priority = [
      "product_lines",
      "product_types",
      "clients",
      "profiles",
      "app_settings",
      "inventory_items",
      "transactions",
      "stock_requests",
      "stock_request_lines",
      "notifications",
    ]
    tables.sort((a, b) => {
      const ia = priority.indexOf(a)
      const ib = priority.indexOf(b)
      if (ia === -1 && ib === -1) return a.localeCompare(b)
      if (ia === -1) return 1
      if (ib === -1) return -1
      return ia - ib
    })

    if (tables.length) {
      const list = tables.map((t) => `public."${t}"`).join(", ")
      console.log(`Truncating ${tables.length} public tables on test …`)
      await test.query(`TRUNCATE TABLE ${list} CASCADE`)
    }

    const summary = []
    for (const table of tables) {
      process.stdout.write(`  ${table} … `)
      try {
        const r = await copyTable(prod, test, table)
        console.log(`${r.rows} rows`)
        summary.push(r)
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        console.log(`FAIL ${msg.split("\n")[0]}`)
        summary.push({ table, rows: -1, error: msg })
      }
    }

    await test.query(`SET session_replication_role = origin`)

    const failed = summary.filter((s) => s.error)
    console.log("\n========== test-db:refresh summary ==========")
    console.log(`${summary.length - failed.length} tables ok, ${failed.length} failed`)
    console.log(
      "Scrambled: clients (name/company/email/phone/address/sites), profiles (email/display_name)",
    )
    process.exitCode = failed.length ? 1 : 0
  } finally {
    await prod.end().catch(() => {})
    await test.end().catch(() => {})
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
