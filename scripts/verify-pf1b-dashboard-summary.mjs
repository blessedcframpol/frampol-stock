/**
 * PF1b — dashboard_summary numbers match JS over the full ledger.
 *
 *   node --require ./scripts/dev/tls-classic.cjs scripts/rehearse-migration.mjs \
 *     supabase/migrations/20261027120000_pf1b_dashboard_summary.sql \
 *     scripts/verify-pf1b-dashboard-summary.mjs
 *   node --require ./scripts/dev/tls-classic.cjs scripts/verify-pf1b-dashboard-summary.mjs
 */
import { createRequire } from "module"
import { runVerifyCli } from "./verify-harness.mjs"

const require = createRequire(import.meta.url)
const {
  todayBusinessDate,
  DEFAULT_ORG_TIMEZONE,
} = require("../lib/business-date.mjs")

export const MARKERS = [{ label: "noop", sql: "SELECT 0::int AS n", params: [] }]

const MONTH_LABELS = {
  "01": "Jan",
  "02": "Feb",
  "03": "Mar",
  "04": "Apr",
  "05": "May",
  "06": "Jun",
  "07": "Jul",
  "08": "Aug",
  "09": "Sep",
  "10": "Oct",
  "11": "Nov",
  "12": "Dec",
}

function vendorKey(vendor) {
  const trimmed = (vendor ?? "").trim()
  return trimmed || "General"
}

function lastSix(businessDate) {
  const [year, month] = businessDate.slice(0, 7).split("-").map(Number)
  const months = []
  for (let offset = 5; offset >= 0; offset -= 1) {
    const cursor = new Date(Date.UTC(year, month - 1 - offset, 1))
    months.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`)
  }
  return months
}

function computeJs(inventory, sales, businessDate) {
  let in_stock_sale = 0
  let in_stock_rental = 0
  let in_stock_demo = 0
  let items_sold = 0
  let poc_active = 0
  const inStockVendor = new Map()
  const allVendor = new Map()
  for (const item of inventory) {
    const v = vendorKey(item.vendor)
    allVendor.set(v, (allVendor.get(v) ?? 0) + 1)
    if (item.status === "Sold") items_sold += 1
    if (item.status === "POC") poc_active += 1
    if (item.status !== "In Stock") continue
    inStockVendor.set(v, (inStockVendor.get(v) ?? 0) + 1)
    const pool = item.stock_pool?.trim() || "sale"
    if (pool === "rental") in_stock_rental += 1
    else if (pool === "demo") in_stock_demo += 1
    else in_stock_sale += 1
  }
  const sortVendors = (map) =>
    [...map.entries()]
      .map(([vendor, units]) => ({ vendor, units }))
      .sort((a, b) => b.units - a.units || a.vendor.localeCompare(b.vendor))

  const months = lastSix(businessDate)
  const counts = new Map(months.map((m) => [m, { units: 0, internal_units: 0 }]))
  for (const txn of sales) {
    const monthKey = (txn.date ?? "").slice(0, 7)
    if (!counts.has(monthKey)) continue
    const row = counts.get(monthKey)
    row.units += 1
    const kind = txn.metadata?.not_invoiced_kind ?? ""
    if (txn.invoice_number === "00000" || kind === "internal") row.internal_units += 1
  }
  const monthly_sales = months.map((month_key) => ({
    month_key,
    month: MONTH_LABELS[month_key.slice(5, 7)] ?? month_key,
    units: counts.get(month_key).units,
    internal_units: counts.get(month_key).internal_units,
    internal_label: "Internal",
  }))

  return {
    in_stock_sale,
    in_stock_rental,
    in_stock_demo,
    items_sold,
    poc_active,
    in_stock_by_vendor: sortVendors(inStockVendor),
    all_units_by_vendor: sortVendors(allVendor),
    monthly_sales,
  }
}

function normalizeVendors(rows) {
  return (rows ?? []).map((r) => ({ vendor: r.vendor, units: Number(r.units) }))
}

function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

export async function runChecks(ctx) {
  const { db, pass, fail } = ctx
  await db.query(`SET LOCAL statement_timeout = '180s'`)

  const fn = await db.query(
    `SELECT p.prosecdef AS is_definer,
            has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
            has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'dashboard_summary'
       AND pg_get_function_identity_arguments(p.oid) = ''`,
  )
  if (fn.rows.length !== 1) {
    fail("fn_exists", "dashboard_summary() missing")
    return
  }
  const meta = fn.rows[0]
  if (meta.is_definer === false) pass("security_invoker", "SECURITY INVOKER")
  else fail("security_invoker", "expected INVOKER")
  if (!meta.anon_exec && !meta.public_exec) pass("grants_revoked", "anon/PUBLIC revoked")
  else fail("grants_revoked", JSON.stringify(meta))
  if (meta.auth_exec) pass("grants_auth", "authenticated EXECUTE")
  else fail("grants_auth", "missing")

  const tzRow = await db.query(
    `SELECT coalesce(nullif(btrim(timezone), ''), $1) AS tz FROM public.app_settings WHERE id IS TRUE`,
    [DEFAULT_ORG_TIMEZONE],
  )
  const tz = tzRow.rows[0]?.tz || DEFAULT_ORG_TIMEZONE
  const businessDate = todayBusinessDate(tz)

  const inv = await db.query(
    `SELECT item.status, item.stock_pool, pl.vendor
     FROM public.inventory_items AS item
     LEFT JOIN public.product_lines AS pl ON pl.id = item.product_id
     WHERE item.deleted_at IS NULL`,
  )
  const sales = await db.query(
    `SELECT date, invoice_number, metadata
     FROM public.active_transactions WHERE type = 'Sale'`,
  )
  const expected = computeJs(inv.rows, sales.rows, businessDate)

  const gotRow = await db.query(`SELECT public.dashboard_summary() AS summary`)
  const got = gotRow.rows[0]?.summary
  if (!got) {
    fail("summary", "null")
    return
  }

  const scalarKeys = [
    "in_stock_sale",
    "in_stock_rental",
    "in_stock_demo",
    "items_sold",
    "poc_active",
  ]
  const scalarFail = []
  for (const k of scalarKeys) {
    if (got[k] !== expected[k]) scalarFail.push({ k, got: got[k], expected: expected[k] })
  }
  if (scalarFail.length === 0) pass("stat_cards", JSON.stringify(Object.fromEntries(scalarKeys.map((k) => [k, got[k]]))))
  else fail("stat_cards", JSON.stringify(scalarFail))

  if (eq(normalizeVendors(got.in_stock_by_vendor), expected.in_stock_by_vendor)) {
    pass("in_stock_by_vendor", `${got.in_stock_by_vendor.length} vendors`)
  } else {
    fail(
      "in_stock_by_vendor",
      JSON.stringify({
        got: normalizeVendors(got.in_stock_by_vendor).slice(0, 5),
        expected: expected.in_stock_by_vendor.slice(0, 5),
      }),
    )
  }

  if (eq(normalizeVendors(got.all_units_by_vendor), expected.all_units_by_vendor)) {
    pass("all_units_by_vendor", `${got.all_units_by_vendor.length} vendors`)
  } else {
    fail(
      "all_units_by_vendor",
      JSON.stringify({
        got: normalizeVendors(got.all_units_by_vendor).slice(0, 5),
        expected: expected.all_units_by_vendor.slice(0, 5),
      }),
    )
  }

  // Month labels from Postgres to_char('Mon') may be locale-dependent; compare keys + units.
  const gotMonths = (got.monthly_sales ?? []).map((r) => ({
    month_key: r.month_key,
    units: r.units,
    internal_units: r.internal_units,
    internal_label: r.internal_label,
  }))
  const expMonths = expected.monthly_sales.map((r) => ({
    month_key: r.month_key,
    units: r.units,
    internal_units: r.internal_units,
    internal_label: r.internal_label,
  }))
  if (eq(gotMonths, expMonths)) {
    pass("monthly_sales", JSON.stringify(gotMonths))
  } else {
    fail("monthly_sales", JSON.stringify({ got: gotMonths, expected: expMonths, businessDate, tz }))
  }
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-pf1b-dashboard-summary.mjs")
if (isMain) {
  runVerifyCli({ markers: MARKERS, timeoutMs: 300_000, label: "pf1b-dashboard-summary" }, runChecks)
}
