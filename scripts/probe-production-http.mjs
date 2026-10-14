/**
 * Production HTTP probe — only requests that must be refused, or safe reads.
 * Never mutates stock. An ephemeral auth user may be created and deleted solely
 * for authenticated PostgREST refusal checks.
 *
 * Usage: node scripts/probe-production-http.mjs
 *
 * Env (.env.local):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY — ephemeral authenticated session for refusal probes
 *   VERIFY_APP_URL (optional, default http://localhost:3000) — admin/viewer API probes
 *
 * Allowed against production: these calls cannot mutate stock state.
 */
import { createRequire } from "module"
import { createClient } from "@supabase/supabase-js"
import { isPermissionDenied, printVerifySummary } from "./verify-harness.mjs"

const require = createRequire(import.meta.url)
const { loadEnvLocal, PRODUCTION_SUPABASE_REF, projectRefFromUrl } = require("./verify-env.cjs")

loadEnvLocal()

function isDeniedStatus(status) {
  return status === 401 || status === 403 || status === 404 || status === 405
}

function isDeniedBody(text) {
  const lower = (text || "").toLowerCase()
  return (
    lower.includes("permission") ||
    lower.includes("not allowed") ||
    lower.includes("jwt") ||
    lower.includes("denied") ||
    lower.includes("could not find") ||
    lower.includes("404") ||
    lower.includes("pgrst202") ||
    lower.includes("pgrst301")
  )
}

/** True when PostgREST accepted the call but wrote no row (RLS / missing target). */
function wroteNoRows(status, text) {
  if (status === 204) return true
  if (status === 200) {
    const trimmed = (text || "").trim()
    return trimmed === "" || trimmed === "[]" || trimmed === "null"
  }
  return false
}

/** PostgREST / Postgres RPC refusal must be permission denied (42501), not an arbitrary error. */
function isRpcPermissionDenied(error) {
  if (!error) return false
  if (error.code === "42501") return true
  return isPermissionDenied(error)
}

async function restDenied(
  baseUrl,
  { apikey, bearer, path, method = "POST", body, label, pass, fail, allowEmptyWrite = false },
) {
  try {
    const init = {
      method,
      headers: {
        apikey,
        Authorization: `Bearer ${bearer}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        Prefer: allowEmptyWrite ? "return=representation" : "return=minimal",
      },
    }
    if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body)
    const response = await fetch(`${baseUrl}${path}`, init)
    const text = await response.text()
    if (isDeniedStatus(response.status) || (response.status >= 400 && isDeniedBody(text))) {
      pass(label, `${method} ${path} → ${response.status}`)
    } else if (allowEmptyWrite && wroteNoRows(response.status, text)) {
      pass(label, `${method} ${path} → ${response.status} (0 rows; RLS/filter blocked write)`)
    } else {
      fail(label, `expected deny/404, got ${response.status}: ${text.slice(0, 160)}`)
    }
  } catch (error) {
    fail(label, error instanceof Error ? error.message : String(error))
  }
}

async function main() {
  const results = {}
  const pass = (name, reason) => {
    results[name] = { result: "PASS", reason }
    console.log(`PASS  ${name} — ${reason}`)
  }
  const fail = (name, reason) => {
    results[name] = { result: "FAIL", reason }
    console.log(`FAIL  ${name} — ${reason}`)
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const appUrl = (
    process.env.VERIFY_APP_URL ||
    (projectRefFromUrl(process.env.NEXT_PUBLIC_SUPABASE_URL || "") === PRODUCTION_SUPABASE_REF
      ? "https://frampol-stock.vercel.app"
      : "http://localhost:3000")
  ).replace(/\/$/, "")

  if (!url || !anonKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY")
  }

  const ref = projectRefFromUrl(url)
  console.log(
    `PROBE  target ${url}${ref === PRODUCTION_SUPABASE_REF ? " (production)" : ""} — refusal/read only`,
  )

  const rest = `${url.replace(/\/$/, "")}/rest/v1`
  const anon = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // --- Anon RPC must be denied ---
  {
    const { data, error } = await anon.rpc("apply_stock_movement", {
      p_inventory_upserts: [],
      p_inventory_inserts: [],
      p_transactions: [],
    })
    if (isRpcPermissionDenied(error) && !data) {
      pass("anon_apply_stock_movement_denied", `SQLSTATE ${error.code ?? "42501"}`)
    } else if (error && !data) {
      fail("anon_apply_stock_movement_denied", `expected 42501, got ${error.code ?? "?"}: ${error.message.slice(0, 120)}`)
    } else {
      fail("anon_apply_stock_movement_denied", `unexpected success ${JSON.stringify(data)}`)
    }
  }

  {
    const { data, error } = await anon.rpc("client_sale_dispatch_counts")
    if (isRpcPermissionDenied(error) && !data) {
      pass("anon_csdc_denied", `SQLSTATE ${error.code ?? "42501"}`)
    } else if (error && !data) {
      fail("anon_csdc_denied", `expected 42501, got ${error.code ?? "?"}: ${error.message.slice(0, 120)}`)
    } else {
      fail("anon_csdc_denied", `unexpected success`)
    }
  }

  // --- Anon cannot call set_config / set app.* (inventory PATCH catalog is in schema-rules) ---
  await restDenied(rest, {
    apikey: anonKey,
    bearer: anonKey,
    path: "/rpc/set_config",
    method: "POST",
    body: { setting: "app.movement_type", new_value: "Sale", is_local: true },
    label: "anon_set_config_denied",
    pass,
    fail,
  })
  await restDenied(rest, {
    apikey: anonKey,
    bearer: anonKey,
    path: "/rpc/set_config",
    method: "POST",
    body: { p_setting: "app.quick_scan_reversal", p_value: "on", p_is_local: true },
    label: "anon_set_config_alt_denied",
    pass,
    fail,
  })

  // --- Authenticated session (ephemeral user) same refusals ---
  if (!serviceKey) {
    fail(
      "auth_service_role",
      "set SUPABASE_SERVICE_ROLE_KEY to probe authenticated PostgREST refusals",
    )
  } else {
    const service = createClient(url, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const email = `probe-auth-${Date.now()}@test.local`
    const password = `Probe-Auth-${Date.now()}!`
    let probeUserId = null
    try {
      const created = await service.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      })
      if (created.error || !created.data.user) {
        fail("auth_session", created.error?.message || "createUser failed")
      } else {
        probeUserId = created.data.user.id
        const signed = await anon.auth.signInWithPassword({ email, password })
        if (signed.error || !signed.data.session?.access_token) {
          fail("auth_session", signed.error?.message || "signInWithPassword failed")
        } else {
          pass("auth_session", "ephemeral authenticated JWT acquired")
          const userJwt = signed.data.session.access_token
          await restDenied(rest, {
            apikey: anonKey,
            bearer: userJwt,
            path: "/rpc/set_config",
            method: "POST",
            body: { setting: "app.movement_type", new_value: "Sale", is_local: true },
            label: "auth_set_config_denied",
            pass,
            fail,
          })
          await restDenied(rest, {
            apikey: anonKey,
            bearer: userJwt,
            path: "/rpc/set_config",
            method: "POST",
            body: { p_setting: "app.quick_scan_reversal", p_value: "on", p_is_local: true },
            label: "auth_set_config_alt_denied",
            pass,
            fail,
          })
        }
      }
    } finally {
      if (probeUserId) {
        await service.auth.admin.deleteUser(probeUserId).catch(() => {})
      }
    }
  }

  // --- Public storage URL rejected ---
  {
    const publicUrl = `${url}/storage/v1/object/public/uploads/probe-must-not-exist-${Date.now()}.bin`
    const response = await fetch(publicUrl, { method: "GET", redirect: "manual" })
    if (response.status === 200) {
      fail("public_storage_rejected", `GET public object returned 200`)
    } else {
      pass("public_storage_rejected", `status ${response.status}`)
    }
  }

  // --- Admin / write APIs without a session must not succeed (401/403) ---
  {
    const checks = [
      { name: "admin_profiles", path: "/api/admin/profiles", method: "GET" },
      { name: "admin_export", path: "/api/admin/transactions/export", method: "GET" },
      { name: "app_logs", path: "/api/app-logs", method: "GET" },
      { name: "quick_scan_reverse", path: "/api/quick-scan/reverse", method: "POST", body: "{}" },
      { name: "stock_takes", path: "/api/stock-takes", method: "POST", body: "{}" },
    ]
    for (const entry of checks) {
      try {
        const init = {
          method: entry.method,
          redirect: "manual",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
        }
        if (entry.body != null) init.body = entry.body
        const response = await fetch(`${appUrl}${entry.path}`, init)
        if (response.status === 401 || response.status === 403) {
          pass(`http_${entry.name}`, `${entry.method} ${entry.path} → ${response.status}`)
        } else {
          fail(
            `http_${entry.name}`,
            `expected 401/403, got ${response.status} (set VERIFY_APP_URL if app is elsewhere)`,
          )
        }
      } catch (error) {
        fail(
          `http_${entry.name}`,
          `unreachable ${appUrl}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  const failed = Object.values(results).filter((r) => r.result === "FAIL")
  const passed = Object.values(results).filter((r) => r.result === "PASS")
  const ok = failed.length === 0 && passed.length > 0
  printVerifySummary(ok, passed.length, failed.length)
  process.exitCode = ok ? 0 : 1
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
