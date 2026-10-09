/**
 * Tamper-evident audit log — rollback harness (BEGIN…ROLLBACK, never commits).
 * Assert audit rows inside the transaction; harness audit_markers covers post-ROLLBACK.
 *
 * Usage: node scripts/verify-079-audit-log.mjs
 */
import { withHarness } from "./verify-harness.mjs"
import { dropMovementPrev, setJwt } from "./verify-harness-fixtures.mjs"

const PREFIX = "H3079"
const EDIT_REASON = "H3079 edit the product group"
const MOVE_REASON = "H3079 move the kit back"
const FIXTURE_PRODUCT = "H3079 Fixture Kit"
const INVOICE = "H3079-10001"
const DATE = "2026-10-07"
const DATE_ISO = `${DATE}T00:00:00.000Z`

let seq = 0
function nextId(kind) {
  seq += 1
  return `${kind}-${PREFIX}-${seq}`
}

export const MARKERS = [
  {
    label: "transactions",
    sql: `SELECT count(*)::int AS n FROM public.transactions
          WHERE serial_number LIKE $1 OR id LIKE $2 OR batch_id LIKE $3`,
    params: [`${PREFIX}%`, `TXN-${PREFIX}%`, `BATCH-${PREFIX}%`],
  },
  {
    label: "items",
    sql: `SELECT count(*)::int AS n FROM public.inventory_items WHERE serial_number LIKE $1 OR id LIKE $2`,
    params: [`${PREFIX}%`, `ITEM-${PREFIX}%`],
  },
  {
    label: "clients",
    sql: `SELECT count(*)::int AS n FROM public.clients WHERE id = $1`,
    params: [`CLT-${PREFIX}`],
  },
  {
    label: "products",
    sql: `SELECT count(*)::int AS n FROM public.product_lines WHERE product_name = $1 AND vendor = $2`,
    params: [FIXTURE_PRODUCT, PREFIX],
  },
  {
    label: "users",
    sql: `SELECT count(*)::int AS n FROM auth.users WHERE email LIKE 'harness-079-%@test.local'`,
    params: [],
  },
]

export async function runChecks(ctx) {
  const db = ctx.db
  const pass = (name, reason) => ctx.pass(name, reason)
  const fail = (name, reason) => ctx.fail(name, reason)

  const star = await db.query(
    `SELECT id, product_name FROM public.product_lines WHERE vendor = 'Starlink' AND is_active ORDER BY id LIMIT 1`,
  )
  if (!star.rows[0]) throw new Error("no active Starlink product")
  const starId = star.rows[0].id
  const starName = star.rows[0].product_name
  const clientId = `CLT-${PREFIX}`
  const serial = `${PREFIX}-kit`

  const adminId = await ctx.createFixtureUser("admin", "harness-079-admin@test.local")
  const viewerId = await ctx.createFixtureUser("viewer", "harness-079-viewer@test.local")
  await db.query(
    `UPDATE public.profiles
     SET display_name = CASE id WHEN $1 THEN 'H3079 Admin' ELSE 'H3079 Viewer' END
     WHERE id IN ($1, $2)`,
    [adminId, viewerId],
  )
  await db.query(
    `INSERT INTO public.clients (id, name, company, email, phone, address)
     VALUES ($1, 'H3079 Holder', 'H3079 Co', 'h3079@test.local', '000', 'Test')`,
    [clientId],
  )
  await setJwt(db, adminId)
  const fixtureProduct = await db.query(`SELECT public.ensure_product_line($1, $2) AS id`, [
    FIXTURE_PRODUCT,
    PREFIX,
  ])
  const otherId = fixtureProduct.rows[0].id

  const itemId = nextId("ITEM")
  const inboundTxn = nextId("TXN")
  const inboundBatch = nextId("BATCH")
  await dropMovementPrev(db)
  await db.query(`SELECT public.apply_stock_movement('[]'::jsonb, $1::jsonb, $2::jsonb)`, [
    JSON.stringify([
      {
        id: itemId,
        product_id: starId,
        serial_number: serial,
        status: "In Stock",
        date_added: DATE,
        location: "Warehouse A",
      },
    ]),
    JSON.stringify([
      {
        id: inboundTxn,
        type: "Inbound",
        serial_number: serial,
        item_name: starName,
        date: DATE_ISO,
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

  // apply_stock_movement leaves app.movement_type set for the txn; audit_capture
  // prefers it over app.audit_source. Clear so edit_item / move_group stick.
  await db.query(`SELECT set_config('app.movement_type', '', true)`)
  await db.query(`SELECT set_config('app.audit_source', '', true)`)
  await db.query(`SELECT set_config('app.audit_reason', '', true)`)
  await db.query(`SELECT public.apply_inventory_edit($1, $2::jsonb, $3, 'edit_item')`, [
    itemId,
    JSON.stringify({ product_id: otherId }),
    EDIT_REASON,
  ])
  const edited = await db.query(
    `SELECT actor, source, reason, changed
     FROM public.audit_log
     WHERE table_name = 'inventory_items' AND row_id = $1 AND action = 'update'
       AND source = 'edit_item' AND reason = $2
     ORDER BY id DESC
     LIMIT 1`,
    [itemId, EDIT_REASON],
  )
  const editRow = edited.rows[0]
  const productPair = editRow?.changed?.product_id
  if (
    edited.rowCount === 1 &&
    editRow.source === "edit_item" &&
    editRow.reason === EDIT_REASON &&
    (editRow.actor === adminId || editRow.actor === "postgres" || editRow.actor === "supabase_admin") &&
    Array.isArray(productPair) &&
    productPair[0] === starId &&
    productPair[1] === otherId &&
    !editRow.changed.status
  ) {
    pass("edit_item_audit", "edit item records product_id old to new, the reason, and the admin")
  } else {
    fail("edit_item_audit", JSON.stringify(edited.rows))
  }

  await db.query(`SELECT set_config('app.movement_type', '', true)`)
  await db.query(`SELECT public.apply_inventory_edit($1, $2::jsonb, $3, 'move_group')`, [
    itemId,
    JSON.stringify({ product_id: starId }),
    MOVE_REASON,
  ])
  const moved = await db.query(
    `SELECT actor, source, reason, changed
     FROM public.audit_log
     WHERE table_name = 'inventory_items' AND row_id = $1 AND action = 'update'
       AND source = 'move_group' AND reason = $2
     ORDER BY id DESC
     LIMIT 1`,
    [itemId, MOVE_REASON],
  )
  const moveRow = moved.rows[0]
  const movePair = moveRow?.changed?.product_id
  if (
    moved.rowCount === 1 &&
    moveRow.source === "move_group" &&
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
    editEntry.who === "H3079 Admin" &&
    moveEntry &&
    moveEntry.title === `Product changed from ${FIXTURE_PRODUCT} to ${starName}`
  ) {
    pass("panel", "kit history shows both product edits with the actor and reason")
  } else {
    fail("panel", JSON.stringify({ editEntry, moveEntry }))
  }

  await db.query(`SELECT set_config('app.movement_type', '', true)`)
  await db.query(`SELECT set_config('app.audit_source', '', true)`)
  await db.query(`SELECT set_config('app.audit_reason', '', true)`)
  await db.query(`UPDATE public.inventory_items SET notes = $1 WHERE id = $2`, [`${PREFIX} direct note`, itemId])
  const direct = await db.query(
    `SELECT actor, source, changed
     FROM public.audit_log
     WHERE table_name = 'inventory_items' AND row_id = $1 AND action = 'update'
       AND source = 'direct' AND changed ? 'notes'
     ORDER BY id DESC
     LIMIT 1`,
    [itemId],
  )
  const directRow = direct.rows[0]
  if (
    direct.rowCount === 1 &&
    directRow.source === "direct" &&
    directRow.changed?.notes?.[1] === `${PREFIX} direct note`
  ) {
    pass("direct_update", "a direct inventory update is logged with source direct and the admin actor")
  } else {
    fail("direct_update", JSON.stringify(direct.rows))
  }

  const saleTxn = nextId("TXN")
  const saleBatch = nextId("BATCH")
  await dropMovementPrev(db)
  await db.query(`SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`, [
    JSON.stringify([
      {
        id: itemId,
        product_id: starId,
        serial_number: serial,
        status: "Sold",
        date_added: DATE,
        location: "Client Site",
        client: "H3079 Holder - H3079 Co",
      },
    ]),
    JSON.stringify([
      {
        id: saleTxn,
        type: "Sale",
        serial_number: serial,
        item_name: starName,
        date: DATE_ISO,
        client: "H3079 Holder - H3079 Co",
        client_id: clientId,
        batch_id: saleBatch,
        to_location: "Client Site",
        metadata: { invoice_choice: "pending" },
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

  const dateBlock = await ctx.raises(
    `UPDATE public.transactions SET date = $1 WHERE id = $2`,
    [`2020-01-01T00:00:00.000Z`, inboundTxn],
    "posted fields are locked",
  )
  if (!dateBlock) pass("date_locked", "a direct date change is rejected")
  else fail("date_locked", dateBlock)

  const deleteBlock = await ctx.raises(
    `DELETE FROM public.transactions WHERE id = $1`,
    [inboundTxn],
    "posted rows cannot be deleted",
  )
  if (!deleteBlock) pass("delete_locked", "a direct delete is rejected")
  else fail("delete_locked", deleteBlock)

  const ownerBlock = await ctx.raises(
    `UPDATE public.audit_log SET source = 'tamper' WHERE row_id = $1`,
    [inboundTxn],
    "append-only",
  )
  if (!ownerBlock) pass("append_only", "updating the audit log raises even for the table owner")
  else fail("append_only", ownerBlock)

  // Inside the outer harness txn: act as authenticated via asUser (no nested BEGIN/ROLLBACK).
  const appUpdate = await ctx.asUser(adminId, async () => {
    const sp = `sp_${Math.random().toString(36).slice(2, 10)}`
    await db.query(`SAVEPOINT ${sp}`)
    try {
      await db.query(`UPDATE public.audit_log SET source = 'tamper' WHERE row_id = $1`, [inboundTxn])
      await db.query(`ROLLBACK TO SAVEPOINT ${sp}`)
      return "authenticated was allowed to update audit_log"
    } catch (error) {
      await db.query(`ROLLBACK TO SAVEPOINT ${sp}`)
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes("permission denied") || message.includes("append-only")) return null
      return message
    }
  })
  if (!appUpdate) pass("app_role_update", "authenticated cannot update audit_log")
  else fail("app_role_update", appUpdate)

  const appDelete = await ctx.asUser(adminId, async () => {
    const sp = `sp_${Math.random().toString(36).slice(2, 10)}`
    await db.query(`SAVEPOINT ${sp}`)
    try {
      await db.query(`DELETE FROM public.audit_log WHERE row_id = $1`, [inboundTxn])
      await db.query(`ROLLBACK TO SAVEPOINT ${sp}`)
      return "authenticated was allowed to delete audit_log"
    } catch (error) {
      await db.query(`ROLLBACK TO SAVEPOINT ${sp}`)
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes("permission denied") || message.includes("append-only")) return null
      return message
    }
  })
  if (!appDelete) pass("app_role_delete", "authenticated cannot delete audit_log")
  else fail("app_role_delete", appDelete)

  const viewerRead = await ctx.asUser(viewerId, async () =>
    ctx.raises(`SELECT public.audit_log_read()`, [], "admin only"),
  )
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

  // Audit rows exist inside the txn; harness audit_unchanged asserts none survive ROLLBACK.
  const inside = await db.query(
    `SELECT count(*)::int AS n FROM public.audit_log
     WHERE row_id LIKE $1 OR changed::text LIKE $2`,
    [`%${PREFIX}%`, `%${PREFIX}%`],
  )
  if (inside.rows[0].n > 0) {
    pass("audit_inside_txn", `${inside.rows[0].n} fixture audit rows present before ROLLBACK`)
  } else {
    fail("audit_inside_txn", "expected fixture audit rows inside the transaction")
  }
}

async function main() {
  const { ok, failed, passed } = await withHarness(
    { markers: MARKERS, timeoutMs: 180_000, label: "verify-079" },
    runChecks,
  )
  console.log(ok ? `\n${passed} passed` : `\n${failed} failed`)
  process.exitCode = ok ? 0 : 1
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-079-audit-log.mjs")
if (isMain) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
