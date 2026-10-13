/**
 * MV1 — archive/restore/delete products; non-Inbound keeps kit product_id;
 * archived products absent from catalogue.
 *
 *   node scripts/rehearse-migration.mjs supabase/migrations/20261012175928_mv1_archive_products_movement.sql scripts/verify-089-mv1-archive-movement.mjs
 *   node scripts/verify-089-mv1-archive-movement.mjs
 */
import { withHarness } from "./verify-harness.mjs"
import { dropMovementPrev, setJwt } from "./verify-harness-fixtures.mjs"

const PREFIX = "H3089"
const NOTES = "harness-089"
const EMAIL = "harness-089-"
const DATE = "2026-10-12"
const DATE_ISO = `${DATE}T00:00:00.000Z`

export const MARKERS = [
  {
    label: "products",
    sql: `SELECT count(*)::int AS n FROM public.product_lines WHERE id LIKE $1`,
    params: [`${PREFIX}%`],
  },
  {
    label: "items",
    sql: `SELECT count(*)::int AS n FROM public.inventory_items WHERE serial_number LIKE $1 OR id LIKE $1`,
    params: [`${PREFIX}%`],
  },
  {
    label: "transactions",
    sql: `SELECT count(*)::int AS n FROM public.transactions WHERE serial_number LIKE $1 OR id LIKE $1`,
    params: [`${PREFIX}%`],
  },
  {
    label: "users",
    sql: `SELECT count(*)::int AS n FROM auth.users WHERE email LIKE $1`,
    params: [`${EMAIL}%`],
  },
]

let seq = 0
function nextId(kind) {
  seq += 1
  return `${kind}-${PREFIX}-${seq}`
}

export async function runChecks(ctx) {
  const { db, pass, fail, asUser } = ctx
  await db.query(`SET LOCAL statement_timeout = '120s'`)

  const adminId = await ctx.createFixtureUser("admin", `${EMAIL}admin@test.local`)
  const techId = await ctx.createFixtureUser("technicians", `${EMAIL}tech@test.local`)

  // Existing active product for kit movements
  const live = await db.query(
    `SELECT id, product_name, vendor FROM public.product_lines WHERE is_active IS TRUE ORDER BY id LIMIT 1`,
  )
  if (!live.rows[0]) throw new Error("need an active product_line")
  const liveProduct = live.rows[0]

  // Fresh products for archive / delete (no history)
  const archiveId = `${PREFIX}-archive`
  const deleteId = `${PREFIX}-delete`
  const stockBlockId = `${PREFIX}-stock`
  await db.query(
    `INSERT INTO public.product_lines (id, product_name, vendor, requires_serial, is_active)
     VALUES
       ($1, 'MV1 Archive Me', 'Harness', true, true),
       ($2, 'MV1 Delete Me', 'Harness', true, true),
       ($3, 'MV1 Stock Block', 'Harness', true, true)`,
    [archiveId, deleteId, stockBlockId],
  )

  async function attempt(sql, params = []) {
    const sp = `sp_${Math.random().toString(36).slice(2, 8)}`
    await db.query(`SAVEPOINT ${sp}`)
    try {
      const res = await db.query(sql, params)
      await db.query(`RELEASE SAVEPOINT ${sp}`)
      return { ok: true, rows: res.rows, error: null }
    } catch (e) {
      await db.query(`ROLLBACK TO SAVEPOINT ${sp}`)
      return { ok: false, rows: [], error: e instanceof Error ? e.message : String(e) }
    }
  }

  // --- Catalogue / Inbound picker: active only ---
  {
    const before = await asUser(adminId, async () => {
      const r = await db.query(`SELECT * FROM public.product_catalogue()`)
      return r.rows.map((row) => row.product_id)
    })
    if (before.includes(archiveId)) pass("catalogue_includes_active", archiveId)
    else fail("catalogue_includes_active", JSON.stringify(before.slice(0, 5)))

    await setJwt(db, adminId)
    await db.query(`SELECT public.archive_product($1, $2)`, [archiveId, "MV1 harness archive"])

    const after = await asUser(adminId, async () => {
      const r = await db.query(`SELECT * FROM public.product_catalogue()`)
      return r.rows.map((row) => row.product_id)
    })
    if (!after.includes(archiveId)) pass("catalogue_excludes_archived", archiveId)
    else fail("catalogue_excludes_archived", "still present")

    const audit = await db.query(
      `SELECT actor, source, reason, changed
       FROM public.audit_log
       WHERE table_name = 'product_lines' AND row_id = $1 AND changed ? 'is_active'
       ORDER BY seq DESC LIMIT 1`,
      [archiveId],
    )
    const a = audit.rows[0]
    if (a?.actor === adminId && a?.source === "archive_product" && /MV1 harness archive/.test(a?.reason ?? "")) {
      pass("archive_audited", JSON.stringify({ actor: a.actor, source: a.source }))
    } else {
      fail("archive_audited", JSON.stringify(a))
    }
  }

  // --- Restore ---
  {
    await setJwt(db, adminId)
    await db.query(`SELECT public.restore_product($1, $2)`, [archiveId, "MV1 harness restore"])
    const row = await db.query(`SELECT is_active FROM public.product_lines WHERE id = $1`, [archiveId])
    if (row.rows[0]?.is_active === true) pass("restore_works", archiveId)
    else fail("restore_works", JSON.stringify(row.rows[0]))

    const cat = await asUser(adminId, async () => {
      const r = await db.query(`SELECT * FROM public.product_catalogue()`)
      return r.rows.map((x) => x.product_id)
    })
    if (cat.includes(archiveId)) pass("catalogue_after_restore", archiveId)
    else fail("catalogue_after_restore", "missing")
  }

  // --- Archive blocked with In Stock kits ---
  {
    const serial = `${PREFIX}-STOCK-1`
    await db.query(
      `INSERT INTO public.inventory_items (
         id, product_id, serial_number, status, stock_pool, location, date_added
       ) VALUES ($1, $2, $3, 'In Stock', 'sale', 'Warehouse A', $4)`,
      [nextId("ITEM"), stockBlockId, serial, DATE],
    )
    await setJwt(db, adminId)
    const blocked = await attempt(`SELECT public.archive_product($1, $2)`, [
      stockBlockId,
      "should fail",
    ])
    if (!blocked.ok && /In Stock/i.test(blocked.error ?? "")) {
      pass("archive_blocked_with_stock", blocked.error.split("\n")[0])
    } else {
      fail("archive_blocked_with_stock", blocked.error ?? "expected failure")
    }
  }

  // --- Delete blocked with history; allowed when clean ---
  {
    await setJwt(db, adminId)
    // Give deleteId a request-line history via a fake request is heavy; use inventory instead.
    await db.query(
      `INSERT INTO public.inventory_items (
         id, product_id, serial_number, status, stock_pool, location, date_added
       ) VALUES ($1, $2, $3, 'Sold', 'sale', 'Warehouse A', $4)`,
      [nextId("ITEM"), deleteId, `${PREFIX}-HIST-1`, DATE],
    )
    const blocked = await attempt(`SELECT public.delete_product($1, $2)`, [deleteId, "has history"])
    if (!blocked.ok && /history/i.test(blocked.error ?? "")) {
      pass("delete_blocked_with_history", blocked.error.split("\n")[0])
    } else {
      fail("delete_blocked_with_history", blocked.error ?? "expected failure")
    }

    // Clean product: deleteId has inventory — create a brand-new empty one
    const cleanId = `${PREFIX}-clean`
    await db.query(
      `INSERT INTO public.product_lines (id, product_name, vendor, requires_serial, is_active)
       VALUES ($1, 'MV1 Clean Delete', 'Harness', true, true)`,
      [cleanId],
    )
    const ok = await attempt(`SELECT public.delete_product($1, $2)`, [cleanId, "MV1 clean delete"])
    if (ok.ok) {
      const gone = await db.query(`SELECT 1 FROM public.product_lines WHERE id = $1`, [cleanId])
      if (gone.rows.length === 0) pass("delete_clean_ok", cleanId)
      else fail("delete_clean_ok", "still present")
    } else {
      fail("delete_clean_ok", ok.error)
    }
  }

  // --- Non-Inbound movement ignores client-sent product_id ---
  {
    const serial = `${PREFIX}-KEEP-PID`
    const itemId = nextId("ITEM")
    const other = await db.query(
      `SELECT id FROM public.product_lines
       WHERE is_active IS TRUE AND id IS DISTINCT FROM $1
       ORDER BY id LIMIT 1`,
      [liveProduct.id],
    )
    if (!other.rows[0]) throw new Error("need a second product_line")
    const wrongProductId = other.rows[0].id

    await db.query(
      `INSERT INTO public.inventory_items (
         id, product_id, serial_number, status, stock_pool, location, date_added
       ) VALUES ($1, $2, $3, 'In Stock', 'sale', 'Warehouse A', $4)`,
      [itemId, liveProduct.id, serial, DATE],
    )

    await setJwt(db, adminId)
    await dropMovementPrev(db)
    await db.query(
      `SELECT public.apply_stock_movement($1::jsonb, '[]'::jsonb, $2::jsonb)`,
      [
        JSON.stringify([
          {
            id: itemId,
            product_id: wrongProductId,
            serial_number: serial,
            status: "Sold",
            date_added: DATE,
            location: "Warehouse A",
            client: "MV1 Client",
          },
        ]),
        JSON.stringify([
          {
            id: nextId("TXN"),
            type: "Sale",
            serial_number: serial,
            item_name: liveProduct.product_name,
            date: DATE_ISO,
            client: "MV1 Client",
            batch_id: nextId("BATCH"),
            metadata: { invoice_choice: "pending" },
          },
        ]),
      ],
    )

    const kept = await db.query(
      `SELECT product_id, status FROM public.inventory_items WHERE id = $1`,
      [itemId],
    )
    const row = kept.rows[0]
    if (row?.product_id === liveProduct.id && row?.status === "Sold") {
      pass("non_inbound_keeps_kit_product", `${row.product_id} vs wrong ${wrongProductId}`)
    } else {
      fail("non_inbound_keeps_kit_product", JSON.stringify(row))
    }
  }

  // --- Non-admin cannot archive ---
  {
    await setJwt(db, techId)
    const refused = await attempt(`SELECT public.archive_product($1, $2)`, [
      archiveId,
      "tech should fail",
    ])
    if (!refused.ok && /admin only/i.test(refused.error ?? "")) {
      pass("archive_admin_only", refused.error.split("\n")[0])
    } else {
      fail("archive_admin_only", refused.error ?? "expected refusal")
    }
  }

  void NOTES
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-089-mv1-archive-movement.mjs")
if (isMain) {
  await withHarness({ markers: MARKERS, timeoutMs: 300_000, label: "089-mv1" }, runChecks)
}
