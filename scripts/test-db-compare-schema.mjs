/**
 * Compare schema-only catalogs: production (read-only) vs test.
 *
 *   node --require ./scripts/dev/tls-classic.cjs scripts/test-db-compare-schema.mjs
 *
 * Writes dumps under tmp/schema-compare/ and prints every differing line.
 */
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { createRequire } from "module"
import { dumpSchemaCatalog, diffCatalogs } from "./test-db-schema-catalog.mjs"

const require = createRequire(import.meta.url)
const { Client } = require("pg")
const { projectRefFromUrl, PRODUCTION_SUPABASE_REF } = require("./verify-env.cjs")

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")
const outDir = path.join(root, "tmp", "schema-compare")

async function connect(url, label) {
  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20_000,
  })
  await client.connect()
  const ref = projectRefFromUrl(url)
  console.log(`Connected ${label} ref=${ref}`)
  return client
}

async function main() {
  const prodEnv = {}
  const testEnv = {}
  // Isolate env loads
  const prodPath = path.join(root, ".env.local")
  const testPath = path.join(root, ".env.test")
  if (!fs.existsSync(prodPath) || !fs.existsSync(testPath)) {
    throw new Error("Need both .env.local (prod) and .env.test")
  }

  // Manual parse so we don't clobber process.env for both
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

  Object.assign(prodEnv, parse(prodPath))
  Object.assign(testEnv, parse(testPath))

  const prodUrl = prodEnv.SUPABASE_DB_URL || prodEnv.DATABASE_URL
  const testUrl = testEnv.TEST_DATABASE_URL || testEnv.DATABASE_URL
  if (!prodUrl || !testUrl) throw new Error("Missing DATABASE_URL in .env.local or .env.test")

  if (projectRefFromUrl(prodUrl) !== PRODUCTION_SUPABASE_REF) {
    throw new Error(`.env.local DB is not production ref ${PRODUCTION_SUPABASE_REF}`)
  }
  if (projectRefFromUrl(testUrl) === PRODUCTION_SUPABASE_REF) {
    throw new Error(".env.test must not point at production")
  }

  fs.mkdirSync(outDir, { recursive: true })

  const prod = await connect(prodUrl, "production")
  let prodText
  try {
    prodText = await dumpSchemaCatalog(prod)
  } finally {
    await prod.end()
  }
  fs.writeFileSync(path.join(outDir, "production.catalog.txt"), prodText)

  const test = await connect(testUrl, "test")
  let testText
  try {
    testText = await dumpSchemaCatalog(test)
  } finally {
    await test.end()
  }
  fs.writeFileSync(path.join(outDir, "test.catalog.txt"), testText)

  const { onlyProd, onlyTest } = diffCatalogs(prodText, testText)
  const reportPath = path.join(outDir, "diff.txt")
  const report = [
    `# Schema catalog diff (production vs test)`,
    `# only-in-production: ${onlyProd.length}`,
    `# only-in-test: ${onlyTest.length}`,
    "",
    "## Only in production",
    ...onlyProd.map((l) => `- ${l}`),
    "",
    "## Only in test",
    ...onlyTest.map((l) => `- ${l}`),
    "",
  ].join("\n")
  fs.writeFileSync(reportPath, report)

  console.log(`\nDiff written to ${reportPath}`)
  console.log(`only-in-production: ${onlyProd.length}`)
  console.log(`only-in-test: ${onlyTest.length}`)
  if (onlyProd.length || onlyTest.length) {
    console.log("\n--- sample (first 40 each) ---")
    for (const l of onlyProd.slice(0, 40)) console.log("PROD", l)
    for (const l of onlyTest.slice(0, 40)) console.log("TEST", l)
  } else {
    console.log("Schemas match (catalog lines identical).")
  }
  process.exitCode = onlyProd.length || onlyTest.length ? 1 : 0
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
