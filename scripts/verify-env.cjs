/**
 * Shared env loader and production guard for verify / rehearse / test-db scripts.
 *
 * Default (no --production): load .env.test, prefer TEST_DATABASE_URL, refuse
 * the production Supabase ref.
 *
 * --production: load .env.local, allow production for harness ROLLBACK only;
 *   warn when the clock is in weekday working hours (Africa/Harare).
 *
 * HTTP / Supabase-client scripts still call prepareVerifyEnv() with no harness
 * flag — production always aborts on that path.
 *
 * apply-migrations-commit.mjs stays production-only (loads .env.local only).
 */
"use strict"

const fs = require("fs")
const path = require("path")

/** Live frampolstock project. Verify scripts must never write to it. */
const PRODUCTION_SUPABASE_REF = "iysjspjsuuunpjhpwlei"

/** Test project ref from .env.test (czowbmhtunbjnpcvvyap). */
const TEST_SUPABASE_REF_HINT = "czowbmhtunbjnpcvvyap"

function argvHasProductionFlag(argv = process.argv) {
  return argv.includes("--production")
}

function loadEnvFile(filePath, { override = false } = {}) {
  if (!fs.existsSync(filePath)) return false
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (override || process.env[match[1]] === undefined) {
      process.env[match[1]] = value
    }
  }
  return true
}

/** Legacy name — loads .env.local only (no override). Prefer loadVerifyEnv(). */
function loadEnvLocal() {
  loadEnvFile(path.join(process.cwd(), ".env.local"), { override: false })
}

/**
 * Load env for harness / rehearse / verify:all.
 * Default: .env.test then map TEST_DATABASE_URL → DATABASE_URL / SUPABASE_DB_URL.
 * --production: .env.local (production), with working-hours warning.
 */
function loadVerifyEnv(options = {}) {
  const productionMode = options.production === true || argvHasProductionFlag(options.argv)
  const root = process.cwd()

  if (productionMode) {
    const ok = loadEnvFile(path.join(root, ".env.local"), { override: true })
    if (!ok) {
      throw new Error("verify-env: --production requires .env.local")
    }
    warnIfWorkingHours()
    return { productionMode: true, source: ".env.local" }
  }

  const testPath = path.join(root, ".env.test")
  if (!loadEnvFile(testPath, { override: true })) {
    throw new Error(
      "verify-env: missing .env.test (default target). Create it or pass --production to use .env.local.",
    )
  }

  // Prefer explicit TEST_DATABASE_URL; fall back to DATABASE_URL from .env.test.
  const testDb = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  if (!testDb) {
    throw new Error("verify-env: set TEST_DATABASE_URL (or DATABASE_URL) in .env.test")
  }
  process.env.TEST_DATABASE_URL = testDb
  process.env.DATABASE_URL = testDb
  process.env.SUPABASE_DB_URL = testDb

  return { productionMode: false, source: ".env.test" }
}

/** Weekday 08:00–17:59 Africa/Harare — warn for --production harness runs. */
function warnIfWorkingHours(now = new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Harare",
      weekday: "short",
      hour: "numeric",
      hour12: false,
    })
    const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]))
    const weekday = parts.weekday
    const hour = Number(parts.hour)
    const weekend = weekday === "Sat" || weekday === "Sun"
    if (!weekend && hour >= 8 && hour < 18) {
      console.warn(
        `WARNING  --production during working hours (${weekday} ${String(hour).padStart(2, "0")}:xx Africa/Harare). Prefer the test DB (.env.test) unless you intend a ROLLBACK-only production rehearsal.`,
      )
    }
  } catch {
    /* ignore locale issues */
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
 * Used by HTTP / client scripts (never --production).
 */
function assertNotProduction(extraUrls = []) {
  const candidates = [
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_URL,
    process.env.SUPABASE_DB_URL,
    process.env.DATABASE_URL,
    process.env.TEST_DATABASE_URL,
    ...extraUrls,
  ].filter(Boolean)

  if (candidates.length === 0) {
    throw new Error(
      "verify-env: no Supabase URL found (set NEXT_PUBLIC_SUPABASE_URL and/or TEST_DATABASE_URL). Refusing to run.",
    )
  }

  for (const url of candidates) {
    const ref = projectRefFromUrl(url)
    if (ref === PRODUCTION_SUPABASE_REF) {
      throw new Error(
        `verify-env: refusing to run against production project ${PRODUCTION_SUPABASE_REF}. Use .env.test / TEST_DATABASE_URL, or pass --production only for harness ROLLBACK rehearsals.`,
      )
    }
  }
}

/**
 * Resolve DB URL after loadVerifyEnv(). Refuses production unless productionMode.
 */
function resolveHarnessDbUrl(productionMode) {
  const dbUrl =
    process.env.TEST_DATABASE_URL || process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
  if (!dbUrl) {
    throw new Error("verify-env: Missing TEST_DATABASE_URL / SUPABASE_DB_URL / DATABASE_URL")
  }
  const ref = projectRefFromUrl(dbUrl)
  const isProd = ref === PRODUCTION_SUPABASE_REF
  if (isProd && !productionMode) {
    throw new Error(
      `verify-env: DATABASE_URL points at production (${PRODUCTION_SUPABASE_REF}). Point .env.test at the test project, or pass --production.`,
    )
  }
  if (!isProd && productionMode) {
    console.warn(
      `WARNING  --production set but DB ref is ${ref || "unknown"} (not ${PRODUCTION_SUPABASE_REF})`,
    )
  }
  return { dbUrl, production: isProd, ref }
}

function prepareVerifyEnv(extraUrls = []) {
  // Strict path for HTTP probes: always .env.test (or env already set), never production.
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL && !process.env.DATABASE_URL) {
    loadVerifyEnv({ production: false })
  } else if (!argvHasProductionFlag()) {
    // Prefer test file when present so verify:all defaults off production.
    const testPath = path.join(process.cwd(), ".env.test")
    if (fs.existsSync(testPath)) {
      loadVerifyEnv({ production: false })
    } else {
      loadEnvLocal()
    }
  }
  assertNotProduction(extraUrls)
}

module.exports = {
  PRODUCTION_SUPABASE_REF,
  TEST_SUPABASE_REF_HINT,
  loadEnvLocal,
  loadEnvFile,
  loadVerifyEnv,
  argvHasProductionFlag,
  warnIfWorkingHours,
  projectRefFromUrl,
  assertNotProduction,
  resolveHarnessDbUrl,
  prepareVerifyEnv,
}
