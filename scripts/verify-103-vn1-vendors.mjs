/**
 * VN1 — vendors admin: protected rename/delete, rename cascade, move atomic,
 * delete when non-empty, merge, case-insensitive duplicate, non-admin refused.
 *
 *   APPLY_MIGRATION_COMMIT=1 APPLY_MIGRATION_ENV=test node --require ./scripts/dev/tls-classic.cjs \
 *     scripts/apply-migrations-commit.mjs supabase/migrations/20261120085822_vn1_vendors.sql
 *   node --require ./scripts/dev/tls-classic.cjs scripts/verify-103-vn1-vendors.mjs
 */
import { runVerifyCli } from "./verify-harness.mjs"
import { insertHarnessClient, setJwt } from "./verify-harness-fixtures.mjs"

const PREFIX = "H3103"
const NOTES = "harness-103-vn1"
const EMAIL = "harness-103-"

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
    label: "vendors",
    sql: `SELECT count(*)::int AS n FROM public.vendors WHERE name LIKE $1`,
    params: [`${PREFIX}%`],
  },
  {
    label: "users",
    sql: `SELECT count(*)::int AS n FROM auth.users WHERE email LIKE $1`,
    params: [`${EMAIL}%`],
  },
  {
    label: "clients",
    sql: `SELECT count(*)::int AS n FROM public.clients WHERE id LIKE $1 OR email LIKE $2`,
    params: [`CLT-${PREFIX}%`, `${EMAIL}%`],
  },
  {
    label: "requests",
    sql: `SELECT count(*)::int AS n FROM public.stock_requests WHERE notes LIKE $1`,
    params: [`${NOTES}%`],
  },
]

export async function runChecks(ctx) {
  const { db, pass, fail } = ctx
  await db.query(`SET LOCAL statement_timeout = '120s'`)

  const adminId = await ctx.createFixtureUser("admin", `${EMAIL}admin@test.local`)
  const salesId = await ctx.createFixtureUser("sales", `${EMAIL}sales@test.local`)

  const vendorA = `${PREFIX}-Alpha`
  const vendorB = `${PREFIX}-Beta`
  const vendorMergeSrc = `${PREFIX}-MergeSrc`
  const vendorMergeTgt = `${PREFIX}-MergeTgt`
  const vendorEmpty = `${PREFIX}-Empty`
  const vendorBusy = `${PREFIX}-Busy`

  const prod1 = `${PREFIX}-p1`
  const prod2 = `${PREFIX}-p2`
  const prodBusy = `${PREFIX}-pbusy`
  const item1 = `${PREFIX}-item-1`

  await db.query(
    `INSERT INTO public.vendors (name, is_protected, protected_reason)
     VALUES
       ($1, false, NULL),
       ($2, false, NULL),
       ($3, false, NULL),
       ($4, false, NULL),
       ($5, false, NULL),
       ($6, false, NULL)
     ON CONFLICT (name) DO NOTHING`,
    [vendorA, vendorB, vendorMergeSrc, vendorMergeTgt, vendorEmpty, vendorBusy],
  )

  await db.query(
    `INSERT INTO public.product_lines (id, product_name, vendor, requires_serial, is_active)
     VALUES
       ($1, $2, $3, true, true),
       ($4, $5, $3, true, true),
       ($6, $7, $8, true, true)`,
    [
      prod1,
      `${NOTES} Kit One`,
      vendorA,
      prod2,
      `${NOTES} Kit Two`,
      prodBusy,
      `${NOTES} Busy Kit`,
      vendorBusy,
    ],
  )

  const DATE = "2026-11-20"
  await db.query(
    `INSERT INTO public.inventory_items (
       id, product_id, serial_number, status, location, stock_pool, date_added
     ) VALUES ($1, $2, $3, 'In Stock', 'Warehouse', 'sale', $4)`,
    [item1, prod1, `${PREFIX}-SN-1`, DATE],
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

  // Schema present
  {
    const tbl = await db.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'vendors'`,
    )
    if (tbl.rowCount === 1) pass("vendors_table")
    else fail("vendors_table", "missing")

    const fk = await db.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'product_lines_vendor_fkey'`,
    )
    if (fk.rowCount === 1) pass("vendor_fk")
    else fail("vendor_fk", "missing")

    const trig = await db.query(
      `SELECT 1 FROM pg_trigger WHERE tgname = 'tr_vendors_audit' AND NOT tgisinternal`,
    )
    if (trig.rowCount === 1) pass("audit_trigger")
    else fail("audit_trigger", "missing")
  }

  // Protected vendors seeded
  {
    const prot = await db.query(
      `SELECT name, is_protected FROM public.vendors
       WHERE name IN ('Starlink', 'Fortinet', 'General') AND is_protected`,
    )
    if (prot.rowCount === 3) pass("protected_seeded")
    else fail("protected_seeded", String(prot.rowCount))
  }

  // Non-admin refused
  {
    await setJwt(db, salesId)
    const hit = await attempt(`SELECT public.add_vendor($1)`, [`${PREFIX}-Nope`])
    if (!hit.ok && /admin/i.test(hit.error ?? "")) pass("non_admin_refused")
    else fail("non_admin_refused", hit.error ?? "expected admin only")
  }

  // Case-insensitive duplicate
  {
    await setJwt(db, adminId)
    const hit = await attempt(`SELECT public.add_vendor($1)`, [vendorA.toLowerCase()])
    if (!hit.ok && /already exists/i.test(hit.error ?? "")) pass("case_insensitive_dup")
    else fail("case_insensitive_dup", hit.error ?? "expected duplicate")
  }

  // Protected rename refused (with reason)
  {
    await setJwt(db, adminId)
    const hit = await attempt(`SELECT public.rename_vendor('Starlink', $1)`, [
      `${PREFIX}-StarlinkRenamed`,
    ])
    if (!hit.ok && /Cannot rename Starlink/i.test(hit.error ?? "")) pass("protected_rename_refused")
    else fail("protected_rename_refused", hit.error ?? "expected block")
  }

  // Protected delete refused
  {
    await setJwt(db, adminId)
    const hit = await attempt(`SELECT public.delete_vendor('General')`)
    if (!hit.ok && /Cannot delete General/i.test(hit.error ?? "")) pass("protected_delete_refused")
    else fail("protected_delete_refused", hit.error ?? "expected block")
  }

  // Rename cascades to product_lines
  {
    await setJwt(db, adminId)
    const renamed = `${PREFIX}-AlphaRenamed`
    const hit = await attempt(`SELECT public.rename_vendor($1, $2) AS j`, [vendorA, renamed])
    if (!hit.ok) {
      fail("rename_ok", hit.error ?? "rename failed")
    } else {
      const j = hit.rows[0]?.j
      if (Number(j?.products_updated) >= 2) pass("rename_ok", String(j.products_updated))
      else fail("rename_ok", JSON.stringify(j))

      const pl = await db.query(
        `SELECT count(*)::int AS n FROM public.product_lines WHERE vendor = $1 AND id IN ($2, $3)`,
        [renamed, prod1, prod2],
      )
      if (Number(pl.rows[0]?.n) === 2) pass("rename_cascades_products")
      else fail("rename_cascades_products", JSON.stringify(pl.rows[0]))

      // Restore canonical fixture name for later steps (CASCADE updates products).
      const restore = await attempt(`SELECT public.rename_vendor($1, $2)`, [renamed, vendorA])
      if (!restore.ok) fail("rename_restore", restore.error ?? "restore failed")
    }
  }

  // Rename collision → merge hint
  {
    await setJwt(db, adminId)
    const hit = await attempt(`SELECT public.rename_vendor($1, $2)`, [vendorB, vendorA])
    if (!hit.ok && /already exists|Merge/i.test(hit.error ?? "")) pass("rename_collision_merge_hint")
    else fail("rename_collision_merge_hint", hit.error ?? "expected collision")
  }

  // Delete blocked when non-empty
  {
    await setJwt(db, adminId)
    const hit = await attempt(`SELECT public.delete_vendor($1)`, [vendorBusy])
    if (!hit.ok && /Move its products first/i.test(hit.error ?? "")) pass("delete_nonempty_blocked")
    else fail("delete_nonempty_blocked", hit.error ?? "expected block")
  }

  // Delete empty ok
  {
    await setJwt(db, adminId)
    const hit = await attempt(`SELECT public.delete_vendor($1)`, [vendorEmpty])
    if (hit.ok) pass("delete_empty_ok")
    else fail("delete_empty_ok", hit.error ?? "delete failed")
  }

  // Move products atomic
  {
    await setJwt(db, adminId)
    const hit = await attempt(
      `SELECT public.move_products_to_vendor(ARRAY[$1, $2]::text[], $3, $4) AS j`,
      [prod1, prod2, vendorB, "VN1 harness move"],
    )
    if (!hit.ok) {
      fail("move_ok", hit.error ?? "move failed")
    } else {
      const j = hit.rows[0]?.j
      if (Number(j?.products_moved) === 2 && j?.vendor === vendorB) pass("move_ok", JSON.stringify(j))
      else fail("move_ok", JSON.stringify(j))

      const check = await db.query(
        `SELECT count(*)::int AS n FROM public.product_lines WHERE id IN ($1, $2) AND vendor = $3`,
        [prod1, prod2, vendorB],
      )
      if (Number(check.rows[0]?.n) === 2) pass("move_atomic")
      else fail("move_atomic", JSON.stringify(check.rows[0]))
    }
  }

  // Merge vendors
  {
    await db.query(
      `INSERT INTO public.product_lines (id, product_name, vendor, requires_serial, is_active)
       VALUES ($1, $2, $3, true, true)
       ON CONFLICT (id) DO NOTHING`,
      [`${PREFIX}-pmerge`, `${NOTES} Merge Kit`, vendorMergeSrc],
    )
    await setJwt(db, adminId)
    const hit = await attempt(`SELECT public.merge_vendors($1, $2) AS j`, [
      vendorMergeSrc,
      vendorMergeTgt,
    ])
    if (!hit.ok) {
      fail("merge_ok", hit.error ?? "merge failed")
    } else {
      const j = hit.rows[0]?.j
      if (Number(j?.products_moved) >= 1) pass("merge_ok", String(j.products_moved))
      else fail("merge_ok", JSON.stringify(j))

      const gone = await db.query(`SELECT 1 FROM public.vendors WHERE name = $1`, [vendorMergeSrc])
      if (gone.rowCount === 0) pass("merge_deletes_source")
      else fail("merge_deletes_source", "source still present")

      const moved = await db.query(
        `SELECT vendor FROM public.product_lines WHERE id = $1`,
        [`${PREFIX}-pmerge`],
      )
      if (moved.rows[0]?.vendor === vendorMergeTgt) pass("merge_moves_products")
      else fail("merge_moves_products", JSON.stringify(moved.rows[0]))
    }
  }

  // Protected merge-as-source refused
  {
    await setJwt(db, adminId)
    const hit = await attempt(`SELECT public.merge_vendors('Fortinet', $1)`, [vendorB])
    if (!hit.ok && /Cannot merge away Fortinet/i.test(hit.error ?? "")) pass("protected_merge_refused")
    else fail("protected_merge_refused", hit.error ?? "expected block")
  }

  // Overview admin-only + picker-visible rename cascade already covered via products
  {
    await setJwt(db, salesId)
    const denied = await attempt(`SELECT public.admin_vendors_overview()`)
    if (!denied.ok && /admin/i.test(denied.error ?? "")) pass("overview_non_admin")
    else fail("overview_non_admin", denied.error ?? "expected deny")

    await setJwt(db, adminId)
    const ok = await attempt(`SELECT jsonb_array_length(public.admin_vendors_overview()) AS n`)
    if (ok.ok && Number(ok.rows[0]?.n) > 0) pass("overview_admin")
    else fail("overview_admin", JSON.stringify(ok))
  }

  // ensure_product_line creates missing vendor
  {
    await setJwt(db, adminId)
    const newVendor = `${PREFIX}-EnsureNew`
    const hit = await attempt(`SELECT public.ensure_product_line($1, $2) AS id`, [
      `${NOTES} Ensure Product`,
      newVendor,
    ])
    if (!hit.ok) {
      fail("ensure_creates_vendor", hit.error ?? "ensure failed")
    } else {
      const v = await db.query(`SELECT 1 FROM public.vendors WHERE name = $1`, [newVendor])
      if (v.rowCount === 1) pass("ensure_creates_vendor")
      else fail("ensure_creates_vendor", "vendor row missing")
    }
  }

  // --- VN1b: protected move/merge guards ---
  const slProd = `${PREFIX}-sl-prod`
  const fgProd = `${PREFIX}-fg-prod`
  const intoSlProd = `${PREFIX}-into-sl`
  const intoFgVendor = vendorB

  await db.query(
    `INSERT INTO public.product_lines (id, product_name, vendor, requires_serial, is_active)
     VALUES
       ($1, $2, 'Starlink', true, true),
       ($3, $4, 'Fortinet', true, true),
       ($5, $6, $7, true, true)`,
    [
      slProd,
      `${NOTES} Starlink Out`,
      fgProd,
      `${NOTES} Fortinet Out`,
      intoSlProd,
      `${NOTES} Into Starlink`,
      intoFgVendor,
    ],
  )

  // Move into Starlink without reason → refused
  {
    await setJwt(db, adminId)
    const hit = await attempt(
      `SELECT public.move_products_to_vendor(ARRAY[$1]::text[], 'Starlink', NULL)`,
      [intoSlProd],
    )
    if (!hit.ok && /Explain why|15 characters/i.test(hit.error ?? "")) {
      pass("vn1b_into_starlink_reason_required")
    } else fail("vn1b_into_starlink_reason_required", hit.error ?? "expected reason")
  }

  // Move into Starlink with reason → ok
  {
    await setJwt(db, adminId)
    const hit = await attempt(
      `SELECT public.move_products_to_vendor(ARRAY[$1]::text[], 'Starlink', $2) AS j`,
      [intoSlProd, "VN1b into Starlink with reason"],
    )
    if (hit.ok && hit.rows[0]?.j?.vendor === "Starlink") pass("vn1b_into_starlink_with_reason")
    else fail("vn1b_into_starlink_with_reason", hit.error ?? JSON.stringify(hit.rows[0]))
  }

  // Starlink out blocked while kit Rented / rental pool / POC
  {
    const rentedId = `${PREFIX}-sl-rented`
    await db.query(
      `INSERT INTO public.inventory_items (
         id, product_id, serial_number, status, location, stock_pool, date_added
       ) VALUES ($1, $2, $3, 'Rented', 'Client', 'rental', $4)`,
      [rentedId, slProd, `${PREFIX}-SN-RENT`, DATE],
    )
    await setJwt(db, adminId)
    const preview = await attempt(
      `SELECT public.preview_vendor_product_move('Ubiquiti', ARRAY[$1]::text[], NULL) AS j`,
      [slProd],
    )
    const pj = preview.rows[0]?.j
    if (
      preview.ok &&
      pj?.blocked === true &&
      Number(pj?.starlink_out_kit_count) >= 1 &&
      pj?.requires_reason === true
    ) {
      pass("vn1b_preview_starlink_out_blocked")
    } else fail("vn1b_preview_starlink_out_blocked", JSON.stringify(pj ?? preview.error))

    const hit = await attempt(
      `SELECT public.move_products_to_vendor(ARRAY[$1]::text[], $2, $3)`,
      [slProd, vendorB, "VN1b try move Starlink with rental kits"],
    )
    if (!hit.ok && /out on rental/i.test(hit.error ?? "")) pass("vn1b_starlink_out_rental_blocked")
    else fail("vn1b_starlink_out_rental_blocked", hit.error ?? "expected rental block")
  }

  // Fortinet out blocked when open request has a line
  {
    const clientId = `CLT-${PREFIX}-c`
    await insertHarnessClient(db, {
      id: clientId,
      name: "VN1b Client",
      company: "VN1b Co",
      email: `${EMAIL}client@test.local`,
    })
    const ATLAS =
      "https://ai.frampolafrica.com:10801/my-tasks?view=all&task=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    const req = await db.query(
      `INSERT INTO public.stock_requests (
         client_id, created_by, review_state, type, notes, invoice_status, atlas_task_url
       ) VALUES ($1, $2::uuid, 'submitted', 'Sale', $3, 'pending', $4)
       RETURNING id`,
      [clientId, adminId, `${NOTES} open fortinet`, ATLAS],
    )
    const requestId = req.rows[0].id
    await db.query(
      `INSERT INTO public.stock_request_lines (request_id, product_id, product_name, quantity_requested)
       VALUES ($1, $2, $3, 1)`,
      [requestId, fgProd, `${NOTES} Fortinet Out`],
    )

    await setJwt(db, adminId)
    const preview = await attempt(
      `SELECT public.preview_vendor_product_move($1, ARRAY[$2]::text[], NULL) AS j`,
      [vendorB, fgProd],
    )
    const pj = preview.rows[0]?.j
    if (
      preview.ok &&
      pj?.blocked === true &&
      Number(pj?.fortinet_open_request_count) >= 1
    ) {
      pass("vn1b_preview_fortinet_open_blocked")
    } else fail("vn1b_preview_fortinet_open_blocked", JSON.stringify(pj ?? preview.error))

    const hit = await attempt(
      `SELECT public.move_products_to_vendor(ARRAY[$1]::text[], $2, $3)`,
      [fgProd, vendorB, "VN1b try move Fortinet with open request"],
    )
    if (!hit.ok && /open request/i.test(hit.error ?? "")) pass("vn1b_fortinet_open_blocked")
    else fail("vn1b_fortinet_open_blocked", hit.error ?? "expected open-request block")
  }

  // Merge into protected target without reason
  {
    const mergeSrc2 = `${PREFIX}-MergeSrc2`
    await db.query(
      `INSERT INTO public.vendors (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
      [mergeSrc2],
    )
    await db.query(
      `INSERT INTO public.product_lines (id, product_name, vendor, requires_serial, is_active)
       VALUES ($1, $2, $3, true, true)`,
      [`${PREFIX}-pmerge2`, `${NOTES} Merge Into Prot`, mergeSrc2],
    )
    await setJwt(db, adminId)
    const hit = await attempt(`SELECT public.merge_vendors($1, 'General', NULL)`, [mergeSrc2])
    if (!hit.ok && /Explain why|15 characters/i.test(hit.error ?? "")) {
      pass("vn1b_merge_into_protected_reason")
    } else fail("vn1b_merge_into_protected_reason", hit.error ?? "expected reason")

    const ok = await attempt(
      `SELECT public.merge_vendors($1, 'General', $2) AS j`,
      [mergeSrc2, "VN1b merge into General with reason"],
    )
    if (ok.ok) pass("vn1b_merge_into_protected_with_reason")
    else fail("vn1b_merge_into_protected_with_reason", ok.error ?? "merge failed")
  }
}

await runVerifyCli(
  { markers: MARKERS, timeoutMs: 180_000, label: "103-vn1" },
  runChecks,
)
