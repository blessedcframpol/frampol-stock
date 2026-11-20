/**
 * PL1 — product lines admin: rename collision, merge, delete gate, non-admin, retired pickers.
 *
 *   APPLY_MIGRATION_COMMIT=1 APPLY_MIGRATION_ENV=test node --require ./scripts/dev/tls-classic.cjs \
 *     scripts/apply-migrations-commit.mjs supabase/migrations/20261120082858_pl1_product_lines_admin.sql
 *   node --require ./scripts/dev/tls-classic.cjs scripts/verify-102-pl1-product-lines-admin.mjs
 */
import { runVerifyCli } from "./verify-harness.mjs"
import { setJwt } from "./verify-harness-fixtures.mjs"

const PREFIX = "H3102"
const NOTES = "harness-102-pl1"
const EMAIL = "harness-102-"

export const MARKERS = [
  {
    label: "products",
    sql: `SELECT count(*)::int AS n FROM public.product_lines WHERE id LIKE $1 OR product_name LIKE $2`,
    params: [`${PREFIX}%`, `${NOTES}%`],
  },
  {
    label: "items",
    sql: `SELECT count(*)::int AS n FROM public.inventory_items WHERE id LIKE $1 OR serial_number LIKE $1`,
    params: [`${PREFIX}%`],
  },
  {
    label: "request_lines",
    sql: `SELECT count(*)::int AS n FROM public.stock_request_lines srl
          JOIN public.stock_requests sr ON sr.id = srl.request_id
          WHERE sr.notes LIKE $1 OR srl.product_name LIKE $2`,
    params: [`${NOTES}%`, `${NOTES}%`],
  },
  {
    label: "users",
    sql: `SELECT count(*)::int AS n FROM auth.users WHERE email LIKE $1`,
    params: [`${EMAIL}%`],
  },
]

export async function runChecks(ctx) {
  const { db, pass, fail, asUser } = ctx
  await db.query(`SET LOCAL statement_timeout = '120s'`)

  const adminId = await ctx.createFixtureUser("admin", `${EMAIL}admin@test.local`)
  const salesId = await ctx.createFixtureUser("sales", `${EMAIL}sales@test.local`)

  const sourceId = `${PREFIX}-source`
  const targetId = `${PREFIX}-target`
  const collideId = `${PREFIX}-collide`
  const deleteId = `${PREFIX}-delete`
  const blockedId = `${PREFIX}-blocked`
  const retireId = `${PREFIX}-retire`

  await db.query(
    `INSERT INTO public.product_lines (id, product_name, vendor, requires_serial, requires_cloud_key, is_active)
     VALUES
       ($1, $2, 'Harness', true, false, true),
       ($3, $4, 'Harness', true, false, true),
       ($5, $6, 'Harness', true, false, true),
       ($7, $8, 'Harness', true, false, true),
       ($9, $10, 'Harness', true, false, true),
       ($11, $12, 'OtherVendor', true, false, true)`,
    [
      sourceId,
      `${NOTES} Source Kit`,
      targetId,
      `${NOTES} Target Kit`,
      collideId,
      `${NOTES} Collide Kit`,
      deleteId,
      `${NOTES} Delete Me`,
      blockedId,
      `${NOTES} Blocked Delete`,
      retireId,
      `${NOTES} Retire Me`,
    ],
  )

  const DATE = "2026-11-20"
  const itemId = `${PREFIX}-item-1`
  await db.query(
    `INSERT INTO public.inventory_items (
       id, product_id, serial_number, status, location, stock_pool, date_added
     ) VALUES ($1, $2, $3, 'In Stock', 'Warehouse', 'sale', $4)`,
    [itemId, blockedId, `${PREFIX}-SN-1`, DATE],
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

  // Columns present
  {
    const cols = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'product_lines'
        AND column_name IN ('retired_at', 'retired_by', 'merged_into_id')`)
    if (cols.rowCount === 3) pass("columns")
    else fail("columns", String(cols.rowCount))
  }

  // Audit trigger still present
  {
    const trig = await db.query(
      `SELECT 1 FROM pg_trigger WHERE tgname = 'tr_product_lines_audit' AND NOT tgisinternal`,
    )
    if (trig.rowCount === 1) pass("audit_trigger")
    else fail("audit_trigger", "missing")
  }

  // Rename collision → readable error
  {
    await setJwt(db, adminId)
    const hit = await attempt(
      `SELECT public.admin_update_product_line($1, $2, 'Harness', true, false)`,
      [sourceId, `${NOTES} Collide Kit`],
    )
    if (!hit.ok && /already exists/i.test(hit.error ?? "")) pass("rename_collision")
    else fail("rename_collision", hit.error ?? "expected unique collision")
  }

  // Non-admin refused
  {
    await setJwt(db, salesId)
    const hit = await attempt(
      `SELECT public.admin_update_product_line($1, $2, 'Harness', true, false)`,
      [sourceId, `${NOTES} Source Kit Renamed`],
    )
    if (!hit.ok && /admin only/i.test(hit.error ?? "")) pass("non_admin_refused")
    else fail("non_admin_refused", hit.error ?? "expected admin only")
  }

  // Successful rename
  {
    await setJwt(db, adminId)
    const hit = await attempt(
      `SELECT public.admin_update_product_line($1, $2, 'Harness', true, true) AS j`,
      [sourceId, `${NOTES} Source Kit Renamed`],
    )
    if (hit.ok && hit.rows[0]?.j?.requires_cloud_key === true) pass("rename_ok")
    else fail("rename_ok", JSON.stringify(hit))
  }

  // Delete blocked when referenced
  {
    await setJwt(db, adminId)
    const hit = await attempt(`SELECT public.delete_product($1, $2)`, [
      blockedId,
      "PL1 harness delete blocked",
    ])
    if (!hit.ok && /inventory|request|history/i.test(hit.error ?? "")) pass("delete_blocked")
    else fail("delete_blocked", hit.error ?? "expected block")
  }

  // Delete allowed when zero refs
  {
    await setJwt(db, adminId)
    const hit = await attempt(`SELECT public.delete_product($1, $2)`, [
      deleteId,
      "PL1 harness delete empty",
    ])
    if (hit.ok) pass("delete_empty_ok")
    else fail("delete_empty_ok", hit.error ?? "delete failed")
  }

  // Retire hides from catalogue
  {
    const before = await asUser(adminId, async () => {
      const r = await db.query(`SELECT product_id FROM public.product_catalogue()`)
      return r.rows.map((row) => row.product_id)
    })
    if (before.includes(retireId)) pass("catalogue_includes_active")
    else fail("catalogue_includes_active", "missing before retire")

    await setJwt(db, adminId)
    const retired = await attempt(`SELECT public.retire_product_line($1, $2)`, [
      retireId,
      "PL1 retire for picker test",
    ])
    if (!retired.ok) fail("retire_ok", retired.error ?? "retire failed")
    else pass("retire_ok")

    const after = await asUser(adminId, async () => {
      const r = await db.query(`SELECT product_id FROM public.product_catalogue()`)
      return r.rows.map((row) => row.product_id)
    })
    if (!after.includes(retireId)) pass("retired_hidden_from_picker")
    else fail("retired_hidden_from_picker", "still in catalogue")
  }

  // Merge moves counts + retires source
  {
    const itemSrc = `${PREFIX}-item-src`
    await db.query(
      `INSERT INTO public.inventory_items (
         id, product_id, serial_number, status, location, stock_pool, date_added
       ) VALUES ($1, $2, $3, 'In Stock', 'Warehouse', 'sale', $4)`,
      [itemSrc, sourceId, `${PREFIX}-SN-SRC`, DATE],
    )

    await setJwt(db, adminId)
    const cross = await attempt(
      `SELECT public.merge_product_lines($1, $2, $3, false)`,
      [sourceId, retireId, "PL1 cross vendor should fail here"],
    )
    // source Harness → retireId OtherVendor was wrong - retireId is OtherVendor?
    // Actually retireId vendor is OtherVendor in insert - wait I set retireId to OtherVendor
    // source is Harness, target for merge should be targetId (Harness).
    // Fix: merge source → targetId

    const blockedCross = await attempt(
      `SELECT public.merge_product_lines($1, $2, $3, false)`,
      [collideId, retireId, "PL1 cross vendor blocked reason"],
    )
    // collideId is Harness, retireId is OtherVendor and retired — may fail for retired target first.
    // Use a fresh cross-vendor pair instead.

    const crossSrc = `${PREFIX}-xsrc`
    const crossTgt = `${PREFIX}-xtgt`
    await db.query(
      `INSERT INTO public.product_lines (id, product_name, vendor, requires_serial, is_active)
       VALUES ($1, $2, 'VendorA', true, true), ($3, $4, 'VendorB', true, true)`,
      [crossSrc, `${NOTES} Cross Src`, crossTgt, `${NOTES} Cross Tgt`],
    )
    const crossBlock = await attempt(
      `SELECT public.merge_product_lines($1, $2, $3, false)`,
      [crossSrc, crossTgt, "PL1 cross vendor needs checkbox xx"],
    )
    if (!crossBlock.ok && /cross-vendor|differ/i.test(crossBlock.error ?? "")) pass("cross_vendor_blocked")
    else fail("cross_vendor_blocked", crossBlock.error ?? JSON.stringify(cross))

    const merged = await attempt(
      `SELECT public.merge_product_lines($1, $2, $3, false) AS j`,
      [sourceId, targetId, "PL1 merge duplicate kits intentionally"],
    )
    if (!merged.ok) {
      fail("merge_ok", merged.error ?? "merge failed")
    } else {
      const j = merged.rows[0]?.j
      if (Number(j?.inventory_moved) >= 1) pass("merge_moves_inventory", String(j.inventory_moved))
      else fail("merge_moves_inventory", JSON.stringify(j))
    }

    const src = await db.query(
      `SELECT merged_into_id, retired_at, is_active FROM public.product_lines WHERE id = $1`,
      [sourceId],
    )
    const s = src.rows[0]
    if (s?.merged_into_id === targetId && s?.retired_at && s?.is_active === false) pass("merge_retires_source")
    else fail("merge_retires_source", JSON.stringify(s))

    const item = await db.query(`SELECT product_id FROM public.inventory_items WHERE id = $1`, [itemSrc])
    if (item.rows[0]?.product_id === targetId) pass("merge_repoints_item")
    else fail("merge_repoints_item", JSON.stringify(item.rows[0]))

    const audit = await db.query(
      `SELECT source, reason FROM public.audit_log
       WHERE table_name = 'product_lines' AND row_id = $1 AND source = 'merge_product_lines'
       ORDER BY seq DESC LIMIT 1`,
      [sourceId],
    )
    if (audit.rows[0]?.reason?.includes("PL1 merge duplicate")) pass("merge_audit_reason")
    else fail("merge_audit_reason", JSON.stringify(audit.rows[0]))

    const invAudit = await db.query(
      `SELECT source, reason FROM public.audit_log
       WHERE table_name = 'inventory_items' AND row_id = $1 AND source = 'merge_product_lines'
       ORDER BY seq DESC LIMIT 1`,
      [itemSrc],
    )
    if (invAudit.rows[0]?.reason?.includes("PL1 merge duplicate")) pass("merge_inventory_audit_reason")
    else fail("merge_inventory_audit_reason", JSON.stringify(invAudit.rows[0]))

    const cat = await asUser(adminId, async () => {
      const r = await db.query(`SELECT product_id FROM public.product_catalogue()`)
      return r.rows.map((row) => row.product_id)
    })
    if (!cat.includes(sourceId) && cat.includes(targetId)) pass("merge_source_hidden_picker")
    else fail("merge_source_hidden_picker", JSON.stringify({ hasSource: cat.includes(sourceId) }))
  }

  // Overview admin-only
  {
    await setJwt(db, salesId)
    const denied = await attempt(`SELECT public.admin_product_lines_overview()`)
    if (!denied.ok && /admin only/i.test(denied.error ?? "")) pass("overview_non_admin")
    else fail("overview_non_admin", denied.error ?? "expected deny")

    await setJwt(db, adminId)
    const ok = await attempt(`SELECT jsonb_array_length(public.admin_product_lines_overview()) AS n`)
    if (ok.ok && Number(ok.rows[0]?.n) > 0) pass("overview_admin")
    else fail("overview_admin", JSON.stringify(ok))
  }
}

await runVerifyCli(
  { markers: MARKERS, timeoutMs: 180_000, label: "102-pl1" },
  runChecks,
)
