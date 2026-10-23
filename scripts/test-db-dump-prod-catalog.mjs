/**
 * Read-only: dump production schema catalog to tmp/schema-compare/production.catalog.txt
 */
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { createRequire } from "module"
import { dumpSchemaCatalog } from "./test-db-schema-catalog.mjs"

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

const env = parse(path.join(root, ".env.local"))
const url = env.SUPABASE_DB_URL || env.DATABASE_URL
if (projectRefFromUrl(url) !== PRODUCTION_SUPABASE_REF) {
  throw new Error("Expected production .env.local")
}
const outDir = path.join(root, "tmp", "schema-compare")
fs.mkdirSync(outDir, { recursive: true })
const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
await db.connect()
try {
  const text = await dumpSchemaCatalog(db)
  const dest = path.join(outDir, "production.catalog.txt")
  fs.writeFileSync(dest, text)
  console.log(`Wrote ${dest} (${text.split("\n").length} lines)`)
} finally {
  await db.end()
}
