/**
 * Verify 20261001160000_client_transaction_resolution.sql. Does not apply it.
 *
 * Sale counts are recomputed in this script from client_transaction_resolution
 * and active_transactions, then compared with client_sale_dispatch_counts().
 * Fixtures use the verify-065- prefix and are removed in finally.
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

const SALE_COUNT_SQL = `
  SELECT
    resolution.resolved_client_id AS client_id,
    count(DISTINCT resolution.batch_key)::integer AS orders,
    count(*)::integer AS units
  FROM public.client_transaction_resolution AS resolution
  JOIN public.active_transactions AS transactions
    ON transactions.id = resolution.transaction_id
  WHERE transactions.type = 'Sale'
    AND resolution.resolved_client_id IS NOT NULL
  GROUP BY resolution.resolved_client_id
`

function indexCounts(rows) {
  const byId = new Map()
  for (const row of rows) {
    byId.set(row.client_id, { orders: Number(row.orders), units: Number(row.units) })
  }
  return byId
}

function changedClients(before, after) {
  const changed = []
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const left = before.get(id)
    const right = after.get(id)
    if (!left || !right || left.orders !== right.orders || left.units !== right.units) changed.push(id)
  }
  return changed
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

  const pg = require("pg")
  const db = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
  await db.connect()
  const service = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const userIds = []
  const results = {}
  let startedAt = null
  let startCounts = null

  async function saleCounts() {
    const counted = await db.query(SALE_COUNT_SQL)
    return indexCounts(counted.rows)
  }

  async function foreignTouched(since) {
    const touched = await db.query(
      `SELECT DISTINCT resolution.resolved_client_id AS client_id
       FROM public.transactions AS txn
       JOIN public.client_transaction_resolution AS resolution
         ON resolution.transaction_id = txn.id
       WHERE txn.created_at >= $1
         AND resolution.resolved_client_id IS NOT NULL
         AND txn.id NOT LIKE '%verify-065-%'
         AND coalesce(txn.serial_number, '') NOT LIKE 'verify-065-%'
         AND coalesce(txn.batch_id, '') NOT LIKE 'verify-065-%'`,
      [since]
    )
    return new Set(touched.rows.map((row) => row.client_id))
  }

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

    const clock = await db.query(`SELECT clock_timestamp() AS started_at`)
    startedAt = clock.rows[0].started_at
    startCounts = await saleCounts()
    const live = await db.query(
      `SELECT client_id, orders, units, reliable
       FROM public.client_sale_dispatch_counts()
       ORDER BY client_id`
    )
    const liveCounts = indexCounts(live.rows)
    const mismatches = []
    for (const id of new Set([...startCounts.keys(), ...liveCounts.keys()])) {
      const expected = startCounts.get(id)
      const actual = liveCounts.get(id)
      const row = live.rows.find((item) => item.client_id === id)
      if (!expected || !actual || expected.orders !== actual.orders || expected.units !== actual.units || row?.reliable !== true) {
        mismatches.push(id)
      }
    }
    const orders = [...startCounts.values()].reduce((sum, row) => sum + row.orders, 0)
    const units = [...startCounts.values()].reduce((sum, row) => sum + row.units, 0)
    if (mismatches.length === 0) {
      pass(
        results,
        "snapshot",
        `${startCounts.size} clients, ${orders} orders, ${units} units match client_sale_dispatch_counts()`
      )
    } else {
      fail(
        results,
        "snapshot",
        `${mismatches.length} clients differ; sample ${mismatches.slice(0, 5).join(", ")}`
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
    if (
      kudz &&
      kudz.orders === kudzOrders &&
      kudz.units === kudzSales.length &&
      fortunateOnTab.length === 0
    ) {
      pass(results, "kudzanai", `${kudz.orders} orders / ${kudz.units} units, and none of the six Fortunate sales`)
    } else {
      fail(
        results,
        "kudzanai",
        `function ${kudz?.orders}/${kudz?.units}; tab sales ${kudzSales.length} in ${kudzOrders} batches; fortunate ${fortunateOnTab.length}`
      )
    }

    const kimIds = KIM_LAURENCE.map(([id]) => id)
    const kimIndependent = await db.query(
      `SELECT resolution.resolved_client_id AS client_id, max(left(transactions.date, 10)) AS last_activity_date
       FROM public.client_transaction_resolution AS resolution
       JOIN public.active_transactions AS transactions ON transactions.id = resolution.transaction_id
       WHERE resolution.resolved_client_id = ANY($1::text[])
       GROUP BY resolution.resolved_client_id
       ORDER BY client_id`,
      [kimIds]
    )
    const kim = await db.query(
      `SELECT client_id, last_activity_date
       FROM public.client_last_activity()
       WHERE client_id = ANY($1::text[])
       ORDER BY client_id`,
      [kimIds]
    )
    const kimGot = kim.rows.map((row) => `${row.client_id}=${row.last_activity_date}`).join(", ")
    const kimExpected = kimIndependent.rows.map((row) => `${row.client_id}=${row.last_activity_date}`).join(", ")
    if (kim.rows.length === kimIds.length && kimGot === kimExpected) {
      pass(results, "kim_laurence", "each Kim Laurence Group row matches its own active transactions")
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
       FROM public.client_sale_dispatch_counts()`
    )
    const heldCounts = indexCounts(held.rows)
    const touched = await foreignTouched(startedAt)
    const heldBad = changedClients(startCounts, heldCounts).filter(
      (id) => startCounts.has(id) && !touched.has(id) && !id.includes("verify-065-")
    )
    if (heldBad.length === 0) {
      pass(results, "snapshot_unchanged_by_fixtures", "existing clients keep their sale counts")
    } else {
      fail(results, "snapshot_unchanged_by_fixtures", `${heldBad.length} changed: ${heldBad.slice(0, 5).join(", ")}`)
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
    const kudzanaiNow = (viewerCounts.data ?? []).find((row) => row.client_id === KUDZANAI)
    const viewerOk = !viewerCounts.error && kudzanaiNow && viewerSaleCount === kudzanaiNow.units
    const salesOk =
      !viewerRows.error &&
      viewerSaleCount === kudzanaiNow?.units &&
      !salesRows.error &&
      salesSaleCount === kudzanaiNow?.units &&
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
    if (startCounts && startedAt) {
      const endCounts = await saleCounts()
      const touched = await foreignTouched(startedAt)
      const changed = changedClients(startCounts, endCounts)
      const unexplained = changed.filter((id) => !touched.has(id))
      const ignored = changed.filter((id) => touched.has(id))
      if (unexplained.length === 0) {
        pass(
          results,
          "snapshot_unchanged",
          ignored.length
            ? `unchanged except clients touched by other transactions: ${ignored.join(", ")}`
            : `${endCounts.size} clients unchanged`
        )
      } else {
        fail(
          results,
          "snapshot_unchanged",
          `${unexplained.length} clients changed without another user's transaction: ${unexplained.slice(0, 5).join(", ")}`
        )
      }
    }
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
    await Promise.race([db.end(), new Promise((resolve) => setTimeout(resolve, 2000))])
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
