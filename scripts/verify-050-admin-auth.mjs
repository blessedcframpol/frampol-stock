/**
 * Verify requireAdmin() on the real HTTP admin-profiles routes.
 *
 * 050 was an application-layer change (lib/require-admin.ts), not a schema
 * migration. This script does not apply SQL.
 *
 * Creates verify-050-* fixture users, verifies POST /api/admin/profiles is removed,
 * and checks GET /api/admin/profiles, PATCH /api/admin/profiles/[id], GET /api/app-logs, and GET
 * /api/admin/transactions/export with each fixture's session, then deletes
 * fixtures (even on failure). Prefix-sweeps leftover verify-050-* emails.
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * The Next.js app must already be running (this script does not start it).
 *   APP_URL  — defaults to http://localhost:3000
 *
 * Safety:
 *   VERIFY_050_I_KNOW_THIS_IS_NOT_PROD=1  — required or the script exits.
 *
 * Usage:
 *   VERIFY_050_I_KNOW_THIS_IS_NOT_PROD=1 node scripts/verify-050-admin-auth.mjs
 */
import fs from "fs"
import path from "path"
import { createClient } from "@supabase/supabase-js"
import { createRequire } from "module"
const require = createRequire(import.meta.url)
const { prepareVerifyEnv } = require("./verify-env.cjs")

const EMAIL_PREFIX = "verify-050-"
const EMAIL = {
  admin: "verify-050-admin@example.com",
  deactivated: "verify-050-deactivated-admin@example.com",
  sales: "verify-050-sales@example.com",
  accounts: "verify-050-accounts@example.com",
  technicians: "verify-050-technicians@example.com",
  norole: "verify-050-norole@example.com",
}

const MAX_COOKIE_CHUNK = 3180
const APP_PROBE_MS = 4000
const REQUEST_MS = 20000

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function isAuthReject(status) {
  return status === 401 || status === 403
}

function hasErrorShape(body) {
  return Boolean(body && typeof body === "object" && typeof body.error === "string" && body.error.trim())
}

/** Match @supabase/ssr createServerClient default cookieEncoding (base64url). */
function sessionCookieHeader(supabaseUrl, session) {
  const ref = new URL(supabaseUrl).hostname.split(".")[0]
  const key = `sb-${ref}-auth-token`
  const encoded = "base64-" + Buffer.from(JSON.stringify(session), "utf8").toString("base64url")
  if (encodeURIComponent(encoded).length <= MAX_COOKIE_CHUNK) {
    return `${key}=${encoded}`
  }
  const parts = []
  for (let i = 0, offset = 0; offset < encoded.length; i += 1) {
    const piece = encoded.slice(offset, offset + MAX_COOKIE_CHUNK)
    parts.push(`${key}.${i}=${piece}`)
    offset += piece.length
  }
  return parts.join("; ")
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: "manual" })
  } finally {
    clearTimeout(t)
  }
}

async function main() {
  prepareVerifyEnv()

  if (process.env.VERIFY_050_I_KNOW_THIS_IS_NOT_PROD !== "1") {
    console.error(
      "Refusing to run against a database without VERIFY_050_I_KNOW_THIS_IS_NOT_PROD=1"
    )
    process.exit(1)
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const appUrl = (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "")

  assert(url, "Missing NEXT_PUBLIC_SUPABASE_URL")
  assert(anonKey, "Missing NEXT_PUBLIC_SUPABASE_ANON_KEY")
  assert(serviceKey, "Missing SUPABASE_SERVICE_ROLE_KEY")

  try {
    await fetchWithTimeout(appUrl, { method: "GET" }, APP_PROBE_MS)
  } catch (e) {
    const aborted = e?.name === "AbortError"
    console.error(
      aborted
        ? `Timed out after ${APP_PROBE_MS}ms reaching ${appUrl}.`
        : `Cannot reach ${appUrl} (${e?.cause?.code || e?.message || e}).`
    )
    console.error(
      "Start the Next.js app with `npm run dev` (or set APP_URL to a running instance) and re-run. This script will not hang waiting for a server."
    )
    process.exit(1)
  }

  console.log("050 is application-only (requireAdmin); no schema apply step.")

  const supabaseAdmin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const supabaseAnon = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const results = {}
  const fixtureUserIds = []

  function pass(name, reason) {
    results[name] = { result: "PASS", reason }
    console.log(`PASS  ${name} — ${reason}`)
  }
  function fail(name, reason) {
    results[name] = { result: "FAIL", reason }
    console.log(`FAIL  ${name} — ${reason}`)
  }

  async function deleteFixtureUsersByEmail() {
    const { data, error } = await supabaseAdmin
      .from("profiles")
      .select("id, email")
      .like("email", `${EMAIL_PREFIX}%`)
    if (error) {
      console.warn(`prefix sweep select failed: ${error.message}`)
      return
    }
    for (const r of data ?? []) {
      const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(r.id)
      if (delErr) console.warn(`Could not delete fixture ${r.email}: ${delErr.message}`)
      else console.log(`Deleted leftover fixture user ${r.email}`)
    }
  }

  async function createFixtureUser(email, { role, active }) {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      email_confirm: true,
    })
    if (error) throw new Error(`createUser(${email}): ${error.message}`)
    const id = data.user.id
    fixtureUserIds.push(id)
    const { error: upErr } = await supabaseAdmin
      .from("profiles")
      .update({ role, active, updated_at: new Date().toISOString() })
      .eq("id", id)
    if (upErr) throw new Error(`update profile ${email}: ${upErr.message}`)
    const { data: row, error: readErr } = await supabaseAdmin
      .from("profiles")
      .select("id, email, role, active")
      .eq("id", id)
      .single()
    if (readErr) throw new Error(`read profile ${email}: ${readErr.message}`)
    assert(row, `Profile missing after createUser for ${email}`)
    const expectedRole = role
    assert(
      row.role === expectedRole && row.active === active,
      `Fixture ${email} not role=${String(role)} active=${active}: ${JSON.stringify(row)}`
    )
    return row
  }

  async function signIn(email) {
    const { data: link, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email,
    })
    if (linkError) throw new Error(`generateLink(${email}): ${linkError.message}`)
    const { data, error } = await supabaseAnon.auth.verifyOtp({
      token_hash: link.properties.hashed_token,
      type: "magiclink",
    })
    if (error || !data.session) {
      throw new Error(`verifyOtp(${email}): ${error?.message || "no session"}`)
    }
    return data.session
  }

  async function api(pathname, { method = "GET", session = null, body } = {}) {
    const headers = { Accept: "application/json" }
    if (session) headers.Cookie = sessionCookieHeader(url, session)
    if (body !== undefined) headers["Content-Type"] = "application/json"
    const res = await fetchWithTimeout(
      `${appUrl}${pathname}`,
      {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      REQUEST_MS
    )
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { status: res.status, json, text }
  }

  try {
    console.log("\n=== Resolving fixtures ===")
    await deleteFixtureUsersByEmail()

    const adminUser = await createFixtureUser(EMAIL.admin, { role: "admin", active: true })
    const deactivated = await createFixtureUser(EMAIL.deactivated, { role: "admin", active: false })
    const sales = await createFixtureUser(EMAIL.sales, { role: "sales", active: true })
    const accounts = await createFixtureUser(EMAIL.accounts, { role: "accounts", active: true })
    const technicians = await createFixtureUser(EMAIL.technicians, { role: "technicians", active: true })
    const norole = await createFixtureUser(EMAIL.norole, { role: null, active: true })

    console.log(`Created admin: ${adminUser.email}`)
    console.log(`Created deactivated admin: ${deactivated.email}`)
    console.log(`Created sales: ${sales.email}`)
    console.log(`Created accounts: ${accounts.email}`)
    console.log(`Created technicians: ${technicians.email}`)
    console.log(`Created norole: ${norole.email}`)

    const sessions = {
      admin: await signIn(EMAIL.admin),
      deactivated: await signIn(EMAIL.deactivated),
      sales: await signIn(EMAIL.sales),
      accounts: await signIn(EMAIL.accounts),
      technicians: await signIn(EMAIL.technicians),
      norole: await signIn(EMAIL.norole),
    }

    // ------------------------------------------------------------------ checks
    console.log("\n=== HTTP checks ===")

    try {
      const res = await api("/api/admin/profiles", { session: sessions.admin })
      if (res.status === 200 && Array.isArray(res.json)) {
        pass("active_admin_GET", `GET /api/admin/profiles → 200 (${res.json.length} profiles)`)
      } else if (res.status === 503) {
        fail(
          "active_admin_GET",
          "GET returned 503 — the running app is missing SUPABASE_SERVICE_ROLE_KEY"
        )
      } else {
        fail("active_admin_GET", `expected 200 array, got ${res.status} ${res.text.slice(0, 200)}`)
      }
    } catch (e) {
      fail("active_admin_GET", e.message)
    }

    try {
      const res = await api("/api/admin/profiles", { session: sessions.deactivated })
      if (res.status === 200) {
        fail("deactivated_admin_GET", "BUG: deactivated admin GET returned 200")
      } else if (res.status === 403 && hasErrorShape(res.json)) {
        pass("deactivated_admin_GET", `GET → ${res.status} (${res.json.error})`)
      } else if (isAuthReject(res.status) && hasErrorShape(res.json)) {
        pass("deactivated_admin_GET", `GET → ${res.status} (${res.json.error})`)
      } else {
        fail(
          "deactivated_admin_GET",
          `expected 403 (not 200), got ${res.status} ${res.text.slice(0, 200)}`
        )
      }
    } catch (e) {
      fail("deactivated_admin_GET", e.message)
    }

    try {
      const res = await api(`/api/admin/profiles/${deactivated.id}`, {
        method: "PATCH",
        session: sessions.deactivated,
        body: { active: true },
      })
      if (res.status === 200) {
        fail("deactivated_admin_PATCH", "BUG: deactivated admin PATCH returned 200")
      } else if (isAuthReject(res.status) && hasErrorShape(res.json)) {
        pass("deactivated_admin_PATCH", `PATCH → ${res.status} (${res.json.error})`)
      } else {
        fail("deactivated_admin_PATCH", `expected 401/403, got ${res.status} ${res.text.slice(0, 200)}`)
      }
    } catch (e) {
      fail("deactivated_admin_PATCH", e.message)
    }

    const nonAdmin = [
      ["sales", sessions.sales],
      ["accounts", sessions.accounts],
      ["technicians", sessions.technicians],
    ]
    for (const [role, session] of nonAdmin) {
      try {
        const getRes = await api("/api/admin/profiles", { session })
        const patchRes = await api(`/api/admin/profiles/${adminUser.id}`, {
          method: "PATCH",
          session,
          body: { display_name: "should-not-apply" },
        })
        const ok =
          isAuthReject(getRes.status) &&
          hasErrorShape(getRes.json) &&
          isAuthReject(patchRes.status) &&
          hasErrorShape(patchRes.json)
        if (ok) {
          pass(`${role}_admin_handlers`, `GET ${getRes.status}, PATCH ${patchRes.status}`)
        } else {
          fail(
            `${role}_admin_handlers`,
            `GET ${getRes.status}, PATCH ${patchRes.status}`
          )
        }
      } catch (e) {
        fail(`${role}_admin_handlers`, e.message)
      }
    }

    try {
      const getRes = await api("/api/admin/profiles", { session: sessions.norole })
      const patchRes = await api(`/api/admin/profiles/${adminUser.id}`, {
        method: "PATCH",
        session: sessions.norole,
        body: { display_name: "should-not-apply" },
      })
      const ok =
        isAuthReject(getRes.status) &&
        hasErrorShape(getRes.json) &&
        isAuthReject(patchRes.status) &&
        hasErrorShape(patchRes.json)
      if (ok) {
        pass("norole_admin_handlers", `GET ${getRes.status}, PATCH ${patchRes.status}`)
      } else {
        fail("norole_admin_handlers", `GET ${getRes.status}, PATCH ${patchRes.status}`)
      }
    } catch (e) {
      fail("norole_admin_handlers", e.message)
    }

    try {
      const getRes = await api("/api/admin/profiles")
      const patchRes = await api(`/api/admin/profiles/${adminUser.id}`, {
        method: "PATCH",
        body: { display_name: "should-not-apply" },
      })
      const ok =
        getRes.status === 401 &&
        hasErrorShape(getRes.json) &&
        patchRes.status === 401 &&
        hasErrorShape(patchRes.json)
      if (ok) {
        pass("no_session_admin_handlers", "GET/PATCH both 401")
      } else {
        fail(
          "no_session_admin_handlers",
          `GET ${getRes.status}, PATCH ${patchRes.status}`
        )
      }
    } catch (e) {
      fail("no_session_admin_handlers", e.message)
    }

    try {
      const res = await api(`/api/admin/profiles/${technicians.id}`, {
        method: "PATCH",
        session: sessions.admin,
        body: {
          display_name: "Verify 050 Technician",
          role: "technicians",
          active: true,
        },
      })
      if (
        res.status === 200 &&
        res.json?.display_name === "Verify 050 Technician" &&
        res.json?.role === "technicians" &&
        res.json?.active === true
      ) {
        pass("active_admin_PATCH", "PATCH role/active/display_name → 200")
      } else {
        fail(
          "active_admin_PATCH",
          `expected updated profile, got ${res.status} ${res.text.slice(0, 300)}`
        )
      }
    } catch (e) {
      fail("active_admin_PATCH", e.message)
    }

    try {
      const res = await api("/api/admin/profiles", {
        method: "POST",
        session: sessions.admin,
        body: {},
      })
      if (res.status === 404 || res.status === 405) {
        pass("admin_profiles_POST_removed", `POST → ${res.status}`)
      } else {
        fail(
          "admin_profiles_POST_removed",
          `expected 404/405, got ${res.status} ${res.text.slice(0, 200)}`
        )
      }
    } catch (e) {
      fail("admin_profiles_POST_removed", e.message)
    }

    try {
      const removedRoutes = {}
      for (const pathname of ["/signup", "/forgot-password", "/reset-password"]) {
        removedRoutes[pathname] = (await api(pathname, { session: sessions.admin })).status
      }
      if (Object.values(removedRoutes).every((status) => status === 404)) {
        pass("password_pages_removed", JSON.stringify(removedRoutes))
      } else {
        fail("password_pages_removed", JSON.stringify(removedRoutes))
      }
    } catch (e) {
      fail("password_pages_removed", e.message)
    }

    const EXPORT_FORBIDDEN = "Only admins can export all transactions"

    try {
      const logs = await api("/api/app-logs", { session: sessions.deactivated })
      if (logs.status === 200) {
        fail("deactivated_admin_app_logs_GET", "BUG: deactivated admin GET /api/app-logs returned 200")
      } else if (isAuthReject(logs.status) && hasErrorShape(logs.json)) {
        pass("deactivated_admin_app_logs_GET", `GET → ${logs.status} (${logs.json.error})`)
      } else {
        fail(
          "deactivated_admin_app_logs_GET",
          `expected 403 (not 200), got ${logs.status} ${logs.text.slice(0, 200)}`
        )
      }
    } catch (e) {
      fail("deactivated_admin_app_logs_GET", e.message)
    }

    try {
      const exp = await api("/api/admin/transactions/export", { session: sessions.deactivated })
      if (exp.status === 200) {
        fail("deactivated_admin_export_GET", "BUG: deactivated admin export returned 200")
      } else if (isAuthReject(exp.status) && hasErrorShape(exp.json)) {
        pass("deactivated_admin_export_GET", `GET → ${exp.status} (${exp.json.error})`)
      } else {
        fail(
          "deactivated_admin_export_GET",
          `expected 403 (not 200), got ${exp.status} ${exp.text.slice(0, 200)}`
        )
      }
    } catch (e) {
      fail("deactivated_admin_export_GET", e.message)
    }

    for (const [role, session] of nonAdmin) {
      try {
        const logs = await api("/api/app-logs", { session })
        const exp = await api("/api/admin/transactions/export", { session })
        const ok =
          isAuthReject(logs.status) &&
          hasErrorShape(logs.json) &&
          isAuthReject(exp.status) &&
          hasErrorShape(exp.json)
        if (ok) {
          pass(`${role}_logs_and_export`, `logs ${logs.status}, export ${exp.status}`)
        } else {
          fail(`${role}_logs_and_export`, `logs ${logs.status}, export ${exp.status}`)
        }
      } catch (e) {
        fail(`${role}_logs_and_export`, e.message)
      }
    }

    try {
      const logs = await api("/api/app-logs")
      const exp = await api("/api/admin/transactions/export")
      const ok =
        logs.status === 401 &&
        hasErrorShape(logs.json) &&
        exp.status === 401 &&
        hasErrorShape(exp.json)
      if (ok) {
        pass("no_session_logs_and_export", "GET logs and export both 401")
      } else {
        fail("no_session_logs_and_export", `logs ${logs.status}, export ${exp.status}`)
      }
    } catch (e) {
      fail("no_session_logs_and_export", e.message)
    }

    try {
      const logs = await api("/api/app-logs", { session: sessions.admin })
      const exp = await api("/api/admin/transactions/export", { session: sessions.admin })
      const logsOk = logs.status === 200 && Array.isArray(logs.json)
      const exportOk = exp.status === 200 && /Serial Number/i.test(exp.text)
      if (logsOk && exportOk) {
        pass(
          "active_admin_logs_and_export",
          `logs 200 (${logs.json.length} rows), export 200 CSV`
        )
      } else {
        fail(
          "active_admin_logs_and_export",
          `logs ${logs.status}, export ${exp.status} ${exp.text.slice(0, 120)}`
        )
      }
    } catch (e) {
      fail("active_admin_logs_and_export", e.message)
    }

    try {
      const exp = await api("/api/admin/transactions/export", { session: sessions.sales })
      if (exp.status === 403 && exp.json?.error === EXPORT_FORBIDDEN) {
        pass("export_403_custom_message", `403 "${exp.json.error}"`)
      } else {
        fail(
          "export_403_custom_message",
          `expected 403 "${EXPORT_FORBIDDEN}", got ${exp.status} ${JSON.stringify(exp.json)}`
        )
      }
    } catch (e) {
      fail("export_403_custom_message", e.message)
    }
  } finally {
    console.log("\n=== Cleanup ===")
    try {
      const ids = [...new Set(fixtureUserIds)]
      for (const id of ids) {
        const { error } = await supabaseAdmin.auth.admin.deleteUser(id)
        if (error) console.warn(`deleteUser(${id}): ${error.message}`)
      }
      await deleteFixtureUsersByEmail()
    } catch (e) {
      console.warn("Cleanup error:", e.message)
    }
  }

  console.log("\n========== VERIFY 050 SUMMARY ==========")
  console.log(JSON.stringify(results, null, 2))
  console.log("========================================")

  const failed = Object.values(results).filter((r) => r.result === "FAIL")
  if (failed.length > 0) {
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
