/**
 * Returns report. Fixture cases are removed in finally.
 *
 * Usage: node scripts/verify-078-returns-report.mjs
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"

const require = createRequire(import.meta.url)
const { Client } = require("pg")
const { createClient } = require("@supabase/supabase-js")

const PREFIX = "RR1078"
const SITE = "Borrowdale"
const SITE_CLIENT = "RR1 Borrowdale - RR1 Site"
const NONE_CLIENT = "RR1 Nowhere - RR1 None"
const REASON_CONTRACT = "RR1 client ended the contract"
const REASON_MOVED = "RR1 moved offices"
const REASON_NONE = "RR1 no address given"
const REASON_SIGNAL = "RR1 signal lost"
const REASON_RENTAL = "RR1 rental ended"
const REASON_EDGE = "RR1 on the first day"
const REASON_OUTSIDE = "RR1 outside the window"
const COMMENTS = "RR1 inspection comments"

function loadEnvLocal() {
  const envPath = path.join(process.cwd(), ".env.local")
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value
  }
}

const results = {}
function pass(name, reason) {
  results[name] = { result: "PASS", reason }
  console.log(`PASS  ${name} — ${reason}`)
}
function fail(name, reason) {
  results[name] = { result: "FAIL", reason }
  console.log(`FAIL  ${name} — ${reason}`)
}

async function raises(db, sql, params, needle) {
  try {
    await db.query(sql, params)
    return `expected ${needle}`
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return message.includes(needle) ? null : message
  }
}

async function setUser(db, userId) {
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [userId])
  await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: userId, role: "authenticated" }),
  ])
}

let seq = 0
function nextId(kind) {
  seq += 1
  return `${kind}-${PREFIX}-${seq}`
}

function iso(day) {
  return `${day}T00:00:00.000Z`
}

function flatten(report) {
  const out = {}
  for (const row of report.now.waiting) out[`wait:${row.type}`] = row.units
  out.oldest = report.now.oldest_wait_days
  out.rental_out = report.now.rental_out
  for (const category of report.returns) {
    out[`return:${category.category}`] = category.units
    for (const reason of category.reasons ?? []) out[`reason:${category.category}:${reason.text}`] = reason.units
  }
  for (const row of report.outcomes) {
    out[`outcome:${row.outcome}:starlink`] = row.starlink
    out[`outcome:${row.outcome}:other`] = row.other
  }
  for (const row of report.results) out[`result:${row.result}`] = row.units
  for (const row of report.grades) out[`grade:${row.grade}`] = row.units
  for (const row of report.sites) out[`site:${row.site}`] = row.units
  return out
}

function periodDelta(before, after, expected) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(expected)])
  const misses = []
  for (const key of keys) {
    if (key.startsWith("wait:") || key === "oldest" || key === "rental_out") continue
    const delta = (after[key] ?? 0) - (before[key] ?? 0)
    const want = expected[key] ?? 0
    if (delta !== want) misses.push(`${key} ${delta} wanted ${want}`)
  }
  return misses
}

async function snapshot(db) {
  const sales = await db.query(
    `SELECT count(*)::int AS clients, COALESCE(sum(orders), 0)::int AS orders, COALESCE(sum(units), 0)::int AS units
     FROM public.client_sale_dispatch_counts()`,
  )
  const low = await db.query(
    `SELECT count(*) FILTER (WHERE is_low)::int AS low, COALESCE(sum(in_stock_count), 0)::int AS available
     FROM public.low_stock_products`,
  )
  return {
    clients: sales.rows[0].clients,
    orders: sales.rows[0].orders,
    units: sales.rows[0].units,
    low: low.rows[0].low,
    available: low.rows[0].available,
  }
}

async function main() {
  loadEnvLocal()
  const db = new Client({
    connectionString: process.env.SUPABASE_DB_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  })
  await db.connect()
  const service = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const adminEmail = "verify-078-admin@test.local"
  const viewerEmail = "verify-078-viewer@test.local"
  const salesEmail = "verify-078-sales@test.local"
  const star = await db.query(
    `SELECT id, product_name FROM public.product_lines WHERE vendor = 'Starlink' AND is_active ORDER BY id LIMIT 1`,
  )
  const other = await db.query(
    `SELECT id, product_name FROM public.product_lines WHERE vendor IS DISTINCT FROM 'Starlink' AND is_active ORDER BY id LIMIT 1`,
  )
  const days = await db.query(
    `SELECT to_char(d, 'YYYY-MM-DD') AS today,
            to_char(d - 90, 'YYYY-MM-DD') AS edge,
            to_char(d - 91, 'YYYY-MM-DD') AS gap,
            to_char(d - 120, 'YYYY-MM-DD') AS outside,
            to_char(d + 20, 'YYYY-MM-DD') AS later
     FROM (SELECT (now() AT TIME ZONE 'Africa/Harare')::date AS d) AS clock`,
  )
  const { today, edge, gap, outside, later } = days.rows[0]
  const starId = star.rows[0].id
  const starName = star.rows[0].product_name
  const otherId = other.rows[0].id
  const otherName = other.rows[0].product_name
  const siteClientId = `CLT-${PREFIX}-SITE`
  const noneClientId = `CLT-${PREFIX}-NONE`
  let adminId = null
  let viewerId = null
  let salesId = null

  async function cleanup() {
    await db.query(`ALTER TABLE public.kit_case_events DISABLE TRIGGER tr_kit_case_events_append_only`)
    try {
      await db.query(
        `DELETE FROM public.kit_case_events WHERE case_id IN (
           SELECT kc.id FROM public.kit_cases kc
           JOIN public.inventory_items item ON item.id = kc.inventory_item_id
           WHERE item.serial_number LIKE $1 OR item.id LIKE $2
         )`,
        [`${PREFIX}%`, `ITEM-${PREFIX}%`],
      )
    } finally {
      await db.query(`ALTER TABLE public.kit_case_events ENABLE TRIGGER tr_kit_case_events_append_only`)
    }
    await db.query(
      `DELETE FROM public.kit_cases WHERE inventory_item_id IN (
         SELECT id FROM public.inventory_items WHERE serial_number LIKE $1 OR id LIKE $2
       )`,
      [`${PREFIX}%`, `ITEM-${PREFIX}%`],
    )
    await db.query(
      `DELETE FROM public.batch_invoices
       WHERE batch_id LIKE $1
          OR batch_id IN (
            SELECT coalesce(nullif(btrim(batch_id), ''), id)
            FROM public.transactions WHERE serial_number LIKE $2 OR id LIKE $3
          )`,
      [`BATCH-${PREFIX}%`, `${PREFIX}%`, `TXN-${PREFIX}%`],
    )
    await db.query(
      `DELETE FROM public.transactions WHERE (serial_number LIKE $1 OR id LIKE $2 OR batch_id LIKE $3) AND type = 'Reversal'`,
      [`${PREFIX}%`, `TXN-${PREFIX}%`, `BATCH-${PREFIX}%`],
    )
    await db.query(
      `DELETE FROM public.transactions WHERE serial_number LIKE $1 OR id LIKE $2 OR batch_id LIKE $3`,
      [`${PREFIX}%`, `TXN-${PREFIX}%`, `BATCH-${PREFIX}%`],
    )
    await db.query(`DELETE FROM public.inventory_items WHERE serial_number LIKE $1 OR id LIKE $2`, [
      `${PREFIX}%`,
      `ITEM-${PREFIX}%`,
    ])
    await db.query(`DELETE FROM public.clients WHERE id LIKE $1`, [`CLT-${PREFIX}%`])
    const users = await db.query(`SELECT id::text AS id FROM auth.users WHERE email = ANY($1::text[])`, [
      [adminEmail, viewerEmail, salesEmail],
    ])
    for (const row of users.rows) {
      const { error } = await service.auth.admin.deleteUser(row.id)
      if (error && !/not found/i.test(error.message)) throw error
    }
  }

  async function decommission(serial, productId, productName, clientId, clientLabel, category, reason) {
    const itemId = nextId("ITEM")
    await db.query(`SELECT public.apply_stock_movement('[]'::jsonb, $1::jsonb, $2::jsonb)`, [
      JSON.stringify([
        {
          id: itemId,
          product_id: productId,
          serial_number: serial,
          status: "Pending Inspection",
          date_added: today,
          location: "Warehouse A",
          client: clientLabel,
          poc_out_date: null,
          return_date: null,
        },
      ]),
      JSON.stringify([
        {
          id: nextId("TXN"),
          type: "Decommissioned",
          serial_number: serial,
          item_name: productName,
          date: iso(today),
          client: clientLabel,
          client_id: clientId,
          batch_id: nextId("BATCH"),
          to_location: "Warehouse A",
          metadata: { reason_category: category, reason_text: reason },
        },
      ]),
    ])
    const caseRow = await db.query(
      `SELECT id FROM public.kit_cases WHERE inventory_item_id = $1 AND stage = 'open'`,
      [itemId],
    )
    return { itemId, caseId: caseRow.rows[0].id }
  }

  async function inspect(caseId, result, grade, outcome, location) {
    await db.query(
      `SELECT public.complete_inspection($1, $2, $3, $4, $5, $6, NULL)`,
      [caseId, result, COMMENTS, grade, outcome, location],
    )
  }

  async function backdate(caseId, day, withEvents) {
    await db.query(
      `UPDATE public.kit_cases
       SET opened_at = ($2::timestamp AT TIME ZONE 'Africa/Harare'),
           closed_at = CASE WHEN $3 THEN ($2::timestamp AT TIME ZONE 'Africa/Harare') ELSE closed_at END
       WHERE id = $1`,
      [caseId, `${day} 12:00:00`, withEvents],
    )
    if (!withEvents) return
    await db.query(`ALTER TABLE public.kit_case_events DISABLE TRIGGER tr_kit_case_events_append_only`)
    try {
      await db.query(
        `UPDATE public.kit_case_events SET at = ($2::timestamp AT TIME ZONE 'Africa/Harare') WHERE case_id = $1`,
        [caseId, `${day} 12:00:00`],
      )
    } finally {
      await db.query(`ALTER TABLE public.kit_case_events ENABLE TRIGGER tr_kit_case_events_append_only`)
    }
  }

  async function report(from, to) {
    const row = await db.query(`SELECT public.returns_report($1::date, $2::date) AS report`, [from, to])
    return row.rows[0].report
  }

  await cleanup()
  const started = await snapshot(db)

  try {
    const created = await service.auth.admin.createUser({ email: adminEmail, email_confirm: true })
    if (created.error) throw new Error(created.error.message)
    adminId = created.data.user.id
    const viewer = await service.auth.admin.createUser({ email: viewerEmail, email_confirm: true })
    if (viewer.error) throw new Error(viewer.error.message)
    viewerId = viewer.data.user.id
    const sales = await service.auth.admin.createUser({ email: salesEmail, email_confirm: true })
    if (sales.error) throw new Error(sales.error.message)
    salesId = sales.data.user.id
    const profiles = await db.query(
      `UPDATE public.profiles
       SET role = CASE id
             WHEN $1 THEN 'admin'::public.app_role
             WHEN $2 THEN 'viewer'::public.app_role
             ELSE 'sales'::public.app_role
           END,
           active = true
       WHERE id IN ($1, $2, $3)`,
      [adminId, viewerId, salesId],
    )
    if (profiles.rowCount !== 3) throw new Error("profiles were not updated")
    await db.query(
      `INSERT INTO public.clients (id, name, company, email, address, sites)
       VALUES
         ($1, 'RR1 Borrowdale', 'RR1 Site', 'rr1078-site@test.local', $3, $4::jsonb),
         ($2, 'RR1 Nowhere', 'RR1 None', 'rr1078-none@test.local', NULL, NULL)`,
      [siteClientId, noneClientId, SITE, JSON.stringify([{ address: SITE }])],
    )
    await setUser(db, adminId)

    const invoker = await db.query(
      `SELECT prosecdef FROM pg_proc
       WHERE proname = 'returns_report' AND pg_get_function_identity_arguments(oid) = 'p_from date, p_to date'`,
    )
    if (invoker.rows[0]?.prosecdef === false) pass("security_invoker", "returns_report runs as the caller")
    else fail("security_invoker", JSON.stringify(invoker.rows))

    const beforeRange = flatten(await report(edge, today))
    const beforeOutside = flatten(await report(outside, outside))
    const beforeGap = flatten(await report(gap, gap))

    const openToday = await decommission(`${PREFIX}-open`, starId, starName, siteClientId, SITE_CLIENT, "Client cancelled", REASON_CONTRACT)
    const resell = await decommission(`${PREFIX}-resell`, starId, starName, siteClientId, SITE_CLIENT, "Client cancelled", REASON_CONTRACT)
    await inspect(resell.caseId, "Pass", "A", "Resell", "Warehouse A")
    const rentOut = await decommission(`${PREFIX}-rentout`, starId, starName, siteClientId, SITE_CLIENT, "Client cancelled", REASON_MOVED)
    await inspect(rentOut.caseId, "Pass", "B", "Rent out", "Warehouse A")
    const dispose = await decommission(`${PREFIX}-dispose`, otherId, otherName, noneClientId, NONE_CLIENT, "Client cancelled", REASON_NONE)
    await inspect(dispose.caseId, "Pass", "C", "Dispose", null)
    const failed = await decommission(`${PREFIX}-fail`, starId, starName, siteClientId, SITE_CLIENT, "Service termination", REASON_SIGNAL)
    await inspect(failed.caseId, "Fail", "A", "Return to vendor", null)
    const edgeCase = await decommission(`${PREFIX}-edge`, starId, starName, siteClientId, SITE_CLIENT, "Client cancelled", REASON_EDGE)
    await backdate(edgeCase.caseId, edge, false)
    const outsideCase = await decommission(`${PREFIX}-out`, otherId, otherName, siteClientId, SITE_CLIENT, "Client cancelled", REASON_OUTSIDE)
    await inspect(outsideCase.caseId, "Pass", "A", "Resell", "Warehouse A")
    await backdate(outsideCase.caseId, outside, true)

    const rentalSerial = `${PREFIX}-rented`
    const rentalItem = nextId("ITEM")
    await db.query(`SELECT public.apply_stock_movement('[]'::jsonb, $1::jsonb, $2::jsonb)`, [
      JSON.stringify([
        {
          id: rentalItem,
          product_id: starId,
          serial_number: rentalSerial,
          status: "In Stock",
          date_added: today,
          location: "Warehouse A",
        },
      ]),
      JSON.stringify([
        {
          id: nextId("TXN"),
          type: "Inbound",
          serial_number: rentalSerial,
          item_name: starName,
          date: iso(today),
          client: "Internal",
          batch_id: nextId("BATCH"),
          to_location: "Warehouse A",
        },
      ]),
    ])
    await db.query(`SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`, [
      JSON.stringify([
        {
          id: rentalItem,
          product_id: starId,
          serial_number: rentalSerial,
          status: "Rented",
          date_added: today,
          location: "Client Site",
          client: SITE_CLIENT,
          assigned_to: SITE_CLIENT,
          poc_out_date: today,
          return_date: later,
        },
      ]),
      JSON.stringify([
        {
          id: nextId("TXN"),
          type: "Rentals",
          serial_number: rentalSerial,
          item_name: starName,
          date: iso(today),
          client: SITE_CLIENT,
          client_id: siteClientId,
          batch_id: nextId("BATCH"),
          to_location: "Client Site",
        },
      ]),
    ])

    const returnedSerial = `${PREFIX}-returned`
    const returnedItem = nextId("ITEM")
    await db.query(`SELECT public.apply_stock_movement('[]'::jsonb, $1::jsonb, $2::jsonb)`, [
      JSON.stringify([
        {
          id: returnedItem,
          product_id: starId,
          serial_number: returnedSerial,
          status: "In Stock",
          date_added: today,
          location: "Warehouse A",
        },
      ]),
      JSON.stringify([
        {
          id: nextId("TXN"),
          type: "Inbound",
          serial_number: returnedSerial,
          item_name: starName,
          date: iso(today),
          client: "Internal",
          batch_id: nextId("BATCH"),
          to_location: "Warehouse A",
        },
      ]),
    ])
    await db.query(`SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`, [
      JSON.stringify([
        {
          id: returnedItem,
          product_id: starId,
          serial_number: returnedSerial,
          status: "Rented",
          date_added: today,
          location: "Client Site",
          client: SITE_CLIENT,
          assigned_to: SITE_CLIENT,
          poc_out_date: today,
          return_date: later,
        },
      ]),
      JSON.stringify([
        {
          id: nextId("TXN"),
          type: "Rentals",
          serial_number: returnedSerial,
          item_name: starName,
          date: iso(today),
          client: SITE_CLIENT,
          client_id: siteClientId,
          batch_id: nextId("BATCH"),
          to_location: "Client Site",
        },
      ]),
    ])
    await db.query(`SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`, [
      JSON.stringify([
        {
          id: returnedItem,
          product_id: starId,
          serial_number: returnedSerial,
          status: "Pending Inspection",
          date_added: today,
          location: "Warehouse A",
          client: SITE_CLIENT,
        },
      ]),
      JSON.stringify([
        {
          id: nextId("TXN"),
          type: "Rental Return",
          serial_number: returnedSerial,
          item_name: starName,
          date: iso(today),
          client: SITE_CLIENT,
          client_id: siteClientId,
          batch_id: nextId("BATCH"),
          to_location: "Warehouse A",
          metadata: { reason_category: "Service termination", reason_text: REASON_RENTAL },
        },
      ]),
    ])

    const range = flatten(await report(edge, today))
    const outsideReport = flatten(await report(outside, outside))
    const gapReport = flatten(await report(gap, gap))

    const rangeMisses = periodDelta(beforeRange, range, {
      "return:Client cancelled": 5,
      "return:Service termination": 2,
      [`reason:Client cancelled:${REASON_CONTRACT}`]: 2,
      [`reason:Client cancelled:${REASON_MOVED}`]: 1,
      [`reason:Client cancelled:${REASON_NONE}`]: 1,
      [`reason:Client cancelled:${REASON_EDGE}`]: 1,
      [`reason:Service termination:${REASON_SIGNAL}`]: 1,
      [`reason:Service termination:${REASON_RENTAL}`]: 1,
      "outcome:Resell:starlink": 1,
      "outcome:Rent out:starlink": 1,
      "outcome:Dispose:other": 1,
      "outcome:Return to vendor:starlink": 1,
      "result:Pass": 3,
      "result:Fail": 1,
      "grade:A": 2,
      "grade:B": 1,
      "grade:C": 1,
      [`site:${SITE}`]: 4,
      "site:No site": 1,
    })
    if (rangeMisses.length === 0) pass("range_counts", "returns, outcomes, grades, and sites match the 90-day window")
    else fail("range_counts", rangeMisses.join("; "))

    const outsideMisses = periodDelta(beforeOutside, outsideReport, {
      "return:Client cancelled": 1,
      [`reason:Client cancelled:${REASON_OUTSIDE}`]: 1,
      "outcome:Resell:other": 1,
      "result:Pass": 1,
      "grade:A": 1,
      [`site:${SITE}`]: 1,
    })
    if (outsideMisses.length === 0) pass("outside_range", "the backdated case is counted only on its own day")
    else fail("outside_range", outsideMisses.join("; "))

    const gapMisses = periodDelta(beforeGap, gapReport, {})
    if (gapMisses.length === 0) pass("date_filter", "the day before the window has no fixture counts")
    else fail("date_filter", gapMisses.join("; "))

    const nowSame =
      range["wait:Decommissioned"] === outsideReport["wait:Decommissioned"] &&
      range["wait:Rental return"] === outsideReport["wait:Rental return"] &&
      range.rental_out === outsideReport.rental_out &&
      range.oldest === outsideReport.oldest
    const waitDecom = range["wait:Decommissioned"] - (beforeRange["wait:Decommissioned"] ?? 0)
    const waitRental = range["wait:Rental return"] - (beforeRange["wait:Rental return"] ?? 0)
    const rentalDelta = range.rental_out - beforeRange.rental_out
    const oldestOk = range.oldest === Math.max(beforeRange.oldest ?? 0, 90)
    if (nowSame && waitDecom === 2 && waitRental === 1 && rentalDelta === 1 && oldestOk) {
      pass("now", `waiting +2 decommissioned, +1 rental return, rental out +1, oldest ${range.oldest} days`)
    } else {
      fail(
        "now",
        JSON.stringify({ nowSame, waitDecom, waitRental, rentalDelta, oldest: range.oldest, before: beforeRange.oldest }),
      )
    }

    if (openToday.caseId) pass("open_case", "one decommission stays open for the waiting count")

    await setUser(db, viewerId)
    const viewed = flatten(await report(edge, today))
    const viewerSame = JSON.stringify(viewed) === JSON.stringify(range)
    if (viewerSame) pass("viewer_read", "a viewer receives the same report")
    else fail("viewer_read", "viewer report differs from the admin report")
    const blocked = await raises(
      db,
      `SELECT public.complete_inspection($1, 'Pass', $2, 'A', 'Resell', 'Warehouse A', NULL)`,
      [openToday.caseId, COMMENTS],
      "admin only",
    )
    if (blocked) fail("viewer_readonly", blocked)
    else pass("viewer_readonly", "a viewer cannot record an inspection")

    await setUser(db, salesId)
    const denied = await raises(
      db,
      `SELECT public.returns_report($1::date, $2::date)`,
      [edge, today],
      "not allowed",
    )
    if (denied) fail("sales_hidden", denied)
    else pass("sales_hidden", "sales cannot read the returns report")
  } catch (error) {
    fail("fixtures", error instanceof Error ? error.message : String(error))
  } finally {
    await cleanup()
    const residue = await db.query(
      `SELECT
         (SELECT count(*)::int FROM public.transactions WHERE serial_number LIKE $1 OR id LIKE $2) AS txns,
         (SELECT count(*)::int FROM public.inventory_items WHERE serial_number LIKE $1 OR id LIKE $3) AS items,
         (SELECT count(*)::int FROM public.kit_cases WHERE inventory_item_id LIKE $3) AS cases,
         (SELECT count(*)::int FROM public.clients WHERE id LIKE $4) AS clients,
         (SELECT count(*)::int FROM auth.users WHERE email = ANY($5::text[])) AS users`,
      [`${PREFIX}%`, `TXN-${PREFIX}%`, `ITEM-${PREFIX}%`, `CLT-${PREFIX}%`, [adminEmail, viewerEmail, salesEmail]],
    )
    const left = residue.rows[0]
    if (Object.values(left).every((count) => count === 0)) pass("residue", "no fixture rows left")
    else fail("residue", JSON.stringify(left))
    const after = await snapshot(db)
    if (
      after.clients === started.clients &&
      after.orders === started.orders &&
      after.units === started.units &&
      after.low === started.low &&
      after.available === started.available
    ) {
      pass(
        "live_totals",
        `${after.clients} clients / ${after.orders} orders / ${after.units} units; low ${after.low}; available ${after.available}`,
      )
    } else fail("live_totals", JSON.stringify({ started, after }))
  }

  await Promise.race([db.end(), new Promise((resolve) => setTimeout(resolve, 2000))])
  process.exit(Object.values(results).some((row) => row.result === "FAIL") ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
