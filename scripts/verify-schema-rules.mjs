/**
 * Catalog / read-only schema rules that old verify scripts protected.
 * Runs inside the rollback harness (BEGIN…ROLLBACK) but performs no writes
 * except ephemeral SAVEPOINT probes that are rolled back.
 *
 * Usage: node scripts/verify-schema-rules.mjs
 *
 * Replaces (see REPLACES map at bottom / archive README):
 *   047 grants catalog half, 051 ACL/FK half, 054/057 audit triggers,
 *   055 bucket private, 059 viewer policy shape, 061 midnight constraint,
 *   066 anon EXECUTE, unique live serial, one-open-case, posted lock,
 *   SECURITY DEFINER search_path, invoice placeholder checks.
 */
import { withHarness } from "./verify-harness.mjs"

export const MARKERS = [
  { label: "schema_rules_noop", sql: "SELECT 0::int AS n", params: [] },
]

/** Old script → assertions in this file (and probe where noted). */
export const REPLACES = {
  "verify-047-stock-write-grants.mjs":
    "rls_enabled_all_tables; viewer_select_policies (grants/RPC behavior → harness behavioral scripts)",
  "verify-051-product-fk.mjs":
    "constraints_and_indexes (uniq live serial); anon_execute_none (RPC ACL half)",
  "verify-054-request-hygiene.mjs": "audit_triggers (profile_access / request hygiene triggers where present)",
  "verify-055-uploads-storage.mjs": "storage_bucket_private (+ probe: public URL refused)",
  "verify-057-profile-lockdown.mjs": "audit_triggers; rls_enabled_all_tables",
  "verify-059-viewer-role.mjs": "viewer_select_policies; viewer_no_write_policies (+ probe: viewer API 403)",
  "verify-061-transaction-dates.mjs": "transactions_date_iso_utc midnight constraint (+ behavioral midnight → harness 061 retired)",
  "verify-066-revoke-anon-execute.mjs": "anon_execute_none (+ probe: anon RPC denied)",
  "(no prior verify) unique live serial": "index uniq_inventory_items_serial_live",
  "(no prior verify) one open case": "index kit_cases_one_open_per_item",
  "(no prior verify) DEFINER search_path": "security_definer_search_path",
  "verify-079-audit-log.mjs (catalog half)": "posted_lock_trigger; audit_triggers; audit_log_append_only",
  "verify-075-batch-invoices.mjs (placeholder half)": "invoice_placeholder_function",
}

export async function runChecks(ctx) {
  const db = ctx.db
  const pass = ctx.pass
  const fail = ctx.fail

  // --- RLS on every public table ---
  {
    const rows = await db.query(
      `SELECT c.relname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
       ORDER BY 1`
    )
    if (rows.rowCount === 0) pass("rls_enabled_all_tables", "every public table has RLS")
    else fail("rls_enabled_all_tables", rows.rows.map((r) => r.relname).join(", "))
  }

  // --- anon EXECUTE on nothing in public ---
  {
    const rows = await db.query(
      `SELECT p.proname
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND has_function_privilege('anon', p.oid, 'EXECUTE')
       ORDER BY 1`
    )
    if (rows.rowCount === 0) pass("anon_execute_none", "anon can execute no public function")
    else fail("anon_execute_none", rows.rows.map((r) => r.proname).join(", "))
  }

  // --- SECURITY DEFINER must pin search_path ---
  {
    const rows = await db.query(
      `SELECT p.proname
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.prosecdef
         AND (
           p.proconfig IS NULL
           OR NOT EXISTS (
             SELECT 1 FROM unnest(p.proconfig) AS u(cfg)
             WHERE u.cfg LIKE 'search_path=%'
           )
         )
       ORDER BY 1`
    )
    if (rows.rowCount === 0) pass("security_definer_search_path", "every DEFINER has search_path")
    else fail("security_definer_search_path", rows.rows.map((r) => r.proname).join(", "))
  }

  // --- Key indexes / constraints ---
  {
    const need = [
      ["uniq_inventory_items_serial_live", "unique live serial"],
      ["kit_cases_one_open_per_item", "one open case per kit"],
    ]
    for (const [name, label] of need) {
      const found = await db.query(
        `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
        [name]
      )
      if (found.rowCount === 1) pass(`index:${name}`, label)
      else fail(`index:${name}`, "missing")
    }

    const midnight = await db.query(
      `SELECT 1 FROM pg_constraint
       WHERE conname = 'transactions_date_iso_utc'
         AND conrelid = 'public.transactions'::regclass`
    )
    if (midnight.rowCount === 1) {
      pass("constraint:transactions_date_iso_utc", "business-date midnight")
    } else {
      fail("constraint:transactions_date_iso_utc", "missing")
    }

    const invoiceChk = await db.query(
      `SELECT 1 FROM pg_constraint
       WHERE conname = 'batch_invoices_number_chk'
         AND conrelid = 'public.batch_invoices'::regclass`
    )
    if (invoiceChk.rowCount === 1) {
      pass("constraint:batch_invoices_number_chk", "invoice number / placeholder gate")
    } else {
      fail("constraint:batch_invoices_number_chk", "missing")
    }
  }

  // --- Invoice placeholder function ---
  {
    const fn = await db.query(
      `SELECT to_regprocedure('public.real_invoice_number_problem(text)') IS NOT NULL AS ok`
    )
    if (!fn.rows[0]?.ok) {
      fail("invoice_placeholder_function", "real_invoice_number_problem missing")
    } else {
      const samples = ["0000", "N/A", "-", "00000", "   ", "INV-1001"]
      const bad = []
      for (const sample of samples) {
        const r = await db.query(`SELECT public.real_invoice_number_problem($1) AS problem`, [sample])
        const problem = r.rows[0]?.problem
        const expectProblem = sample !== "INV-1001"
        if (expectProblem && !problem) bad.push(`${sample}: expected problem`)
        if (!expectProblem && problem) bad.push(`${sample}: ${problem}`)
      }
      if (bad.length === 0) pass("invoice_placeholder_function", "placeholders rejected; real number ok")
      else fail("invoice_placeholder_function", bad.join("; "))
    }
  }

  // --- Posted-transaction lock + audit triggers ---
  {
    const need = [
      ["transactions", "tr_transactions_lock_posted"],
      ["transactions", "tr_transactions_audit"],
      ["inventory_items", "tr_inventory_items_audit"],
      ["clients", "tr_clients_audit"],
      ["audit_log", "tr_audit_log_append_only"],
      ["kit_case_events", "tr_kit_case_events_append_only"],
      ["stock_pool_changes", "tr_stock_pool_changes_append_only"],
    ]
    for (const [table, tg] of need) {
      const found = await db.query(
        `SELECT 1
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = $1 AND t.tgname = $2 AND NOT t.tgisinternal`,
        [table, tg]
      )
      if (found.rowCount === 1) pass(`trigger:${tg}`, table)
      else fail(`trigger:${tg}`, "missing")
    }

    const fn = await db.query(
      `SELECT to_regprocedure('public.transactions_reject_posted_change()') IS NOT NULL AS ok`
    )
    if (fn.rows[0]?.ok) pass("posted_lock_function", "transactions_reject_posted_change")
    else fail("posted_lock_function", "missing")
  }

  // --- Viewer: SELECT policies exist; no permissive INSERT/UPDATE/DELETE for non-admin staff pattern ---
  {
    const selectTables = [
      "clients",
      "inventory_items",
      "transactions",
      "product_lines",
      "stock_requests",
      "stock_request_lines",
    ]
    const missing = []
    for (const table of selectTables) {
      const r = await db.query(
        `SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = $1 AND cmd = 'SELECT'
           AND (policyname ILIKE '%non-admin%' OR policyname ILIKE '%staff%' OR qual::text ILIKE '%viewer%')`,
        [table]
      )
      if (r.rowCount === 0) missing.push(table)
    }
    if (missing.length === 0) pass("viewer_select_policies", `${selectTables.length} staff/viewer SELECT policies`)
    else fail("viewer_select_policies", `missing: ${missing.join(", ")}`)

    const write = await db.query(
      `SELECT tablename, policyname, cmd
       FROM pg_policies
       WHERE schemaname = 'public'
         AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
         AND policyname ILIKE '%viewer%'
         AND policyname NOT ILIKE '%denied%'`
    )
    if (write.rowCount === 0) pass("viewer_no_write_policies", "no permissive viewer write policies")
    else fail("viewer_no_write_policies", write.rows.map((r) => `${r.tablename}.${r.policyname}`).join(", "))

    const denied = await db.query(
      `SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'product_lines'
         AND policyname = 'Non-admin product_lines update denied'`
    )
    if (denied.rowCount === 1) pass("viewer_product_lines_update_denied", "non-admin update denied")
    else fail("viewer_product_lines_update_denied", "policy missing")
  }

  // --- Storage bucket private ---
  {
    const bucket = await db.query(
      `SELECT id, public, file_size_limit
       FROM storage.buckets WHERE id = 'uploads' OR name = 'uploads'`
    )
    const row = bucket.rows[0]
    if (row && row.public === false) {
      pass("storage_bucket_private", `uploads private size=${row.file_size_limit}`)
    } else if (!row) {
      fail("storage_bucket_private", "uploads bucket missing")
    } else {
      fail("storage_bucket_private", `public=${row.public}`)
    }

    const permissive = await db.query(
      `SELECT policyname, cmd, roles::text AS roles
       FROM pg_policies
       WHERE schemaname = 'storage' AND tablename = 'objects'
         AND 'anon' = ANY (roles)`
    )
    if (permissive.rowCount === 0) pass("storage_no_anon_policies", "no storage.objects policy for anon")
    else fail("storage_no_anon_policies", permissive.rows.map((r) => r.policyname).join(", "))
  }

  // --- Midnight CHECK actually rejects (SAVEPOINT) ---
  {
    const sp = "sp_midnight"
    await db.query(`SAVEPOINT ${sp}`)
    try {
      await db.query(
        `INSERT INTO public.transactions (
           id, type, serial_number, item_name, client, date, previous_status_source
         ) VALUES (
           'TXN-schema-rules-midnight', 'Inbound', 'SCHEMA-RULES-MIDNIGHT', 'x', '',
           '2026-10-02T12:00:00.000Z', 'recorded'
         )`
      )
      await db.query(`ROLLBACK TO SAVEPOINT ${sp}`)
      fail("midnight_enforced", "non-midnight date was accepted")
    } catch (error) {
      await db.query(`ROLLBACK TO SAVEPOINT ${sp}`)
      const message = error instanceof Error ? error.message : String(error)
      if (/midnight|date_iso_utc|check/i.test(message)) {
        pass("midnight_enforced", "non-midnight date rejected")
      } else {
        fail("midnight_enforced", message)
      }
    }
  }

  console.log("\nSchema-rules replaces:")
  for (const [old, next] of Object.entries(REPLACES)) {
    console.log(`  ${old} → ${next}`)
  }
}

async function main() {
  const { ok, failed, passed } = await withHarness(
    { markers: MARKERS, timeoutMs: 60_000, label: "verify-schema-rules" },
    runChecks,
  )
  console.log(ok ? `\n${passed} passed` : `\n${failed} failed`)
  process.exitCode = ok ? 0 : 1
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-schema-rules.mjs")
if (isMain) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
