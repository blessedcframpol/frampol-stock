/**
 * Verify 20261001160000_client_transaction_resolution.sql. Does not apply it.
 *
 * The sale-count fixture is the pre-migration output of client_sale_dispatch_counts()
 * (431 clients, 691 orders, 1,247 units). Fixtures use the verify-065- prefix and
 * are removed in finally.
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SUPABASE_DB_URL (or DATABASE_URL)
 *
 * Usage: node scripts/verify-065-client-transaction-resolution.mjs
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"
import { createClient } from "@supabase/supabase-js"

const require = createRequire(import.meta.url)
const PREFIX = "verify-065-"
const EMAIL_PREFIX = "verify-065-"
const KUDZANAI = "CLT-1776236425866-d56cys2"
const KIM_LAURENCE = [
  ["CLT-1785948975137-km4wqki", "2026-08-05"],
  ["CLT-1789642904701-g8hxxzr", "2026-09-16"],
]
const FORTUNATE_SALES = [
  "TXN-1779863170957-1-wa47150",
  "TXN-1777488626361-1-oqe1qb3",
  "TXN-1777487783890-1-66d5sui",
  "TXN-1778077044872-1-laxya0h",
  "TXN-1779783989850-1-9v0gvlt",
  "TXN-1780391654029-1-tj6bpvb",
]
const DATE = "2026-01-15T00:00:00.000Z"

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

function loadSnapshot() {
  const file = path.join(process.cwd(), "scripts", "fixtures", "client-sale-dispatch-counts.json")
  const rows = JSON.parse(fs.readFileSync(file, "utf8"))
  const byId = new Map()
  let orders = 0
  let units = 0
  for (const row of rows) {
    if (byId.has(row.client_id)) throw new Error(`Duplicate snapshot client ${row.client_id}`)
    byId.set(row.client_id, { orders: row.orders, units: row.units })
    orders += row.orders
    units += row.units
  }
  if (byId.size !== 431 || orders !== 691 || units !== 1247) {
    throw new Error(`Snapshot totals ${byId.size} / ${orders} / ${units}, expected 431 / 691 / 1247`)
  }
  return byId
}

function pass(results, name, reason) {
  results[name] = { result: "PASS", reason }
  console.log(`PASS  ${name} — ${reason}`)
}

function fail(results, name, reason) {
  results[name] = { result: "FAIL", reason }
  console.log(`FAIL  ${name} — ${reason}`)
}

async function main() {
  loadEnvLocal()
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!dbUrl) throw new Error("Missing SUPABASE_DB_URL or DATABASE_URL")
  if (!url || !anonKey || !serviceKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, or SUPABASE_SERVICE_ROLE_KEY")
  }

  const snapshot = loadSnapshot()
  const pg = require("pg")
  const db = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
  await db.connect()
  const service = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const userIds = []
  const results = {}

  async function cleanup() {
    await db.query(`DELETE FROM public.transactions WHERE id LIKE $1 OR serial_number LIKE $1 OR batch_id LIKE $1`, [
      `${PREFIX}%`,
    ])
    await db.query(`DELETE FROM public.clients WHERE id LIKE $1`, [`CLT-${PREFIX}%`])
    const { rows } = await db.query(`SELECT id::text AS id FROM auth.users WHERE email LIKE $1`, [`${EMAIL_PREFIX}%`])
    for (const id of new Set([...userIds, ...rows.map((row) => row.id)])) {
      const { error } = await service.auth.admin.deleteUser(id)
      if (error && !/not found/i.test(error.message)) throw error
    }
  }

  try {
    const ready = await db.query(
      `SELECT
         to_regclass('public.client_transaction_resolution') IS NOT NULL AS view_ready,
         to_regprocedure('public.client_transactions(text)') IS NOT NULL AS rows_ready,
         to_regprocedure('public.client_sale_dispatch_counts()') IS NOT NULL AS counts_ready,
         to_regprocedure('public.client_last_activity()') IS NOT NULL AS activity_ready`
    )
    if (!ready.rows[0]?.view_ready || !ready.rows[0]?.rows_ready || !ready.rows[0]?.counts_ready || !ready.rows[0]?.activity_ready) {
      throw new Error(
        "Apply supabase/migrations/20261001160000_client_transaction_resolution.sql before running this script."
      )
    }

    const live = await db.query(
      `SELECT client_id, orders, units, reliable
       FROM public.client_sale_dispatch_counts()
       ORDER BY client_id`
    )
    const mismatches = []
    const seen = new Set()
    let liveOrders = 0
    let liveUnits = 0
    for (const row of live.rows) {
      seen.add(row.client_id)
      liveOrders += row.orders
      liveUnits += row.units
      const expected = snapshot.get(row.client_id)
      if (!expected || expected.orders !== row.orders || expected.units !== row.units || row.reliable !== true) {
        mismatches.push(row.client_id)
      }
    }
    for (const id of snapshot.keys()) {
      if (!seen.has(id)) mismatches.push(id)
    }
    if (mismatches.length === 0 && seen.size === 431 && liveOrders === 691 && liveUnits === 1247) {
      pass(results, "snapshot", "431 clients, 691 orders, 1,247 units, every client unchanged")
    } else {
      fail(
        results,
        "snapshot",
        `${mismatches.length} clients differ; live ${seen.size} / ${liveOrders} / ${liveUnits}; sample ${mismatches.slice(0, 5).join(", ")}`
      )
    }

    const parity = await db.query(
      `SELECT fn.client_id
       FROM public.client_sale_dispatch_counts() AS fn
       CROSS JOIN LATERAL (
         SELECT count(DISTINCT rows.batch_key)::integer AS orders, count(*)::integer AS units
         FROM public.client_transactions(fn.client_id) AS rows
         WHERE rows.type = 'Sale'
       ) AS sale
       WHERE fn.orders IS DISTINCT FROM sale.orders
          OR fn.units IS DISTINCT FROM sale.units`
    )
    if (parity.rows.length === 0) {
      pass(results, "sale_rows_match_counts", "every client's sale batches from client_transactions() match the function")
    } else {
      fail(results, "sale_rows_match_counts", parity.rows.slice(0, 5).map((row) => row.client_id).join(", "))
    }

    const kudz = live.rows.find((row) => row.client_id === KUDZANAI)
    const kudzRows = await db.query(
      `SELECT id, type, batch_key FROM public.client_transactions($1)`,
      [KUDZANAI]
    )
    const kudzSales = kudzRows.rows.filter((row) => row.type === "Sale")
    const kudzOrders = new Set(kudzSales.map((row) => row.batch_key)).size
    const fortunateOnTab = kudzRows.rows.filter((row) => FORTUNATE_SALES.includes(row.id))
    if (kudz?.orders === 18 && kudz?.units === 20 && kudzSales.length === 20 && kudzOrders === 18 && fortunateOnTab.length === 0) {
      pass(results, "kudzanai", "18 orders / 20 units, and none of the six Fortunate sales")
    } else {
      fail(
        results,
        "kudzanai",
        `function ${kudz?.orders}/${kudz?.units}; tab sales ${kudzSales.length} in ${kudzOrders} batches; fortunate ${fortunateOnTab.length}`
      )
    }

    const kim = await db.query(
      `SELECT client_id, last_activity_date
       FROM public.client_last_activity()
       WHERE client_id = ANY($1::text[])
       ORDER BY client_id`,
      [KIM_LAURENCE.map(([id]) => id)]
    )
    const kimGot = kim.rows.map((row) => `${row.client_id}=${row.last_activity_date}`).join(", ")
    const kimExpected = [...KIM_LAURENCE]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, date]) => `${id}=${date}`)
      .join(", ")
    if (kimGot === kimExpected && KIM_LAURENCE[0][1] !== KIM_LAURENCE[1][1]) {
      pass(results, "kim_laurence", "each Kim Laurence Group row keeps only its own business date")
    } else {
      fail(results, "kim_laurence", `expected ${kimExpected}; got ${kimGot}`)
    }

    await db.query(
      `INSERT INTO public.clients (id, name, company, email, phone, address, sites)
       VALUES
         ('CLT-verify-065-acme', 'Buyer', 'Acme', 'verify-065-acme@test.local', '000', 'Verify', '[{"address":"Verify"}]'),
         ('CLT-verify-065-twin-a', 'Twin A', 'Verify Twin', 'verify-065-twin-a@test.local', '000', 'Verify', '[{"address":"Verify"}]'),
         ('CLT-verify-065-twin-b', 'Twin B', 'Verify Twin', 'verify-065-twin-b@test.local', '000', 'Verify', '[{"address":"Verify"}]'),
         ('CLT-verify-065-text', 'Text Target', 'Text Target Co', 'verify-065-text@test.local', '000', 'Verify', '[{"address":"Verify"}]'),
         ('CLT-verify-065-owner', 'Owner', 'Owner Co', 'verify-065-owner@test.local', '000', 'Verify', '[{"address":"Verify"}]')`
    )
    await db.query(
      `INSERT INTO public.transactions (id, type, serial_number, item_name, client, date, client_id, invoice_number, batch_id)
       VALUES
         ('TXN-verify-065-substr', 'Sale', 'verify-065-substr', 'Verify kit', 'Someone - Acme Holdings', $1, NULL, '100', NULL),
         ('TXN-verify-065-ambig', 'Sale', 'verify-065-ambig', 'Verify kit', 'Verify Twin', $1, NULL, '100', NULL),
         ('TXN-verify-065-dangle', 'Sale', 'verify-065-dangle', 'Verify kit', 'Text Target', $1, 'CLT-verify-065-missing', '100', NULL),
         ('TXN-verify-065-poc', 'POC Out', 'verify-065-poc', 'Verify kit', 'Owner - Owner Co', $1, 'CLT-verify-065-owner', NULL, 'verify-065-poc'),
         ('TXN-verify-065-return', 'POC Return', 'verify-065-return', 'Verify kit', 'Someone else', $1, 'CLT-verify-065-owner', NULL, NULL)`,
      [DATE]
    )

    const held = await db.query(
      `SELECT client_id, orders, units
       FROM public.client_sale_dispatch_counts()
       WHERE client_id = ANY($1::text[])`,
      [[...snapshot.keys()]]
    )
    const heldBad = held.rows.filter((row) => {
      const expected = snapshot.get(row.client_id)
      return !expected || expected.orders !== row.orders || expected.units !== row.units
    })
    if (held.rows.length === snapshot.size && heldBad.length === 0) {
      pass(results, "snapshot_unchanged_by_fixtures", "existing clients keep their sale counts")
    } else {
      fail(results, "snapshot_unchanged_by_fixtures", `${heldBad.length} changed, ${held.rows.length} returned`)
    }

    const substring = await db.query(
      `SELECT method, unresolved_reason, resolved_client_id
       FROM public.client_transaction_resolution
       WHERE transaction_id = 'TXN-verify-065-substr'`
    )
    const acmeTab = await db.query(
      `SELECT id FROM public.client_transactions('CLT-verify-065-acme') WHERE id = 'TXN-verify-065-substr'`
    )
    const sub = substring.rows[0]
    if (sub?.method === "unresolved" && sub?.unresolved_reason === "no_match" && sub?.resolved_client_id == null && acmeTab.rows.length === 0) {
      pass(results, "substring", "Acme does not receive Someone - Acme Holdings")
    } else {
      fail(results, "substring", JSON.stringify(sub))
    }

    const ambiguous = await db.query(
      `SELECT method, unresolved_reason, resolved_client_id
       FROM public.client_transaction_resolution
       WHERE transaction_id = 'TXN-verify-065-ambig'`
    )
    const twinTab = await db.query(
      `SELECT id FROM public.client_transactions('CLT-verify-065-twin-a') WHERE id = 'TXN-verify-065-ambig'
       UNION ALL
       SELECT id FROM public.client_transactions('CLT-verify-065-twin-b') WHERE id = 'TXN-verify-065-ambig'`
    )
    const amb = ambiguous.rows[0]
    if (amb?.method === "unresolved" && amb?.unresolved_reason === "ambiguous_text" && amb?.resolved_client_id == null && twinTab.rows.length === 0) {
      pass(results, "ambiguous_text", "a text matching two directory keys is on nobody's tab")
    } else {
      fail(results, "ambiguous_text", JSON.stringify({ amb, twins: twinTab.rows.length }))
    }

    const dangling = await db.query(
      `SELECT method, unresolved_reason, resolved_client_id
       FROM public.client_transaction_resolution
       WHERE transaction_id = 'TXN-verify-065-dangle'`
    )
    const textTab = await db.query(
      `SELECT id FROM public.client_transactions('CLT-verify-065-text') WHERE id = 'TXN-verify-065-dangle'`
    )
    const dang = dangling.rows[0]
    if (dang?.method === "unresolved" && dang?.unresolved_reason === "dangling_client_id" && dang?.resolved_client_id == null && textTab.rows.length === 0) {
      pass(results, "dangling_client_id", "CLT-verify-065-missing is not re-matched to Text Target")
    } else {
      fail(results, "dangling_client_id", JSON.stringify(dang))
    }

    const ownerRows = await db.query(
      `SELECT id, type FROM public.client_transactions('CLT-verify-065-owner') ORDER BY id`
    )
    const ownerIds = ownerRows.rows.map((row) => `${row.type}:${row.id}`).sort()
    if (ownerIds.join(",") === "POC Out:TXN-verify-065-poc,POC Return:TXN-verify-065-return") {
      pass(results, "non_sale", "POC Out and POC Return resolve by client_id and appear on the tab")
    } else {
      fail(results, "non_sale", ownerIds.join(", ") || "(none)")
    }

    async function signIn(role) {
      const email = `${EMAIL_PREFIX}${role}@test.local`
      const { data, error } = await service.auth.admin.createUser({ email, email_confirm: true })
      if (error) throw new Error(`createUser(${role}): ${error.message}`)
      userIds.push(data.user.id)
      const updated = await db.query(
        `UPDATE public.profiles SET role = $2::public.app_role, active = true WHERE id = $1`,
        [data.user.id, role]
      )
      if (updated.rowCount !== 1) throw new Error(`profile for ${role} was not updated`)
      const client = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
      const { data: link, error: linkError } = await service.auth.admin.generateLink({ type: "magiclink", email })
      if (linkError) throw new Error(`generateLink(${role}): ${linkError.message}`)
      const { data: sessionData, error: signInError } = await client.auth.verifyOtp({
        token_hash: link.properties.hashed_token,
        type: "magiclink",
      })
      if (signInError || !sessionData.session) throw new Error(`verifyOtp(${role}): ${signInError?.message ?? "no session"}`)
      return client
    }

    const viewer = await signIn("viewer")
    const sales = await signIn("sales")
    const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })

    const viewerCounts = await viewer.rpc("client_sale_dispatch_counts")
    const viewerRows = await viewer.rpc("client_transactions", { p_client_id: KUDZANAI })
    const salesRows = await sales.rpc("client_transactions", { p_client_id: KUDZANAI })
    const salesView = await sales.from("client_transaction_resolution").select("transaction_id").eq("transaction_id", FORTUNATE_SALES[0]).maybeSingle()
    const anonCounts = await anon.rpc("client_sale_dispatch_counts")
    const anonRows = await anon.rpc("client_transactions", { p_client_id: KUDZANAI })
    const viewerSaleCount = (viewerRows.data ?? []).filter((row) => row.type === "Sale").length
    const salesSaleCount = (salesRows.data ?? []).filter((row) => row.type === "Sale").length
    const viewerOk = !viewerCounts.error && (viewerCounts.data ?? []).some((row) => row.client_id === KUDZANAI && row.orders === 18)
    const salesOk =
      !viewerRows.error &&
      viewerSaleCount === 20 &&
      !salesRows.error &&
      salesSaleCount === 20 &&
      !salesView.error &&
      salesView.data?.transaction_id === FORTUNATE_SALES[0]
    const anonBlocked = Boolean(anonCounts.error) && Boolean(anonRows.error)
    if (viewerOk && salesOk && anonBlocked) {
      pass(results, "rls", "viewer and sales can read; anon cannot execute")
    } else {
      fail(
        results,
        "rls",
        JSON.stringify({
          viewer: viewerCounts.error?.message ?? viewerOk,
          sales: viewerRows.error?.message ?? salesView.error?.message ?? salesOk,
          anonCounts: anonCounts.error?.message ?? "allowed",
          anonRows: anonRows.error?.message ?? "allowed",
        })
      )
    }
  } finally {
    await cleanup()
    const residue = await db.query(
      `SELECT
         (SELECT count(*)::integer FROM public.transactions WHERE id LIKE $1 OR serial_number LIKE $1 OR batch_id LIKE $1) AS transactions,
         (SELECT count(*)::integer FROM public.clients WHERE id LIKE $2) AS clients,
         (SELECT count(*)::integer FROM auth.users WHERE email LIKE $3) AS users`,
      [`${PREFIX}%`, `CLT-${PREFIX}%`, `${EMAIL_PREFIX}%`]
    )
    const left = residue.rows[0]
    if (left.transactions === 0 && left.clients === 0 && left.users === 0) {
      pass(results, "residue", "no verify-065 clients, transactions, or users left")
    } else {
      fail(results, "residue", JSON.stringify(left))
    }
    await db.end()
  }

  const failed = Object.values(results).filter((row) => row.result === "FAIL")
  if (failed.length) {
    console.log(`\n${failed.length} failed`)
    process.exitCode = 1
  } else {
    console.log(`\n${Object.keys(results).length} passed`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
