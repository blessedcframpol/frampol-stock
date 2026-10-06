/**
 * Kit history panel. One fixture kit walks the full path, then every row is removed.
 *
 * Usage: node scripts/verify-077-kit-history.mjs
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"

const require = createRequire(import.meta.url)
const { Client } = require("pg")
const { createClient } = require("@supabase/supabase-js")

const PREFIX = "H1077"
const HOLDER = "H1077 Holder - H1077 Co"
const REVERSE_REASON = "H1077 reversal of the first POC out"
const RESTORE_REASON = "H1077 restore of the first POC out"
const EXTEND_REASON = "H1077 extend the return date"
const CANCEL_REASON = "H1077 cancel that extension"
const DECOM_REASON = "H1077 client ended the service"

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

function short(ymd) {
  return `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`
}

function daysBetween(start, end) {
  const ms = Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)
  return Math.round(ms / 86400000)
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
  const adminEmail = "verify-077-admin@test.local"
  const viewerEmail = "verify-077-viewer@test.local"
  const star = await db.query(
    `SELECT id, product_name FROM public.product_lines WHERE vendor = 'Starlink' AND is_active ORDER BY id LIMIT 1`,
  )
  const days = await db.query(
    `SELECT to_char(d, 'YYYY-MM-DD') AS today,
            to_char(d - 35, 'YYYY-MM-DD') AS d35,
            to_char(d - 30, 'YYYY-MM-DD') AS d30,
            to_char(d - 24, 'YYYY-MM-DD') AS d24,
            to_char(d - 18, 'YYYY-MM-DD') AS d18,
            to_char(d - 12, 'YYYY-MM-DD') AS d12,
            to_char(d - 6, 'YYYY-MM-DD') AS d6,
            to_char(d + 20, 'YYYY-MM-DD') AS later
     FROM (SELECT (now() AT TIME ZONE 'Africa/Harare')::date AS d) AS clock`,
  )
  const { today, d35, d30, d24, d18, d12, d6, later } = days.rows[0]
  const starId = star.rows[0].id
  const starName = star.rows[0].product_name
  const clientId = `CLT-${PREFIX}`
  let adminId = null
  let viewerId = null

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
    await db.query(`ALTER TABLE public.stock_pool_changes DISABLE TRIGGER tr_stock_pool_changes_append_only`)
    try {
      await db.query(
        `DELETE FROM public.stock_pool_changes WHERE serial_number LIKE $1 OR inventory_item_id LIKE $2`,
        [`${PREFIX}%`, `ITEM-${PREFIX}%`],
      )
    } finally {
      await db.query(`ALTER TABLE public.stock_pool_changes ENABLE TRIGGER tr_stock_pool_changes_append_only`)
    }
    await db.query(
      `DELETE FROM public.holding_extensions WHERE serial_number LIKE $1 OR item_id LIKE $2`,
      [`${PREFIX}%`, `ITEM-${PREFIX}%`],
    )
    await db.query(
      `DELETE FROM public.batch_restores
       WHERE batch_id LIKE $1
          OR batch_id IN (SELECT batch_id FROM public.transactions WHERE serial_number LIKE $2)`,
      [`BATCH-${PREFIX}%`, `${PREFIX}%`],
    )
    await db.query(
      `DELETE FROM public.batch_reversals
       WHERE batch_id LIKE $1
          OR batch_id IN (SELECT batch_id FROM public.transactions WHERE serial_number LIKE $2)`,
      [`BATCH-${PREFIX}%`, `${PREFIX}%`],
    )
    await db.query(
      `DELETE FROM public.batch_invoices
       WHERE batch_id LIKE $1
          OR batch_id IN (
            SELECT coalesce(nullif(btrim(batch_id), ''), id)
            FROM public.transactions
            WHERE serial_number LIKE $2 OR id LIKE $3 OR batch_id LIKE $1
          )`,
      [`BATCH-${PREFIX}%`, `${PREFIX}%`, `TXN-${PREFIX}%`],
    )
    await db.query(
      `DELETE FROM public.transactions
       WHERE (serial_number LIKE $1 OR id LIKE $2 OR batch_id LIKE $3)
         AND type = 'Reversal'`,
      [`${PREFIX}%`, `TXN-${PREFIX}%`, `BATCH-${PREFIX}%`],
    )
    await db.query(
      `DELETE FROM public.transactions
       WHERE serial_number LIKE $1 OR id LIKE $2 OR batch_id LIKE $3`,
      [`${PREFIX}%`, `TXN-${PREFIX}%`, `BATCH-${PREFIX}%`],
    )
    await db.query(`DELETE FROM public.inventory_items WHERE serial_number LIKE $1 OR id LIKE $2`, [
      `${PREFIX}%`,
      `ITEM-${PREFIX}%`,
    ])
    await db.query(`DELETE FROM public.clients WHERE id = $1`, [clientId])
    const users = await db.query(`SELECT id::text AS id FROM auth.users WHERE email = ANY($1::text[])`, [
      [adminEmail, viewerEmail],
    ])
    for (const row of users.rows) {
      const { error } = await service.auth.admin.deleteUser(row.id)
      if (error && !/not found/i.test(error.message)) throw error
    }
  }

  async function move(serial, type, status, location, extra = {}) {
    const current = await db.query(
      `SELECT id FROM public.inventory_items WHERE serial_number = $1 AND deleted_at IS NULL`,
      [serial],
    )
    const txnId = extra.txnId ?? nextId("TXN")
    const batchId = extra.batchId ?? nextId("BATCH")
    await db.query(`SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`, [
      JSON.stringify([
        {
          id: current.rows[0].id,
          product_id: starId,
          serial_number: serial,
          status,
          date_added: d35,
          location,
          client: extra.client ?? null,
          assigned_to: extra.assigned_to ?? null,
          poc_out_date: extra.poc_out_date ?? null,
          return_date: extra.return_date ?? null,
        },
      ]),
      JSON.stringify([
        {
          id: txnId,
          type,
          serial_number: serial,
          item_name: starName,
          date: extra.date,
          client: extra.txnClient ?? extra.client ?? "Internal",
          client_id: extra.client_id ?? null,
          invoice_number: extra.invoice_number ?? null,
          batch_id: batchId,
          to_location: location,
          metadata: extra.metadata ?? null,
          created_by: extra.created_by ?? null,
          return_pool: extra.return_pool ?? null,
        },
      ]),
    ])
    return { txnId, batchId, itemId: current.rows[0].id }
  }

  async function inbound(serial) {
    const itemId = nextId("ITEM")
    const txnId = nextId("TXN")
    const batchId = nextId("BATCH")
    await db.query(`SELECT public.apply_stock_movement('[]'::jsonb, $1::jsonb, $2::jsonb)`, [
      JSON.stringify([
        {
          id: itemId,
          product_id: starId,
          serial_number: serial,
          status: "In Stock",
          date_added: d35,
          location: "Warehouse A",
        },
      ]),
      JSON.stringify([
        {
          id: txnId,
          type: "Inbound",
          serial_number: serial,
          item_name: starName,
          date: iso(d35),
          client: "Internal",
          batch_id: batchId,
          to_location: "Warehouse A",
        },
      ]),
    ])
    return { itemId }
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
    const profiles = await db.query(
      `UPDATE public.profiles SET role = CASE id WHEN $1 THEN 'admin'::public.app_role ELSE 'viewer'::public.app_role END,
              active = true
       WHERE id IN ($1, $2)`,
      [adminId, viewerId],
    )
    if (profiles.rowCount !== 2) throw new Error("profiles were not updated")
    await db.query(
      `INSERT INTO public.clients (id, name, company, email, phone, address)
       VALUES ($1, 'H1077 Holder', 'H1077 Co', 'h1077@test.local', '000', 'Test')`,
      [clientId],
    )
    await setUser(db, adminId)

    const invoker = await db.query(
      `SELECT prosecdef FROM pg_proc WHERE proname = 'kit_history' AND pg_get_function_identity_arguments(oid) = 'p_item_id text'`,
    )
    if (invoker.rows[0]?.prosecdef === false) pass("security_invoker", "kit_history runs as the caller")
    else fail("security_invoker", JSON.stringify(invoker.rows))

    const serial = `${PREFIX}-kit`
    const createdItem = await inbound(serial)
    const firstOut = await move(serial, "POC Out", "POC", "Client Site", {
      date: iso(d30),
      client: HOLDER,
      assigned_to: HOLDER,
      txnClient: HOLDER,
      client_id: clientId,
      poc_out_date: d30,
      return_date: d24,
    })
    await db.query(`SELECT public.reverse_quick_scan_batch($1, $2, NULL, '[]'::jsonb, '[]'::jsonb)`, [
      firstOut.batchId,
      REVERSE_REASON,
    ])
    await db.query(`SELECT public.restore_batch($1, $2)`, [firstOut.batchId, RESTORE_REASON])
    await move(serial, "POC Return", "In Stock", "Warehouse A", {
      date: iso(d24),
      client: null,
      txnClient: HOLDER,
      client_id: clientId,
      return_pool: "demo",
      metadata: null,
    })
    await move(serial, "POC Out", "POC", "Client Site", {
      date: iso(d18),
      client: HOLDER,
      assigned_to: HOLDER,
      txnClient: HOLDER,
      client_id: clientId,
      poc_out_date: d18,
      return_date: d6,
    })
    await db.query(`SELECT public.extend_holding($1, $2, $3)`, [createdItem.itemId, later, EXTEND_REASON])
    const extension = await db.query(
      `SELECT id FROM public.holding_extensions WHERE item_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [createdItem.itemId],
    )
    await db.query(`SELECT public.cancel_holding_extension($1, $2)`, [extension.rows[0].id, CANCEL_REASON])
    await move(serial, "Sale", "Sold", "Client Site", {
      date: iso(d12),
      client: HOLDER,
      assigned_to: HOLDER,
      txnClient: HOLDER,
      client_id: clientId,
      invoice_number: "H1077-SALE-1",
      created_by: adminId,
      metadata: { converted_from: "POC" },
    })
    await move(serial, "Decommissioned", "Pending Inspection", "Warehouse A", {
      date: iso(d6),
      client: HOLDER,
      txnClient: HOLDER,
      client_id: clientId,
      metadata: { reason_category: "Client cancelled", reason_text: DECOM_REASON },
    })
    const caseRow = await db.query(
      `SELECT id FROM public.kit_cases WHERE inventory_item_id = $1 AND stage = 'open'`,
      [createdItem.itemId],
    )
    await db.query(`SELECT public.complete_inspection($1, 'Pass', $2, 'A', 'Resell', 'Warehouse A', NULL)`, [
      caseRow.rows[0].id,
      "H1077 inspection comments for resale",
    ])
    await move(serial, "Rentals", "Rented", "Client Site", {
      date: iso(today),
      client: HOLDER,
      assigned_to: HOLDER,
      txnClient: HOLDER,
      client_id: clientId,
      poc_out_date: today,
      return_date: later,
      invoice_number: "H1077-RENT",
    })
    await move(serial, "Sale", "Sold", "Client Site", {
      date: iso(today),
      client: HOLDER,
      assigned_to: HOLDER,
      txnClient: HOLDER,
      client_id: clientId,
      invoice_number: "H1077-SALE-2",
      created_by: adminId,
      metadata: { converted_from: "Rentals", rental_end: today },
    })

    const history = (await db.query(`SELECT public.kit_history($1) AS history`, [createdItem.itemId])).rows[0].history
    const timeline = history.timeline ?? []
    const placements = history.placements ?? []
    const ordered = timeline.every((entry, index) => {
      if (index === 0) return true
      return new Date(timeline[index - 1].sort_at).getTime() >= new Date(entry.sort_at).getTime()
    })
    if (ordered && timeline.length > 0) pass("timeline_order", `${timeline.length} entries, newest first`)
    else fail("timeline_order", JSON.stringify(timeline.map((entry) => [entry.kind, entry.sort_at])))

    if (!timeline.some((entry) => entry.kind === "Reversal" || entry.title === "Reversal")) {
      pass("reversal_nested", "reversal rows are not separate timeline entries")
    } else fail("reversal_nested", "a Reversal row is its own timeline entry")

    const reversedOut = timeline.filter((entry) => entry.kind === "POC Out" && entry.reversal)
    if (
      reversedOut.length === 1 &&
      reversedOut[0].reversal.reason === REVERSE_REASON &&
      reversedOut[0].restore?.reason === RESTORE_REASON &&
      reversedOut[0].reversed === false
    ) {
      pass("reversal_beside", "the restored POC Out keeps the reversal beside it")
    } else fail("reversal_beside", JSON.stringify(reversedOut))

    const pocDays = daysBetween(d30, d24)
    const saleDays = daysBetween(d18, d6)
    const continued = placements.filter((placement) =>
      (placement.changes ?? []).some((change) => change.to === "Sale"),
    )
    if (
      placements.length === 3 &&
      placements[0].kind === "POC" &&
      placements[0].start === d30 &&
      placements[0].end === d24 &&
      placements[0].duration_days === pocDays &&
      placements[1].start === d18 &&
      placements[1].end === d6 &&
      placements[1].duration_days === saleDays &&
      placements[1].changes?.[0]?.from === "POC" &&
      placements[1].changes?.[0]?.to === "Sale" &&
      placements[2].end === "current" &&
      placements[2].start === today &&
      placements[2].duration_days === 0 &&
      placements[2].changes?.[0]?.from === "Rental" &&
      placements[2].changes?.[0]?.to === "Sale" &&
      continued.length === 2
    ) {
      pass("placements", `durations ${pocDays} and ${saleDays} days; both conversions continue a placement`)
    } else fail("placements", JSON.stringify(placements))

    const expectedSummary = `Sold to ${HOLDER} on ${short(today)}`
    if (history.summary === expectedSummary) pass("summary", history.summary)
    else fail("summary", history.summary)

    const expectedTags = ["Rental", "Demo", "Decommissioned", "Resold"]
    if (JSON.stringify(history.tags) === JSON.stringify(expectedTags)) pass("tags", expectedTags.join(", "))
    else fail("tags", JSON.stringify(history.tags))

    const sales = timeline.filter((entry) => entry.kind === "Sale")
    if (sales.length === 2 && sales.every((entry) => entry.invoice?.status === "invoiced")) {
      pass("invoices", sales.map((entry) => entry.invoice.invoice_number).join(", "))
    } else fail("invoices", JSON.stringify(sales.map((entry) => entry.invoice)))

    const kinds = new Set(timeline.map((entry) => entry.kind))
    const needed = ["opened", "inspection_recorded", "outcome_applied", "holding_extension", "holding_cancellation"]
    const missing = needed.filter((kind) => !kinds.has(kind))
    if (missing.length === 0) pass("sources", needed.join(", "))
    else fail("sources", `missing ${missing.join(", ")}`)

    const demoReturn = timeline.find((entry) => entry.kind === "POC Return")
    if (demoReturn?.detail?.includes("demo")) pass("demo_pool", demoReturn.detail)
    else fail("demo_pool", demoReturn?.detail ?? "no POC Return")

    const unknownSerial = `${PREFIX}-unknown`
    const unknownId = nextId("ITEM")
    await db.query(`SELECT public.apply_stock_movement('[]'::jsonb, $1::jsonb, $2::jsonb)`, [
      JSON.stringify([
        {
          id: unknownId,
          product_id: starId,
          serial_number: unknownSerial,
          status: "Pending Inspection",
          date_added: d6,
          location: "Warehouse A",
          client: HOLDER,
          poc_out_date: null,
          return_date: null,
        },
      ]),
      JSON.stringify([
        {
          id: nextId("TXN"),
          type: "Decommissioned",
          serial_number: unknownSerial,
          item_name: starName,
          date: iso(d6),
          client: HOLDER,
          client_id: clientId,
          batch_id: nextId("BATCH"),
          to_location: "Warehouse A",
          metadata: { reason_category: "Service termination", reason_text: DECOM_REASON },
        },
      ]),
    ])
    const unknown = (await db.query(`SELECT public.kit_history($1) AS history`, [unknownId])).rows[0].history
    const unknownPlacement = unknown.placements?.[0]
    if (
      unknownPlacement?.start === "unknown" &&
      unknownPlacement?.end === d6 &&
      unknownPlacement?.duration_days == null &&
      String(unknown.summary).includes("unknown")
    ) {
      pass("unknown_start", unknown.summary)
    } else fail("unknown_start", JSON.stringify({ summary: unknown.summary, placement: unknownPlacement }))

    await setUser(db, viewerId)
    const viewed = (await db.query(`SELECT public.kit_history($1) AS history`, [createdItem.itemId])).rows[0].history
    if (viewed.summary === expectedSummary && JSON.stringify(viewed.tags) === JSON.stringify(expectedTags)) {
      pass("viewer_read", "a viewer receives the same summary and tags")
    } else fail("viewer_read", JSON.stringify({ summary: viewed.summary, tags: viewed.tags }))
    const blocked = await raises(
      db,
      `SELECT public.complete_inspection($1, 'Pass', $2, 'A', 'Resell', 'Warehouse A', NULL)`,
      [caseRow.rows[0].id, "H1077 viewer must not record an inspection"],
      "admin only",
    )
    if (blocked) fail("viewer_readonly", blocked)
    else pass("viewer_readonly", "a viewer cannot record an inspection")
  } catch (error) {
    fail("fixtures", error instanceof Error ? error.message : String(error))
  } finally {
    await setUser(db, adminId || "")
    await cleanup()
    const residue = await db.query(
      `SELECT
         (SELECT count(*)::int FROM public.transactions WHERE serial_number LIKE $1 OR id LIKE $2) AS txns,
         (SELECT count(*)::int FROM public.inventory_items WHERE serial_number LIKE $1 OR id LIKE $3) AS items,
         (SELECT count(*)::int FROM public.kit_cases WHERE inventory_item_id LIKE $3) AS cases,
         (SELECT count(*)::int FROM public.holding_extensions WHERE serial_number LIKE $1) AS extensions,
         (SELECT count(*)::int FROM public.stock_pool_changes WHERE serial_number LIKE $1) AS pools,
         (SELECT count(*)::int FROM public.batch_reversals WHERE batch_id LIKE $4) AS reversals,
         (SELECT count(*)::int FROM public.batch_invoices WHERE batch_id LIKE $4) AS invoices,
         (SELECT count(*)::int FROM public.clients WHERE id = $5) AS clients,
         (SELECT count(*)::int FROM auth.users WHERE email = ANY($6::text[])) AS users`,
      [`${PREFIX}%`, `TXN-${PREFIX}%`, `ITEM-${PREFIX}%`, `BATCH-${PREFIX}%`, clientId, [adminEmail, viewerEmail]],
    )
    const left = residue.rows[0]
    const clear = Object.values(left).every((count) => count === 0)
    if (clear) pass("residue", "no fixture rows left")
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
