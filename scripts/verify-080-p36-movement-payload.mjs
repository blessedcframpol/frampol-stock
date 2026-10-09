/**
 * P3.6 apply_stock_movement payload rules — rollback harness.
 *
 * Usage:
 *   node scripts/rehearse-migration.mjs supabase/migrations/20261009120000_p36_movement_payload_rules.sql scripts/verify-080-p36-movement-payload.mjs
 *   node scripts/verify-080-p36-movement-payload.mjs
 */
import { withHarness } from "./verify-harness.mjs"
import { dropMovementPrev, setJwt } from "./verify-harness-fixtures.mjs"

const PREFIX = "H3080"
const DATE = "2026-10-08"
const DATE_ISO = `${DATE}T00:00:00.000Z`
const DISPOSE_REASON = "Beyond economical repair for site kit"

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
    label: "users",
    sql: `SELECT count(*)::int AS n FROM auth.users WHERE email LIKE 'harness-080-%@test.local'`,
    params: [],
  },
]

export async function runChecks(ctx) {
  const { db, pass, fail } = ctx

  const product = await db.query(
    `SELECT id, product_name FROM public.product_lines WHERE is_active ORDER BY id LIMIT 1`,
  )
  if (!product.rows[0]) throw new Error("no active product line")
  const productId = product.rows[0].id
  const productName = product.rows[0].product_name

  const adminId = await ctx.createFixtureUser("admin", "harness-080-admin@test.local")
  const techId = await ctx.createFixtureUser("technicians", "harness-080-tech@test.local")
  await setJwt(db, adminId)

  async function inbound(serial, location = "Warehouse A") {
    const itemId = nextId("ITEM")
    await dropMovementPrev(db)
    await db.query(`SELECT public.apply_stock_movement('[]'::jsonb, $1::jsonb, $2::jsonb)`, [
      JSON.stringify([
        {
          id: itemId,
          product_id: productId,
          serial_number: serial,
          status: "In Stock",
          date_added: DATE,
          location,
        },
      ]),
      JSON.stringify([
        {
          id: nextId("TXN"),
          type: "Inbound",
          serial_number: serial,
          item_name: productName,
          date: DATE_ISO,
          client: "Internal",
          batch_id: nextId("BATCH"),
          to_location: location,
        },
      ]),
    ])
    return itemId
  }

  async function move(itemId, serial, type, status, location, extra = {}) {
    await dropMovementPrev(db)
    await db.query(`SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`, [
      JSON.stringify([
        {
          id: itemId,
          product_id: productId,
          serial_number: serial,
          status,
          date_added: DATE,
          location,
          client: extra.client ?? null,
          assigned_to: extra.assigned_to ?? null,
          poc_out_date: extra.poc_out_date ?? null,
          return_date: extra.return_date ?? null,
        },
      ]),
      JSON.stringify([
        {
          id: nextId("TXN"),
          type,
          serial_number: serial,
          item_name: productName,
          date: DATE_ISO,
          client: extra.client ?? "Internal",
          client_id: extra.client_id ?? null,
          batch_id: nextId("BATCH"),
          from_location: extra.from_location ?? null,
          to_location: location,
          disposal_reason: extra.disposal_reason ?? null,
          authorised_by: extra.authorised_by ?? null,
          invoice_number: extra.invoice_number ?? null,
          metadata: extra.metadata ?? {},
        },
      ]),
    ])
  }

  // --- Transfer ---
  {
    const serial = `${PREFIX}-XFER`
    const itemId = await inbound(serial)
    const same = await ctx.raises(
      `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
      [
        JSON.stringify([
          {
            id: itemId,
            product_id: productId,
            serial_number: serial,
            status: "In Stock",
            date_added: DATE,
            location: "Warehouse A",
          },
        ]),
        JSON.stringify([
          {
            id: nextId("TXN"),
            type: "Transfer",
            serial_number: serial,
            item_name: productName,
            date: DATE_ISO,
            client: "Internal",
            batch_id: nextId("BATCH"),
            from_location: "Warehouse A",
            to_location: "Warehouse A",
          },
        ]),
      ],
      "destination different",
    )
    if (same) fail("transfer_same_location", same)
    else pass("transfer_same_location", "same destination rejected")

    const missing = await ctx.raises(
      `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
      [
        JSON.stringify([
          {
            id: itemId,
            product_id: productId,
            serial_number: serial,
            status: "In Stock",
            date_added: DATE,
            location: "Warehouse B",
          },
        ]),
        JSON.stringify([
          {
            id: nextId("TXN"),
            type: "Transfer",
            serial_number: serial,
            item_name: productName,
            date: DATE_ISO,
            client: "Internal",
            batch_id: nextId("BATCH"),
            from_location: "Warehouse A",
            to_location: "",
          },
        ]),
      ],
      "destination different",
    )
    if (missing) fail("transfer_blank_destination", missing)
    else pass("transfer_blank_destination", "blank destination rejected")

    await dropMovementPrev(db)
    try {
      await move(itemId, serial, "Transfer", "In Stock", "Warehouse B", {
        from_location: "Warehouse A",
      })
      pass("transfer_ok", "Warehouse A → Warehouse B")
    } catch (error) {
      fail("transfer_ok", error instanceof Error ? error.message : String(error))
    }
  }

  // --- Dispose ---
  {
    const serial = `${PREFIX}-DISP`
    const itemId = await inbound(serial)
    const noReason = await ctx.raises(
      `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
      [
        JSON.stringify([
          {
            id: itemId,
            product_id: productId,
            serial_number: serial,
            status: "Disposed",
            date_added: DATE,
            location: "Warehouse A",
          },
        ]),
        JSON.stringify([
          {
            id: nextId("TXN"),
            type: "Dispose",
            serial_number: serial,
            item_name: productName,
            date: DATE_ISO,
            client: "Internal",
            batch_id: nextId("BATCH"),
            to_location: "Warehouse A",
            disposal_reason: "short",
            authorised_by: adminId,
          },
        ]),
      ],
      "authorising admin",
    )
    if (noReason) fail("dispose_short_reason", noReason)
    else pass("dispose_short_reason", "short reason rejected")

    const techAuth = await ctx.raises(
      `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
      [
        JSON.stringify([
          {
            id: itemId,
            product_id: productId,
            serial_number: serial,
            status: "Disposed",
            date_added: DATE,
            location: "Warehouse A",
          },
        ]),
        JSON.stringify([
          {
            id: nextId("TXN"),
            type: "Dispose",
            serial_number: serial,
            item_name: productName,
            date: DATE_ISO,
            client: "Internal",
            batch_id: nextId("BATCH"),
            to_location: "Warehouse A",
            disposal_reason: DISPOSE_REASON,
            authorised_by: techId,
          },
        ]),
      ],
      "authorising admin",
    )
    if (techAuth) fail("dispose_non_admin", techAuth)
    else pass("dispose_non_admin", "technician authoriser rejected")

    await dropMovementPrev(db)
    try {
      await move(itemId, serial, "Dispose", "Disposed", "Warehouse A", {
        disposal_reason: DISPOSE_REASON,
        authorised_by: adminId,
      })
      pass("dispose_ok", "reason + admin accepted")
    } catch (error) {
      fail("dispose_ok", error instanceof Error ? error.message : String(error))
    }
  }

  // --- In warehouse ---
  {
    const badIn = await ctx.raises(
      `SELECT public.apply_stock_movement('[]'::jsonb, $1::jsonb, $2::jsonb)`,
      [
        JSON.stringify([
          {
            id: nextId("ITEM"),
            product_id: productId,
            serial_number: `${PREFIX}-BADIN`,
            status: "In Stock",
            date_added: DATE,
            location: "Client Site",
          },
        ]),
        JSON.stringify([
          {
            id: nextId("TXN"),
            type: "Inbound",
            serial_number: `${PREFIX}-BADIN`,
            item_name: productName,
            date: DATE_ISO,
            client: "Internal",
            batch_id: nextId("BATCH"),
            to_location: "Client Site",
          },
        ]),
      ],
      "warehouse location",
    )
    if (badIn) fail("inbound_non_warehouse", badIn)
    else pass("inbound_non_warehouse", "Client Site inbound rejected")
  }

  // --- Sale invoice ---
  {
    const serial = `${PREFIX}-SALE`
    const itemId = await inbound(serial)
    // Sale pool may be required — set via direct update with movement_type bypass if needed.
    await db.query(`SELECT set_config('app.movement_type', 'Inbound', true)`)
    await db.query(`UPDATE public.inventory_items SET stock_pool = 'sale' WHERE id = $1`, [itemId])
    await db.query(`SELECT set_config('app.movement_type', '', true)`)

    const noInvoice = await ctx.raises(
      `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
      [
        JSON.stringify([
          {
            id: itemId,
            product_id: productId,
            serial_number: serial,
            status: "Sold",
            date_added: DATE,
            location: "Delivered",
            client: "H3080 Buyer",
          },
        ]),
        JSON.stringify([
          {
            id: nextId("TXN"),
            type: "Sale",
            serial_number: serial,
            item_name: productName,
            date: DATE_ISO,
            client: "H3080 Buyer",
            batch_id: nextId("BATCH"),
            to_location: "Delivered",
            metadata: {},
          },
        ]),
      ],
      "invoice",
    )
    if (noInvoice) fail("sale_no_invoice", noInvoice)
    else pass("sale_no_invoice", "Sale without invoice choice rejected")

    await dropMovementPrev(db)
    try {
      await move(itemId, serial, "Sale", "Sold", "Delivered", {
        client: "H3080 Buyer",
        metadata: { invoice_choice: "pending" },
      })
      pass("sale_pending_ok", "Invoice pending accepted")
    } catch (error) {
      fail("sale_pending_ok", error instanceof Error ? error.message : String(error))
    }
  }
}

async function main() {
  const { ok, failed, passed } = await withHarness(
    { markers: MARKERS, timeoutMs: 300_000, label: "verify-080" },
    runChecks,
  )
  console.log(ok ? `\n${passed} passed` : `\n${failed} failed`)
  process.exitCode = ok ? 0 : 1
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-080-p36-movement-payload.mjs")
if (isMain) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
