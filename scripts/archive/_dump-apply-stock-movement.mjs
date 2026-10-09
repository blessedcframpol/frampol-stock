import fs from "fs"
import { createRequire } from "module"

const require = createRequire(import.meta.url)
const { Client } = require("pg")
const { loadEnvLocal } = require("../verify-env.cjs")

loadEnvLocal()
const db = new Client({
  connectionString: process.env.SUPABASE_DB_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
await db.connect()
const { rows } = await db.query(
  `SELECT pg_get_functiondef(oid) AS def
   FROM pg_proc
   WHERE proname = 'apply_stock_movement'
     AND pronamespace = 'public'::regnamespace`,
)
fs.writeFileSync(new URL("./_apply_stock_movement_prod.sql", import.meta.url), rows[0].def)
console.log("wrote", rows[0].def.length, "chars")
await db.end()
