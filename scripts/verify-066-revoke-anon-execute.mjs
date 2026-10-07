/**
 * Verify the anon EXECUTE revoke. Does not apply the migration.
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SUPABASE_DB_URL (or DATABASE_URL)
 *
 * Usage: node scripts/verify-066-revoke-anon-execute.mjs
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"
import { createClient } from "@supabase/supabase-js"

const require = createRequire(import.meta.url)
const { prepareVerifyEnv } = require("./verify-env.cjs")
const PREFIX = "verify-066-"
const EMAIL_PREFIX = "verify-066-"
const DATE = "2026-01-15T00:00:00.000Z"
const LATER = "2026-01-16T00:00:00.000Z"

function pass(results, name, reason) {
  results[name] = { result: "PASS", reason }
  console.log(`PASS  ${name} — ${reason}`)
}

function fail(results, name, reason) {
  results[name] = { result: "FAIL", reason }
  console.log(`FAIL  ${name} — ${reason}`)
}

async function expectError(fn) {
  try {
    await fn()
    return null
  } catch (error) {
    return error
  }
}

async function main() {
  prepareVerifyEnv()
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

  async function cleanup() {
    await db.query(`DELETE FROM public.batch_reversals WHERE batch_id LIKE $1`, [`${PREFIX}%`]).catch(() => {})
    await db.query(
      `DELETE FROM public.transactions WHERE id LIKE $1 OR serial_number LIKE $1 OR batch_id LIKE $1`,
      [`${PREFIX}%`]
    )
    await db.query(`DELETE FROM public.inventory_items WHERE id LIKE $1 OR serial_number LIKE $1`, [`${PREFIX}%`])
    await db.query(`DROP FUNCTION IF EXISTS public.verify_066_probe()`)
    const { rows } = await db.query(`SELECT id::text AS id FROM auth.users WHERE email LIKE $1`, [`${EMAIL_PREFIX}%`])
    for (const id of new Set([...userIds, ...rows.map((row) => row.id)])) {
      const { error } = await service.auth.admin.deleteUser(id)
      if (error && !/not found/i.test(error.message)) throw error
    }
  }

  try {
    const dropped = await db.query(`SELECT to_regprocedure('public.set_updated_at()') IS NULL AS gone`)
    if (!dropped.rows[0]?.gone) throw new Error("Apply the anon EXECUTE migration before running this script.")

    const anonFns = await db.query(
      `SELECT p.proname
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND has_function_privilege('anon', p.oid, 'EXECUTE')
       ORDER BY p.proname`
    )
    if (anonFns.rows.length === 0) {
      pass(results, "anon_execute", "anon can execute no function in public")
    } else {
      fail(results, "anon_execute", anonFns.rows.map((row) => row.proname).join(", "))
    }

    await db.query(`CREATE FUNCTION public.verify_066_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$`)
    const probe = await db.query(
      `SELECT
         has_function_privilege('anon', 'public.verify_066_probe()', 'EXECUTE') AS anon_exec,
         has_function_privilege('authenticated', 'public.verify_066_probe()', 'EXECUTE') AS auth_exec`
    )
    await db.query(`DROP FUNCTION public.verify_066_probe()`)
    if (probe.rows[0]?.anon_exec === false && probe.rows[0]?.auth_exec === true) {
      pass(results, "new_function", "a function created after the change has no anon grant, and authenticated still does")
    } else {
      fail(results, "new_function", JSON.stringify(probe.rows[0]))
    }

    const product = await db.query(`SELECT id FROM public.product_lines ORDER BY id LIMIT 1`)
    const productId = product.rows[0]?.id
    if (!productId) throw new Error("No product line to attach the status fixture")

    await db.query(
      `INSERT INTO public.inventory_items (id, product_id, serial_number, status, date_added, location)
       VALUES ($1, $2, $3, 'In Stock', '2026-01-15', 'Warehouse A')`,
      [`${PREFIX}item-status`, productId, `${PREFIX}status`]
    )
    const blockedStatus = await expectError(() =>
      db.query(`UPDATE public.inventory_items SET status = 'Maintenance' WHERE id = $1`, [`${PREFIX}item-status`])
    )
    const statusRow = await db.query(`SELECT status FROM public.inventory_items WHERE id = $1`, [`${PREFIX}item-status`])
    if (
      blockedStatus &&
      /Invalid inventory status transition: In Stock -> Maintenance/.test(blockedStatus.message) &&
      statusRow.rows[0]?.status === "In Stock"
    ) {
      pass(results, "status_guard", "an illegal status write is still rejected and the row stays In Stock")
    } else {
      fail(results, "status_guard", blockedStatus?.message ?? `status ${statusRow.rows[0]?.status}`)
    }

    await db.query(
      `INSERT INTO public.transactions (id, type, serial_number, item_name, client, date, batch_id, created_at)
       VALUES
         ($1, 'Sale', $3, 'Verify kit', 'Internal', $4, $5, $6),
         ($2, 'Sale', $3, 'Verify kit', 'Internal', $7, $8, $9)`,
      [
        `${PREFIX}txn-early`,
        `${PREFIX}txn-later`,
        `${PREFIX}guard`,
        DATE,
        `${PREFIX}batch-early`,
        DATE,
        LATER,
        `${PREFIX}batch-later`,
        LATER,
      ]
    )
    const email = `${EMAIL_PREFIX}admin@test.local`
    const { data: created, error: createError } = await service.auth.admin.createUser({ email, email_confirm: true })
    if (createError) throw new Error(`createUser: ${createError.message}`)
    userIds.push(created.user.id)
    const updated = await db.query(
      `UPDATE public.profiles SET role = 'admin'::public.app_role, active = true WHERE id = $1`,
      [created.user.id]
    )
    if (updated.rowCount !== 1) throw new Error("admin profile was not updated")
    await db.query("BEGIN")
    await db.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [created.user.id])
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: created.user.id }),
    ])
    const blockedReverse = await expectError(() =>
      db.query(`SELECT public.reverse_quick_scan_batch($1, $2, NULL, '[]'::jsonb)`, [
        `${PREFIX}batch-early`,
        "verify-066 later batch still blocks",
      ])
    )
    await db.query("ROLLBACK")
    const stillThere = await db.query(`SELECT id FROM public.transactions WHERE id = $1`, [`${PREFIX}txn-early`])
    if (
      blockedReverse &&
      /blocked by later batch/.test(blockedReverse.message) &&
      stillThere.rows.length === 1
    ) {
      pass(results, "reversal_order_guard", "reversing an earlier batch is blocked while a later one exists")
    } else {
      fail(results, "reversal_order_guard", blockedReverse?.message ?? "reverse was allowed")
    }

    const beforeSettings = await db.query(
      `SELECT updated_at, updated_by, low_stock_recipients, timezone, default_reorder_level, low_stock_emails_enabled
       FROM public.app_settings WHERE id`
    )
    const before = beforeSettings.rows[0]
    await db.query("BEGIN")
    const badRecipient = await expectError(() =>
      db.query(`UPDATE public.app_settings SET low_stock_recipients = ARRAY['not-an-email'] WHERE id`)
    )
    await db.query("ROLLBACK")
    await db.query("BEGIN")
    await db.query(`UPDATE public.app_settings SET low_stock_recipients = low_stock_recipients WHERE id`)
    const stamped = await db.query(
      `SELECT updated_at, updated_by, auth.uid() AS uid FROM public.app_settings WHERE id`
    )
    await db.query("ROLLBACK")
    const restored = await db.query(
      `SELECT updated_at, updated_by, low_stock_recipients, timezone, default_reorder_level, low_stock_emails_enabled
       FROM public.app_settings WHERE id`
    )
    const stamp = stamped.rows[0]
    const same =
      JSON.stringify(restored.rows[0].low_stock_recipients) === JSON.stringify(before.low_stock_recipients) &&
      restored.rows[0].timezone === before.timezone &&
      restored.rows[0].default_reorder_level === before.default_reorder_level &&
      restored.rows[0].low_stock_emails_enabled === before.low_stock_emails_enabled &&
      String(restored.rows[0].updated_by ?? "") === String(before.updated_by ?? "") &&
      new Date(restored.rows[0].updated_at).getTime() === new Date(before.updated_at).getTime()
    if (
      badRecipient &&
      /Invalid low-stock recipient email/.test(badRecipient.message) &&
      new Date(stamp.updated_at).getTime() >= new Date(before.updated_at).getTime() &&
      String(stamp.updated_by ?? "") === String(stamp.uid ?? "") &&
      same
    ) {
      pass(results, "settings_triggers", "a bad recipient is rejected, metadata is stamped, and the row is unchanged")
    } else {
      fail(
        results,
        "settings_triggers",
        JSON.stringify({
          recipient: badRecipient?.message ?? "update was allowed",
          stamp,
          restored: same,
        })
      )
    }

    const admin = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
    const { data: link, error: linkError } = await service.auth.admin.generateLink({ type: "magiclink", email })
    if (linkError) throw new Error(`generateLink: ${linkError.message}`)
    const { data: sessionData, error: signInError } = await admin.auth.verifyOtp({
      token_hash: link.properties.hashed_token,
      type: "magiclink",
    })
    if (signInError || !sessionData.session) throw new Error(`verifyOtp: ${signInError?.message ?? "no session"}`)

    const serial = `${PREFIX}move`
    const itemId = `${PREFIX}item-move`
    const batchId = `${PREFIX}batch-move`
    const txnId = `${PREFIX}txn-move`
    const { error: moveError } = await admin.rpc("apply_stock_movement", {
      p_inventory_upserts: [],
      p_inventory_inserts: [
        {
          id: itemId,
          product_id: productId,
          serial_number: serial,
          status: "In Stock",
          date_added: "2026-01-15",
          location: "Warehouse A",
          client: "Internal",
        },
      ],
      p_transactions: [
        {
          id: txnId,
          type: "Inbound",
          serial_number: serial,
          item_name: "Verify kit",
          client: "Internal",
          date: DATE,
          batch_id: batchId,
          created_by: created.user.id,
        },
      ],
    })
    const moved = await db.query(
      `SELECT status FROM public.inventory_items WHERE id = $1 AND deleted_at IS NULL`,
      [itemId]
    )
    if (!moveError && moved.rows[0]?.status === "In Stock") {
      pass(results, "signed_in_movement", "an admin Inbound through apply_stock_movement still writes the item")
    } else {
      fail(results, "signed_in_movement", moveError?.message ?? `status ${moved.rows[0]?.status}`)
    }

    const ledger = await admin.rpc("transaction_batch_page", {
      p_limit: 20,
      p_offset: 0,
      p_search: serial,
    })
    const dispatched = await admin.rpc("dispatched_page", {
      p_limit: 5,
      p_offset: 0,
    })
    const ledgerText = JSON.stringify(ledger.data ?? null)
    if (!ledger.error && ledger.data?.total === 1 && ledgerText.includes(txnId) && !dispatched.error && dispatched.data != null) {
      pass(results, "signed_in_pages", "ledger search returns the fixture batch and dispatched_page still runs")
    } else {
      fail(
        results,
        "signed_in_pages",
        JSON.stringify({
          ledger: ledger.error?.message ?? ledgerText.slice(0, 180),
          dispatched: dispatched.error?.message ?? (dispatched.data == null ? "empty" : "ok"),
        })
      )
    }

    const reversal = await admin.rpc("reverse_quick_scan_batch", {
      p_batch_id: batchId,
      p_reason: "verify-066 grant check",
      p_return_location: "Warehouse A",
      p_confirmed: [],
    })
    const kept = await db.query(`SELECT id FROM public.transactions WHERE id = $1`, [txnId])
    const linked = await db.query(`SELECT id FROM public.transactions WHERE reverses_transaction_id = $1`, [txnId])
    const soft = await db.query(`SELECT deleted_at IS NOT NULL AS removed FROM public.inventory_items WHERE id = $1`, [
      itemId,
    ])
    const audit = await db.query(`SELECT batch_id FROM public.batch_reversals WHERE batch_id = $1`, [batchId])
    const ok =
      reversal.data?.ok === true &&
      kept.rows.length === 1 &&
      linked.rows.length === 1 &&
      soft.rows[0]?.removed === true &&
      audit.rows.length === 1
    if (!reversal.error && ok) {
      pass(results, "signed_in_reversal", "an admin reversal keeps the original row, links a Reversal, and soft-deletes the created item")
    } else {
      fail(results, "signed_in_reversal", reversal.error?.message ?? JSON.stringify(reversal.data))
    }
  } finally {
    await cleanup()
    const residue = await db.query(
      `SELECT
         (SELECT count(*)::integer FROM public.transactions WHERE id LIKE $1 OR serial_number LIKE $1 OR batch_id LIKE $1) AS transactions,
         (SELECT count(*)::integer FROM public.inventory_items WHERE id LIKE $1 OR serial_number LIKE $1) AS items,
         (SELECT count(*)::integer FROM public.batch_reversals WHERE batch_id LIKE $1) AS reversals,
         (SELECT count(*)::integer FROM auth.users WHERE email LIKE $2) AS users,
         (SELECT count(*)::integer FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'verify_066_probe') AS probe`,
      [`${PREFIX}%`, `${EMAIL_PREFIX}%`]
    )
    const left = residue.rows[0]
    if (left.transactions === 0 && left.items === 0 && left.reversals === 0 && left.users === 0 && left.probe === 0) {
      pass(results, "residue", "no verify-066 rows, users, or probe function left")
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
