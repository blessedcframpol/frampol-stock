/**
 * Tamper-evident audit log. Fixture kits and transactions are removed.
 * The audit rows they wrote stay, and this script prints them.
 *
 * Usage: node scripts/verify-079-audit-log.mjs
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"

const require = createRequire(import.meta.url)
const { Client } = require("pg")
const { createClient } = require("@supabase/supabase-js")
const { prepareVerifyEnv } = require("./verify-env.cjs")

const PREFIX = "A1079"
const EDIT_REASON = "A1079 edit the product group"
const MOVE_REASON = "A1079 move the kit back"
const FIXTURE_PRODUCT = "A1079 Fixture Kit"
const INVOICE = "A1079-10001"

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
  prepareVerifyEnv()
  const db = new Client({
    connectionString: process.env.SUPABASE_DB_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  })
  await db.connect()
  const service = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const adminEmail = "verify-079-admin@test.local"
  const viewerEmail = "verify-079-viewer@test.local"
  const star = await db.query(
    `SELECT id, product_name FROM public.product_lines WHERE vendor = 'Starlink' AND is_active ORDER BY id LIMIT 1`,
  )
  const clock = await db.query(
    `SELECT to_char((now() AT TIME ZONE 'Africa/Harare')::date, 'YYYY-MM-DD') AS today`,
  )
  const today = clock.rows[0].today
  const starId = star.rows[0].id
  const starName = star.rows[0].product_name
  const clientId = `CLT-${PREFIX}`
  const serial = `${PREFIX}-kit`
  let adminId = null
  let viewerId = null
  let itemId = null
  let inboundTxn = null

  async function cleanup() {
    await db.query(`ALTER TABLE public.transactions DISABLE TRIGGER tr_transactions_lock_posted`)
    try {
      await db.query(
        `DELETE FROM public.transactions WHERE serial_number LIKE $1 OR id LIKE $2 OR batch_id LIKE $3`,
        [`${PREFIX}%`, `TXN-${PREFIX}%`, `BATCH-${PREFIX}%`],
      )
    } finally {
      await db.query(`ALTER TABLE public.transactions ENABLE TRIGGER tr_transactions_lock_posted`)
    }
    await db.query(`DELETE FROM public.inventory_items WHERE serial_number LIKE $1 OR id LIKE $2`, [
      `${PREFIX}%`,
      `ITEM-${PREFIX}%`,
    ])
    await db.query(`DELETE FROM public.clients WHERE id = $1`, [clientId])
    await db.query(`DELETE FROM public.product_lines WHERE product_name = $1 AND vendor = $2`, [
      FIXTURE_PRODUCT,
      PREFIX,
    ])
    const users = await db.query(`SELECT id::text AS id FROM auth.users WHERE email = ANY($1::text[])`, [
      [adminEmail, viewerEmail],
    ])
    for (const row of users.rows) {
      const { error } = await service.auth.admin.deleteUser(row.id)
      if (error && !/not found/i.test(error.message)) throw error
    }
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
      `UPDATE public.profiles
       SET role = CASE id WHEN $1 THEN 'admin'::public.app_role ELSE 'viewer'::public.app_role END,
           active = true,
           display_name = CASE id WHEN $1 THEN 'A1079 Admin' ELSE 'A1079 Viewer' END
       WHERE id IN ($1, $2)`,
      [adminId, viewerId],
    )
    if (profiles.rowCount !== 2) throw new Error("profiles were not updated")
    await db.query(
      `INSERT INTO public.clients (id, name, company, email, phone, address)
       VALUES ($1, 'A1079 Holder', 'A1079 Co', 'a1079@test.local', '000', 'Test')`,
      [clientId],
    )
    await setUser(db, adminId)
    const fixtureProduct = await db.query(`SELECT public.ensure_product_line($1, $2) AS id`, [FIXTURE_PRODUCT, PREFIX])
    const otherId = fixtureProduct.rows[0].id

    itemId = nextId("ITEM")
    inboundTxn = nextId("TXN")
    const inboundBatch = nextId("BATCH")
    await db.query(`SELECT public.apply_stock_movement('[]'::jsonb, $1::jsonb, $2::jsonb)`, [
      JSON.stringify([
        {
          id: itemId,
          product_id: starId,
          serial_number: serial,
          status: "In Stock",
          date_added: today,
          location: "Warehouse A",
        },
      ]),
      JSON.stringify([
        {
          id: inboundTxn,
          type: "Inbound",
          serial_number: serial,
          item_name: starName,
          date: iso(today),
          client: "Internal",
          batch_id: inboundBatch,
          to_location: "Warehouse A",
          created_by: adminId,
        },
      ]),
    ])

    const movement = await db.query(
      `SELECT action, actor, source, changed
       FROM public.audit_log
       WHERE table_name = 'transactions' AND row_id = $1 AND action = 'insert' AND actor = $2`,
      [inboundTxn, adminId],
    )
    const movementRow = movement.rows[0]
    const typePair = movementRow?.changed?.type
    if (
      movement.rowCount === 1 &&
      movementRow.actor === adminId &&
      movementRow.source === "Inbound" &&
      Array.isArray(typePair) &&
      typePair[1] === "Inbound"
    ) {
      pass("movement_audit", "inbound transaction insert records the type, actor, and Inbound source")
    } else {
      fail("movement_audit", JSON.stringify(movement.rows))
    }

    await db.query(`SELECT public.apply_inventory_edit($1, $2::jsonb, $3, 'edit_item')`, [
      itemId,
      JSON.stringify({ product_id: otherId }),
      EDIT_REASON,
    ])
    const edited = await db.query(
      `SELECT actor, source, reason, changed
       FROM public.audit_log
       WHERE table_name = 'inventory_items' AND row_id = $1 AND source = 'edit_item' AND actor = $2`,
      [itemId, adminId],
    )
    const editRow = edited.rows[0]
    const productPair = editRow?.changed?.product_id
    if (
      edited.rowCount === 1 &&
      editRow.actor === adminId &&
      editRow.reason === EDIT_REASON &&
      Array.isArray(productPair) &&
      productPair[0] === starId &&
      productPair[1] === otherId &&
      !editRow.changed.status
    ) {
      pass("edit_item_audit", "edit item records product_id old to new, the reason, and the admin")
    } else {
      fail("edit_item_audit", JSON.stringify(edited.rows))
    }

    await db.query(`SELECT public.apply_inventory_edit($1, $2::jsonb, $3, 'move_group')`, [
      itemId,
      JSON.stringify({ product_id: starId }),
      MOVE_REASON,
    ])
    const moved = await db.query(
      `SELECT actor, source, reason, changed
       FROM public.audit_log
       WHERE table_name = 'inventory_items' AND row_id = $1 AND source = 'move_group' AND actor = $2`,
      [itemId, adminId],
    )
    const moveRow = moved.rows[0]
    const movePair = moveRow?.changed?.product_id
    if (
      moved.rowCount === 1 &&
      moveRow.actor === adminId &&
      moveRow.reason === MOVE_REASON &&
      Array.isArray(movePair) &&
      movePair[0] === otherId &&
      movePair[1] === starId
    ) {
      pass("move_group_audit", "move group records the product change and its reason")
    } else {
      fail("move_group_audit", JSON.stringify(moved.rows))
    }

    const history = await db.query(`SELECT public.kit_history($1) AS payload`, [itemId])
    const timeline = history.rows[0].payload.timeline ?? []
    const editEntry = timeline.find((entry) => entry.kind === "kit_edit" && entry.detail === EDIT_REASON)
    const moveEntry = timeline.find((entry) => entry.kind === "kit_edit" && entry.detail === MOVE_REASON)
    if (
      editEntry &&
      editEntry.title === `Product changed from ${starName} to ${FIXTURE_PRODUCT}` &&
      editEntry.who === "A1079 Admin" &&
      moveEntry &&
      moveEntry.title === `Product changed from ${FIXTURE_PRODUCT} to ${starName}`
    ) {
      pass("panel", "kit history shows both product edits with the actor and reason")
    } else {
      fail("panel", JSON.stringify({ editEntry, moveEntry }))
    }

    await db.query(`UPDATE public.inventory_items SET notes = $1 WHERE id = $2`, [`${PREFIX} direct note`, itemId])
    const direct = await db.query(
      `SELECT actor, source, changed
       FROM public.audit_log
       WHERE table_name = 'inventory_items' AND row_id = $1 AND source = 'direct' AND action = 'update' AND actor = $2`,
      [itemId, adminId],
    )
    const directRow = direct.rows[0]
    if (direct.rowCount === 1 && directRow.actor === adminId && directRow.changed?.notes?.[1] === `${PREFIX} direct note`) {
      pass("direct_update", "a direct inventory update is logged with source direct and the admin actor")
    } else {
      fail("direct_update", JSON.stringify(direct.rows))
    }

    const saleTxn = nextId("TXN")
    const saleBatch = nextId("BATCH")
    await db.query(`SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`, [
      JSON.stringify([
        {
          id: itemId,
          product_id: starId,
          serial_number: serial,
          status: "Sold",
          date_added: today,
          location: "Client Site",
          client: "A1079 Holder - A1079 Co",
        },
      ]),
      JSON.stringify([
        {
          id: saleTxn,
          type: "Sale",
          serial_number: serial,
          item_name: starName,
          date: iso(today),
          client: "A1079 Holder - A1079 Co",
          client_id: clientId,
          batch_id: saleBatch,
          to_location: "Client Site",
        },
      ]),
    ])
    await db.query(`SELECT public.sync_legacy_invoice($1, 'invoiced', $2)`, [saleBatch, INVOICE])
    const invoiced = await db.query(`SELECT invoice_number FROM public.transactions WHERE id = $1`, [saleTxn])
    if (invoiced.rows[0]?.invoice_number === INVOICE) {
      pass("invoice_sync", "sync_legacy_invoice can still refresh the legacy invoice number")
    } else {
      fail("invoice_sync", JSON.stringify(invoiced.rows))
    }

    const dateBlock = await raises(
      db,
      `UPDATE public.transactions SET date = $1 WHERE id = $2`,
      [iso("2020-01-01"), inboundTxn],
      "posted fields are locked",
    )
    if (!dateBlock) pass("date_locked", "a direct date change is rejected")
    else fail("date_locked", dateBlock)

    const deleteBlock = await raises(
      db,
      `DELETE FROM public.transactions WHERE id = $1`,
      [inboundTxn],
      "posted rows cannot be deleted",
    )
    if (!deleteBlock) pass("delete_locked", "a direct delete is rejected")
    else fail("delete_locked", deleteBlock)

    const ownerBlock = await raises(
      db,
      `UPDATE public.audit_log SET source = 'tamper' WHERE row_id = $1`,
      [inboundTxn],
      "append-only",
    )
    if (!ownerBlock) pass("append_only", "updating the audit log raises even for the table owner")
    else fail("append_only", ownerBlock)

    await db.query("BEGIN")
    try {
      await db.query("SET LOCAL ROLE authenticated")
      await db.query(`UPDATE public.audit_log SET source = 'tamper' WHERE row_id = $1`, [inboundTxn])
      fail("app_role_update", "authenticated was allowed to update audit_log")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes("permission denied") || message.includes("append-only")) {
        pass("app_role_update", "authenticated cannot update audit_log")
      } else {
        fail("app_role_update", message)
      }
    }
    await db.query("ROLLBACK")

    await db.query("BEGIN")
    try {
      await db.query("SET LOCAL ROLE authenticated")
      await db.query(`DELETE FROM public.audit_log WHERE row_id = $1`, [inboundTxn])
      fail("app_role_delete", "authenticated was allowed to delete audit_log")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes("permission denied") || message.includes("append-only")) {
        pass("app_role_delete", "authenticated cannot delete audit_log")
      } else {
        fail("app_role_delete", message)
      }
    }
    await db.query("ROLLBACK")

    await setUser(db, viewerId)
    const viewerRead = await raises(db, `SELECT public.audit_log_read()`, [], "admin only")
    if (!viewerRead) pass("viewer_hidden", "a viewer cannot read the audit log through the function")
    else fail("viewer_hidden", viewerRead)

    const grants = await db.query(
      `SELECT
         has_table_privilege('service_role', 'public.audit_log', 'SELECT') AS service_select,
         has_table_privilege('service_role', 'public.audit_log', 'UPDATE') AS service_update,
         has_table_privilege('service_role', 'public.audit_log', 'DELETE') AS service_delete,
         has_table_privilege('authenticated', 'public.audit_log', 'SELECT') AS app_select`,
    )
    const grant = grants.rows[0]
    if (grant.service_select && !grant.service_update && !grant.service_delete && !grant.app_select) {
      pass("grants", "only service_role can read the table in bulk")
    } else {
      fail("grants", JSON.stringify(grant))
    }
  } catch (error) {
    fail("unexpected", error instanceof Error ? error.message : String(error))
  } finally {
    await cleanup()
    const kept = await db.query(
      `SELECT id, table_name, action, source, row_id
       FROM public.audit_log
       WHERE row_id LIKE $1 OR changed::text LIKE $2
       ORDER BY id`,
      [`%${PREFIX}%`, `%${PREFIX}%`],
    )
    const residue = await db.query(
      `SELECT
         (SELECT count(*)::int FROM public.inventory_items WHERE serial_number LIKE $1 OR id LIKE $2) AS items,
         (SELECT count(*)::int FROM public.transactions WHERE serial_number LIKE $1 OR id LIKE $3 OR batch_id LIKE $4) AS txns,
         (SELECT count(*)::int FROM public.clients WHERE id = $5) AS clients,
         (SELECT count(*)::int FROM public.product_lines WHERE product_name = $6) AS products`,
      [`${PREFIX}%`, `ITEM-${PREFIX}%`, `TXN-${PREFIX}%`, `BATCH-${PREFIX}%`, clientId, FIXTURE_PRODUCT],
    )
    const left = residue.rows[0]
    if (left.items === 0 && left.txns === 0 && left.clients === 0 && left.products === 0) {
      pass("residue", "no fixture kits, transactions, clients, or product lines left")
    } else {
      fail("residue", JSON.stringify(left))
    }
    if (kept.rowCount > 0) {
      pass(
        "audit_kept",
        `${kept.rowCount} audit rows remain: ${kept.rows.map((row) => `${row.id}:${row.table_name}:${row.action}:${row.source}`).join(", ")}`,
      )
    } else {
      fail("audit_kept", "expected the fixture audit rows to stay")
    }
    const ended = await snapshot(db)
    const same =
      started.clients === ended.clients &&
      started.orders === ended.orders &&
      started.units === ended.units &&
      started.low === ended.low &&
      started.available === ended.available
    if (same) {
      pass(
        "live_totals",
        `${ended.clients} clients / ${ended.orders} orders / ${ended.units} units; low ${ended.low}; available ${ended.available}`,
      )
    } else {
      fail("live_totals", `before ${JSON.stringify(started)} after ${JSON.stringify(ended)}`)
    }
    await Promise.race([db.end(), new Promise((resolve) => setTimeout(resolve, 2000))])
    const failed = Object.values(results).some((row) => row.result === "FAIL")
    process.exit(failed ? 1 : 0)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
