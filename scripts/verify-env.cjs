/**
 * Shared env loader and production guard for verify-*.mjs scripts.
 * Every verify script must call assertNotProduction() / prepareVerifyEnv()
 * before writing. No override flag: production ref always aborts.
 */
"use strict"

const fs = require("fs")
const path = require("path")

/** Live frampolstock project. Verify scripts must never touch it. */
const PRODUCTION_SUPABASE_REF = "iysjspjsuuunpjhpwlei"

function loadEnvLocal() {
  const envPath = path.join(process.cwd(), ".env.local")
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value
  }
}

/**
 * Extract the project ref from a Supabase API or database URL.
 */
function projectRefFromUrl(raw) {
  if (!raw || typeof raw !== "string") return null
  const value = raw.trim()
  try {
    const parsed = new URL(value)
    const host = parsed.hostname || ""
    const apiMatch = host.match(/^([a-z0-9]+)\.supabase\.co$/i)
    if (apiMatch) return apiMatch[1].toLowerCase()
    const dbMatch = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/i)
    if (dbMatch) return dbMatch[1].toLowerCase()
    const options = parsed.searchParams.get("options") || ""
    const projectOpt = options.match(/project[=:]([a-z0-9]+)/i)
    if (projectOpt) return projectOpt[1].toLowerCase()
    const userMatch = (parsed.username || "").match(/^postgres\.([a-z0-9]+)$/i)
    if (userMatch) return userMatch[1].toLowerCase()
  } catch {
    // fall through
  }
  const loose = value.match(/(?:^|[/.@])([a-z0-9]{20})(?:\.supabase\.co|[.?&#]|$)/i)
  return loose ? loose[1].toLowerCase() : null
}

/**
 * Abort if any configured Supabase URL points at production. No override.
 */
function assertNotProduction(extraUrls = []) {
  const candidates = [
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_URL,
    process.env.SUPABASE_DB_URL,
    process.env.DATABASE_URL,
    ...extraUrls,
  ].filter(Boolean)

  if (candidates.length === 0) {
    throw new Error(
      "verify-env: no Supabase URL found (set NEXT_PUBLIC_SUPABASE_URL and/or SUPABASE_DB_URL). Refusing to run.",
    )
  }

  for (const url of candidates) {
    const ref = projectRefFromUrl(url)
    if (ref === PRODUCTION_SUPABASE_REF) {
      throw new Error(
        `verify-env: refusing to run against production project ${PRODUCTION_SUPABASE_REF}. Point env at a non-production project.`,
      )
    }
  }
}

function prepareVerifyEnv(extraUrls = []) {
  loadEnvLocal()
  assertNotProduction(extraUrls)
}

module.exports = {
  PRODUCTION_SUPABASE_REF,
  loadEnvLocal,
  projectRefFromUrl,
  assertNotProduction,
  prepareVerifyEnv,
}
