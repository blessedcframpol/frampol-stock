/**
 * Verify migration 047_tighten_stock_write_grants.sql against live RLS + RPC.
 *
 * Does not apply SQL. Asserts 047 is already on the database, creates
 * verify-047-* fixture users, runs checks 1–25, then deletes fixtures
 * (even on failure).
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SUPABASE_DB_URL  (or DATABASE_URL) — direct/pooler Postgres URI
 *
 * Usage: node scripts/verify-047-stock-write-grants.mjs
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"
import { execSync } from "child_process"
import { createClient } from "@supabase/supabase-js"

const require = createRequire(import.meta.url)

const FIXTURE_PASSWORD = "Verify047!StockWrite-Temp"
const EMAIL = {
  sales: "verify-047-sales@example.com",
  accounts: "verify-047-accounts@example.com",
  techB: "verify-047-tech-b@example.com",
  norole: "verify-047-norole@example.com",
}

function loadEnvLocal() {
  const p = path.join(process.cwd(), ".env.local")
  if (!fs.existsSync(p)) return
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    let val = m[2].trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function isRlsError(e) {
  return e?.code === "42501" || /row-level security/i.test(String(e?.message || ""))
}

function stamp() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

async function require047Schema(admin) {
  const { rows: pol } = await admin.query(`
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'inventory_items'
      AND policyname = 'Technicians insert inventory_items'
  `)
  if (!pol[0]) {
    throw new Error(
      'Expected 047 schema is missing (policy "Technicians insert inventory_items"). Apply supabase/migrations/047_tighten_stock_write_grants.sql first.'
    )
  }

  const { rows: dropped } = await admin.query(`
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'inventory_items'
      AND policyname = 'Non-admin insert inventory_items'
  `)
  if (dropped[0]) {
    throw new Error(
      'Expected 047 schema is missing: superseded policy "Non-admin insert inventory_items" is still present. Apply supabase/migrations/047_tighten_stock_write_grants.sql first.'
    )
  }

  const { rows: rpc } = await admin.query(`
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'reverse_quick_scan_batch'
      AND pg_get_function_identity_arguments(p.oid) = 'p_batch_id text, p_reason text, p_return_location text, p_confirmed jsonb'
  `)
  if (!rpc[0]) {
    throw new Error(
      "Expected reverse_quick_scan_batch(p_batch_id text, p_reason text, p_return_location text, p_confirmed jsonb)."
    )
  }
}

async function main() {
  loadEnvLocal()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL

  assert(url, "Missing NEXT_PUBLIC_SUPABASE_URL")
  assert(serviceKey, "Missing SUPABASE_SERVICE_ROLE_KEY")
  assert(dbUrl, "Missing SUPABASE_DB_URL or DATABASE_URL")

  let pg
  try {
    pg = require("pg")
  } catch {
    console.error("Installing pg…")
    execSync("npm install pg --no-save", { stdio: "inherit" })
    pg = require("pg")
  }

  const supabaseAdmin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const admin = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
  await admin.connect()
  console.log("Connected to Postgres")

  const results = {}
  const fixtureUserIds = []
  const cleanupIds = {
    inventory: [],
    transactions: [],
    batches: [],
    productLines: [],
    outbound: [],
    remediationProviders: [],
  }

  function pass(name, reason) {
    results[name] = { result: "PASS", reason }
    console.log(`PASS  ${name} — ${reason}`)
  }
  function fail(name, reason) {
    results[name] = { result: "FAIL", reason }
    console.log(`FAIL  ${name} — ${reason}`)
  }
  function skip(name, reason) {
    results[name] = { result: "SKIPPED", reason }
    console.log(`SKIPPED ${name} — ${reason}`)
  }

  async function asUser(userId, fn) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
    await client.connect()
    try {
      await client.query("BEGIN")
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: userId, role: "authenticated" }),
      ])
      await client.query(`SET LOCAL ROLE authenticated`)
      const result = await fn(client)
      await client.query("COMMIT")
      return result
    } catch (e) {
      try {
        await client.query("ROLLBACK")
      } catch {
        /* ignore */
      }
      throw e
    } finally {
      await client.end()
    }
  }

  /** Like asUser but always rolls back (for atomicity check 25). */
  async function asUserRollback(userId, fn) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
    await client.connect()
    try {
      await client.query("BEGIN")
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: userId, role: "authenticated" }),
      ])
      await client.query(`SET LOCAL ROLE authenticated`)
      const result = await fn(client)
      await client.query("ROLLBACK")
      return result
    } catch (e) {
      try {
        await client.query("ROLLBACK")
      } catch {
        /* ignore */
      }
      throw e
    } finally {
      await client.end()
    }
  }

  async function deleteFixtureUsersByEmail() {
    const { rows } = await admin.query(
      `SELECT id::text AS id, email FROM public.profiles WHERE email LIKE 'verify-047-%'`
    )
    for (const r of rows) {
      const { error } = await supabaseAdmin.auth.admin.deleteUser(r.id)
      if (error) console.warn(`Could not delete fixture ${r.email}: ${error.message}`)
      else console.log(`Deleted leftover fixture user ${r.email}`)
    }
  }

  async function createFixtureUser(email, role) {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: FIXTURE_PASSWORD,
      email_confirm: true,
    })
    if (error) throw new Error(`createUser(${email}): ${error.message}`)
    const id = data.user.id
    fixtureUserIds.push(id)
    if (role === null) {
      await admin.query(`UPDATE public.profiles SET role = NULL, active = true WHERE id = $1`, [id])
    } else {
      await admin.query(`UPDATE public.profiles SET role = $2::public.app_role, active = true WHERE id = $1`, [
        id,
        role,
      ])
    }
    const { rows } = await admin.query(
      `SELECT id::text AS id, email, role::text AS role, active FROM public.profiles WHERE id = $1`,
      [id]
    )
    assert(rows[0], `Profile missing after createUser for ${email}`)
    if (role === null) {
      assert(rows[0].role == null && rows[0].active === true, `norole fixture not NULL/active: ${JSON.stringify(rows[0])}`)
    } else {
      assert(rows[0].role === role && rows[0].active === true, `Fixture ${email} not ${role}/active: ${JSON.stringify(rows[0])}`)
    }
    return rows[0]
  }

  async function ensureProductLine() {
    const id = `pl-verify-047-${stamp()}`
    const name = `__verify_047_product_${stamp()}__`
    await admin.query(
      `INSERT INTO public.product_lines (id, product_name, vendor) VALUES ($1, $2, 'General')`,
      [id, name]
    )
    cleanupIds.productLines.push(id)
    return { id, name }
  }

  async function insertInventoryAsService(overrides = {}) {
    const pl = overrides.productId ? { id: overrides.productId } : await ensureProductLine()
    const id = overrides.id ?? `inv-verify-047-${stamp()}`
    const serial = overrides.serial ?? `V047-${stamp()}`
    await admin.query(
      `INSERT INTO public.inventory_items (
         id, product_id, serial_number, status, date_added, location, client, assigned_to
       ) VALUES ($1, $2, $3, $4, current_date::text, $5, $6, $7)`,
      [
        id,
        pl.id,
        serial,
        overrides.status ?? "In Stock",
        overrides.location ?? "Warehouse A",
        overrides.client ?? null,
        overrides.assigned_to ?? null,
      ]
    )
    cleanupIds.inventory.push(id)
    return { id, serial, productId: pl.id, productName: pl.name ?? overrides.productName ?? "Verify047" }
  }

  /**
   * Build a disposable Sale batch (1 Sold item + 1 Sale txn) for reverse_quick_scan_batch.
   * Returns plan payloads ready for the RPC.
   */
  async function buildDisposableSaleBatch(label) {
    const tag = stamp()
    const batchId = `BATCH-V047-${label}-${tag}`
    const revBatchId = `BATCH-REV-V047-${label}-${tag}`
    const pl = await ensureProductLine()
    const invId = `inv-v047-${label}-${tag}`
    const txnId = `txn-v047-${label}-${tag}`
    const serial = `V047-${label}-${tag}`
    const productName = pl.name

    await admin.query(
      `INSERT INTO public.inventory_items (
         id, product_id, serial_number, status, date_added, location, client, assigned_to
       ) VALUES ($1, $2, $3, 'Sold', current_date::text, 'Delivered', 'Verify Client', 'Verify Client')`,
      [invId, pl.id, serial]
    )
    cleanupIds.inventory.push(invId)

    await admin.query(
      `INSERT INTO public.transactions (
         id, type, serial_number, item_name, client, date, batch_id, created_by,
         previous_status, previous_status_source
       ) VALUES ($1, 'Sale', $2, $3, 'Verify Client', $4, $5, NULL, 'In Stock', 'recorded')`,
      [txnId, serial, productName, new Date().toISOString(), batchId]
    )
    cleanupIds.transactions.push(txnId)
    cleanupIds.batches.push(batchId)

    const revertedRow = {
      status: "In Stock",
      location: "Warehouse A",
      client: null,
      assigned_to: null,
      poc_out_date: null,
      return_date: null,
    }

    const entries = [
      {
        serial,
        entry_kind: "full",
        inventory_id: invId,
        transaction_id: txnId,
        reverted_row: revertedRow,
        expected_status: "Sold",
        expected_location: null,
      },
    ]

    const reversalTransactions = [
      {
        id: `txn-rev-v047-${label}-${tag}`,
        type: "Reversal",
        serial_number: "(batch)",
        item_name: productName,
        client: "Verify Client",
        date: new Date().toISOString(),
        client_id: null,
        invoice_number: null,
        notes: null,
        from_location: null,
        to_location: null,
        assigned_to: null,
        disposal_reason: null,
        authorised_by: null,
        batch_id: revBatchId,
        delivery_note_url: null,
        metadata: {
          reversedBatchId: batchId,
          originalMovementType: "Sale",
          returnLocation: "Warehouse A",
          serialNumbers: [serial],
          itemCount: 1,
        },
        created_by: null,
      },
    ]
    cleanupIds.transactions.push(reversalTransactions[0].id)
    cleanupIds.batches.push(revBatchId)

    return { batchId, revBatchId, invId, txnId, serial, entries, reversalTransactions }
  }

  try {
    console.log("\n=== Checking 047 schema is already applied ===")
    await require047Schema(admin)
    console.log("047 schema present")

    // ----------------------------------------------------------- leftover wipe
    await deleteFixtureUsersByEmail()

    // -------------------------------------------------------------- fixtures
    console.log("\n=== Resolving fixtures ===")
    const { rows: liveProfiles } = await admin.query(`
      SELECT id::text AS id, email, role::text AS role, active
      FROM public.profiles
      ORDER BY role NULLS LAST, email
    `)

    const adminUser = liveProfiles.find((p) => p.role === "admin" && p.active)
    const techA = liveProfiles.find((p) => p.role === "technicians" && p.active)
    const inactiveSales = liveProfiles.find((p) => p.role === "sales" && p.active === false)

    assert(adminUser, "Need an existing active admin profile (reuse, do not create)")
    assert(techA, "Need an existing active technicians profile (reuse, do not create)")
    assert(inactiveSales, "Need the existing inactive sales profile for check 17")

    console.log(`Reusing admin: ${adminUser.email}`)
    console.log(`Reusing technicians: ${techA.email}`)
    console.log(`Reusing inactive sales: ${inactiveSales.email}`)

    const sales = await createFixtureUser(EMAIL.sales, "sales")
    const accounts = await createFixtureUser(EMAIL.accounts, "accounts")
    const techB = await createFixtureUser(EMAIL.techB, "technicians")
    const norole = await createFixtureUser(EMAIL.norole, null)

    // Hard assert — never proceed with a missing fixture
    const required = { adminUser, techA, techB, sales, accounts, norole, inactiveSales }
    for (const [k, v] of Object.entries(required)) {
      if (!v?.id) {
        console.error(`Required fixture missing: ${k}`)
        process.exit(1)
      }
    }
    console.log("All fixtures resolved")

    // Ensure remediation_providers has at least one row for leak checks
    {
      const { rows } = await admin.query(`SELECT count(*)::int AS n FROM public.remediation_providers`)
      if (rows[0].n === 0) {
        const ins = await admin.query(
          `INSERT INTO public.remediation_providers (slug, display_name)
           VALUES ('verify-047-provider', 'Verify 047 Provider')
           RETURNING id::text AS id`
        )
        cleanupIds.remediationProviders.push(ins.rows[0].id)
      }
    }

    const targetInv = await insertInventoryAsService({ status: "In Stock" })
    const plForTechInsert = await ensureProductLine()

    // ============================================================== WRITES
    console.log("\n=== Writes ===")

    // 1. sales INSERT inventory_items -> denied
    try {
      await asUser(sales.id, async (c) => {
        await c.query(
          `INSERT INTO public.inventory_items (id, product_id, serial_number, status, date_added, location)
           VALUES ($1, $2, $3, 'In Stock', current_date::text, 'Warehouse A')`,
          [`inv-v047-sales-${stamp()}`, plForTechInsert.id, `V047-S-${stamp()}`]
        )
      })
      fail("1_sales_insert_inventory", "INSERT was allowed")
    } catch (e) {
      if (isRlsError(e)) pass("1_sales_insert_inventory", `denied (${e.code || "RLS"})`)
      else fail("1_sales_insert_inventory", `unexpected: ${e.message}`)
    }

    // 2. sales UPDATE inventory_items -> denied (0 rows or error)
    try {
      const n = await asUser(sales.id, async (c) => {
        const r = await c.query(
          `UPDATE public.inventory_items SET location = 'Warehouse B' WHERE id = $1 RETURNING id`,
          [targetInv.id]
        )
        return r.rowCount
      })
      if (n === 0) pass("2_sales_update_inventory", "denied (0 rows)")
      else fail("2_sales_update_inventory", `updated ${n} row(s)`)
    } catch (e) {
      if (isRlsError(e)) pass("2_sales_update_inventory", `denied (${e.code || "RLS"})`)
      else fail("2_sales_update_inventory", `unexpected: ${e.message}`)
    }

    // 3. accounts INSERT inventory_items -> denied
    try {
      await asUser(accounts.id, async (c) => {
        await c.query(
          `INSERT INTO public.inventory_items (id, product_id, serial_number, status, date_added, location)
           VALUES ($1, $2, $3, 'In Stock', current_date::text, 'Warehouse A')`,
          [`inv-v047-acct-${stamp()}`, plForTechInsert.id, `V047-A-${stamp()}`]
        )
      })
      fail("3_accounts_insert_inventory", "INSERT was allowed")
    } catch (e) {
      if (isRlsError(e)) pass("3_accounts_insert_inventory", `denied (${e.code || "RLS"})`)
      else fail("3_accounts_insert_inventory", `unexpected: ${e.message}`)
    }

    // 4. technicians INSERT inventory_items -> allowed
    {
      const invId = `inv-v047-tech-ins-${stamp()}`
      const serial = `V047-T-${stamp()}`
      try {
        await asUser(techA.id, async (c) => {
          await c.query(
            `INSERT INTO public.inventory_items (id, product_id, serial_number, status, date_added, location)
             VALUES ($1, $2, $3, 'In Stock', current_date::text, 'Warehouse A')`,
            [invId, plForTechInsert.id, serial]
          )
        })
        cleanupIds.inventory.push(invId)
        const { rows } = await admin.query(`SELECT id FROM public.inventory_items WHERE id = $1`, [invId])
        if (rows[0]) pass("4_technicians_insert_inventory", `inserted ${invId}`)
        else fail("4_technicians_insert_inventory", "no row after insert")
      } catch (e) {
        fail("4_technicians_insert_inventory", e.message)
      }
    }

    // 5. sales INSERT transactions -> denied
    try {
      await asUser(sales.id, async (c) => {
        await c.query(
          `INSERT INTO public.transactions (id, type, serial_number, item_name, client, date, created_by)
           VALUES ($1, 'Sale', $2, 'X', 'Internal', $3, $4)`,
          [`txn-v047-sales-${stamp()}`, targetInv.serial, new Date().toISOString(), sales.id]
        )
      })
      fail("5_sales_insert_transactions", "INSERT was allowed")
    } catch (e) {
      if (isRlsError(e)) pass("5_sales_insert_transactions", `denied (${e.code || "RLS"})`)
      else fail("5_sales_insert_transactions", `unexpected: ${e.message}`)
    }

    // 6. technicians INSERT transactions created_by = self -> allowed
    let ownTxnId = `txn-v047-own-${stamp()}`
    try {
      await asUser(techA.id, async (c) => {
        await c.query(
          `INSERT INTO public.transactions (id, type, serial_number, item_name, client, date, created_by)
           VALUES ($1, 'Transfer', $2, 'Verify', 'Internal', $3, $4)`,
          [ownTxnId, targetInv.serial, new Date().toISOString(), techA.id]
        )
      })
      cleanupIds.transactions.push(ownTxnId)
      pass("6_technicians_insert_txn_self", `inserted ${ownTxnId}`)
    } catch (e) {
      ownTxnId = null
      fail("6_technicians_insert_txn_self", e.message)
    }

    // 7. technicians INSERT with created_by = someone else -> denied
    try {
      await asUser(techA.id, async (c) => {
        await c.query(
          `INSERT INTO public.transactions (id, type, serial_number, item_name, client, date, created_by)
           VALUES ($1, 'Transfer', $2, 'Verify', 'Internal', $3, $4)`,
          [`txn-v047-forge-${stamp()}`, targetInv.serial, new Date().toISOString(), techB.id]
        )
      })
      fail("7_technicians_insert_txn_forged", "forged created_by was allowed")
    } catch (e) {
      if (isRlsError(e)) pass("7_technicians_insert_txn_forged", `denied (${e.code || "RLS"})`)
      else fail("7_technicians_insert_txn_forged", `unexpected: ${e.message}`)
    }

    // 8. technicians INSERT created_by = NULL -> allowed
    {
      const nullTxnId = `txn-v047-nullcb-${stamp()}`
      try {
        await asUser(techA.id, async (c) => {
          await c.query(
            `INSERT INTO public.transactions (id, type, serial_number, item_name, client, date, created_by)
             VALUES ($1, 'Transfer', $2, 'Verify', 'Internal', $3, NULL)`,
            [nullTxnId, targetInv.serial, new Date().toISOString()]
          )
        })
        cleanupIds.transactions.push(nullTxnId)
        pass("8_technicians_insert_txn_null_created_by", `inserted ${nullTxnId}`)
      } catch (e) {
        fail("8_technicians_insert_txn_null_created_by", e.message)
      }
    }

    // =============================================================== UNDO
    console.log("\n=== Undo ===")

    // 9. technicians DELETE own transaction -> allowed
    if (ownTxnId) {
      try {
        const n = await asUser(techA.id, async (c) => {
          const r = await c.query(`DELETE FROM public.transactions WHERE id = $1 RETURNING id`, [ownTxnId])
          return r.rowCount
        })
        if (n === 1) {
          pass("9_technicians_delete_own", `deleted ${ownTxnId}`)
          cleanupIds.transactions = cleanupIds.transactions.filter((id) => id !== ownTxnId)
        } else fail("9_technicians_delete_own", `rowCount=${n}`)
      } catch (e) {
        fail("9_technicians_delete_own", e.message)
      }
    } else {
      fail("9_technicians_delete_own", "skipped dependency: check 6 failed")
    }

    // Create tech-b owned txn for 10/11
    const techBTxnId = `txn-v047-techb-${stamp()}`
    await asUser(techB.id, async (c) => {
      await c.query(
        `INSERT INTO public.transactions (id, type, serial_number, item_name, client, date, created_by)
         VALUES ($1, 'Transfer', $2, 'Verify', 'Internal', $3, $4)`,
        [techBTxnId, targetInv.serial, new Date().toISOString(), techB.id]
      )
    })
    cleanupIds.transactions.push(techBTxnId)

    // 10. technicians DELETE tech-b's txn -> denied (0 rows)
    try {
      const n = await asUser(techA.id, async (c) => {
        const r = await c.query(`DELETE FROM public.transactions WHERE id = $1 RETURNING id`, [techBTxnId])
        return r.rowCount
      })
      if (n === 0) pass("10_technicians_delete_other", "denied (0 rows)")
      else fail("10_technicians_delete_other", `deleted ${n} row(s)`)
    } catch (e) {
      if (isRlsError(e)) pass("10_technicians_delete_other", `denied (${e.code || "RLS"})`)
      else fail("10_technicians_delete_other", `unexpected: ${e.message}`)
    }

    // 11. technicians UPDATE tech-b's txn -> denied (0 rows)
    try {
      const n = await asUser(techA.id, async (c) => {
        const r = await c.query(
          `UPDATE public.transactions SET notes = 'tamper' WHERE id = $1 RETURNING id`,
          [techBTxnId]
        )
        return r.rowCount
      })
      if (n === 0) pass("11_technicians_update_other", "denied (0 rows)")
      else fail("11_technicians_update_other", `updated ${n} row(s)`)
    } catch (e) {
      if (isRlsError(e)) pass("11_technicians_update_other", `denied (${e.code || "RLS"})`)
      else fail("11_technicians_update_other", `unexpected: ${e.message}`)
    }

    // 12. admin DELETE any transaction -> allowed
    try {
      const n = await asUser(adminUser.id, async (c) => {
        const r = await c.query(`DELETE FROM public.transactions WHERE id = $1 RETURNING id`, [techBTxnId])
        return r.rowCount
      })
      if (n === 1) {
        pass("12_admin_delete_any", `deleted ${techBTxnId}`)
        cleanupIds.transactions = cleanupIds.transactions.filter((id) => id !== techBTxnId)
      } else fail("12_admin_delete_any", `rowCount=${n}`)
    } catch (e) {
      fail("12_admin_delete_any", e.message)
    }

    // ============================================================== READS
    console.log("\n=== Reads (regression) ===")

    // 13. sales SELECT inventory_items
    try {
      const n = await asUser(sales.id, async (c) => {
        const r = await c.query(`SELECT count(*)::int AS n FROM public.inventory_items`)
        return r.rows[0].n
      })
      if (n > 0) pass("13_sales_select_inventory", `saw ${n} rows`)
      else fail("13_sales_select_inventory", "0 rows visible")
    } catch (e) {
      fail("13_sales_select_inventory", e.message)
    }

    // 14. sales SELECT transactions
    try {
      const n = await asUser(sales.id, async (c) => {
        const r = await c.query(`SELECT count(*)::int AS n FROM public.transactions`)
        return r.rows[0].n
      })
      if (n > 0) pass("14_sales_select_transactions", `saw ${n} rows`)
      else fail("14_sales_select_transactions", "0 rows visible")
    } catch (e) {
      fail("14_sales_select_transactions", e.message)
    }

    // 15. accounts SELECT inventory + transactions
    try {
      const { nInv, nTxn } = await asUser(accounts.id, async (c) => {
        const a = await c.query(`SELECT count(*)::int AS n FROM public.inventory_items`)
        const b = await c.query(`SELECT count(*)::int AS n FROM public.transactions`)
        return { nInv: a.rows[0].n, nTxn: b.rows[0].n }
      })
      if (nInv > 0 && nTxn > 0) pass("15_accounts_select_inventory_and_transactions", `inv=${nInv} txn=${nTxn}`)
      else fail("15_accounts_select_inventory_and_transactions", `inv=${nInv} txn=${nTxn}`)
    } catch (e) {
      fail("15_accounts_select_inventory_and_transactions", e.message)
    }

    // ======================================================= LEAK CLOSURE
    console.log("\n=== Leak closure ===")

    const { rows: providerCountAdmin } = await admin.query(
      `SELECT count(*)::int AS n FROM public.remediation_providers`
    )
    const providerTotal = providerCountAdmin[0].n

    // 16. norole SELECT remediation_providers -> denied
    try {
      const n = await asUser(norole.id, async (c) => {
        const r = await c.query(`SELECT count(*)::int AS n FROM public.remediation_providers`)
        return r.rows[0].n
      })
      if (providerTotal > 0 && n === 0) pass("16_norole_select_remediation_providers", "denied (0 rows)")
      else if (providerTotal === 0) fail("16_norole_select_remediation_providers", "no providers to assert against")
      else fail("16_norole_select_remediation_providers", `saw ${n} of ${providerTotal}`)
    } catch (e) {
      if (isRlsError(e)) pass("16_norole_select_remediation_providers", `denied (${e.code || "RLS"})`)
      else fail("16_norole_select_remediation_providers", e.message)
    }

    // 17. inactive sales SELECT remediation_providers -> denied
    try {
      const n = await asUser(inactiveSales.id, async (c) => {
        const r = await c.query(`SELECT count(*)::int AS n FROM public.remediation_providers`)
        return r.rows[0].n
      })
      if (providerTotal > 0 && n === 0) pass("17_inactive_sales_select_remediation_providers", "denied (0 rows)")
      else if (providerTotal === 0) fail("17_inactive_sales_select_remediation_providers", "no providers to assert against")
      else fail("17_inactive_sales_select_remediation_providers", `saw ${n} of ${providerTotal}`)
    } catch (e) {
      if (isRlsError(e)) pass("17_inactive_sales_select_remediation_providers", `denied (${e.code || "RLS"})`)
      else fail("17_inactive_sales_select_remediation_providers", e.message)
    }

    // =================================================== OUTBOUND BATCHES
    console.log("\n=== Outbound batches ===")
    const { rows: obExists } = await admin.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'outbound_batches'
      ) AS exists
    `)
    if (!obExists[0].exists) {
      skip("18_sales_insert_outbound_batches", "outbound_batches table does not exist")
      skip("19_technicians_insert_outbound_batches", "outbound_batches table does not exist")
    } else {
      // 18. sales INSERT outbound_batches -> denied
      try {
        await asUser(sales.id, async (c) => {
          await c.query(
            `INSERT INTO public.outbound_batches (id, type, client, start_date, status, created_at)
             VALUES ($1, 'POC Out', 'Internal', current_date::text, 'open', $2)`,
            [`ob-v047-sales-${stamp()}`, new Date().toISOString()]
          )
        })
        fail("18_sales_insert_outbound_batches", "INSERT was allowed")
      } catch (e) {
        if (isRlsError(e)) pass("18_sales_insert_outbound_batches", `denied (${e.code || "RLS"})`)
        else fail("18_sales_insert_outbound_batches", `unexpected: ${e.message}`)
      }

      // 19. technicians INSERT outbound_batches -> allowed
      {
        const obId = `ob-v047-tech-${stamp()}`
        try {
          await asUser(techA.id, async (c) => {
            await c.query(
              `INSERT INTO public.outbound_batches (id, type, client, start_date, status, created_at)
               VALUES ($1, 'POC Out', 'Internal', current_date::text, 'open', $2)`,
              [obId, new Date().toISOString()]
            )
          })
          cleanupIds.outbound.push(obId)
          const { rows } = await admin.query(`SELECT id FROM public.outbound_batches WHERE id = $1`, [obId])
          if (rows[0]) pass("19_technicians_insert_outbound_batches", `inserted ${obId}`)
          else fail("19_technicians_insert_outbound_batches", "no row after insert")
        } catch (e) {
          fail("19_technicians_insert_outbound_batches", e.message)
        }
      }
    }

    // =========================================================== RPC SURFACE
    console.log("\n=== RPC surface ===")

    // 20. exactly one overload (text, jsonb, jsonb, text)
    {
      const { rows } = await admin.query(`
        SELECT p.oid::regprocedure::text AS signature
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'reverse_quick_scan_batch'
        ORDER BY 1
      `)
      const sigs = rows.map((r) => r.signature)
      const expected = "reverse_quick_scan_batch(text,text,text,jsonb)"
      const normalized = sigs.map((s) => s.replace(/\s+/g, ""))
      if (sigs.length === 1 && normalized[0] === expected) {
        pass("20_rpc_single_overload", sigs[0])
      } else {
        fail("20_rpc_single_overload", `got [${sigs.join(", ")}]`)
      }
    }

    const shortReason = "too short"
    const goodReason = "  Verify 047 disposable batch reversal reason  "

    async function callReverse(client, batchId, reason) {
      const r = await client.query(
        `SELECT public.reverse_quick_scan_batch($1::text, $2::text, $3::text, '[]'::jsonb) AS payload`,
        [batchId, reason, "Warehouse A"]
      )
      return r.rows[0].payload
    }

    // 21. technicians -> forbidden
    {
      const disposable = await buildDisposableSaleBatch("c21")
      try {
        await asUser(techA.id, async (c) => {
          await callReverse(c, disposable.batchId, goodReason)
        })
        fail("21_technicians_rpc_forbidden", "call succeeded")
      } catch (e) {
        if (/reverse_quick_scan_batch:\s*forbidden/i.test(e.message)) {
          pass("21_technicians_rpc_forbidden", "raised forbidden")
        } else fail("21_technicians_rpc_forbidden", e.message)
      }
    }

    // 22. sales -> forbidden
    {
      const disposable = await buildDisposableSaleBatch("c22")
      try {
        await asUser(sales.id, async (c) => {
          await callReverse(c, disposable.batchId, goodReason)
        })
        fail("22_sales_rpc_forbidden", "call succeeded")
      } catch (e) {
        if (/forbidden/i.test(e.message)) pass("22_sales_rpc_forbidden", "raised forbidden")
        else fail("22_sales_rpc_forbidden", e.message)
      }
    }

    // 23. admin short reason -> reason guard
    {
      const disposable = await buildDisposableSaleBatch("c23")
      try {
        await asUser(adminUser.id, async (c) => {
          await callReverse(c, disposable.batchId, shortReason)
        })
        fail("23_admin_rpc_short_reason", "call succeeded with short reason")
      } catch (e) {
        if (/reason must be at least/i.test(e.message)) {
          pass("23_admin_rpc_short_reason", "raised reason guard")
        } else fail("23_admin_rpc_short_reason", e.message)
      }
    }

    // 24. admin success + batch_reversals audit row
    {
      const disposable = await buildDisposableSaleBatch("c24")
      try {
        const payload = await asUser(adminUser.id, async (c) =>
          callReverse(c, disposable.batchId, goodReason)
        )
        if (!payload?.ok) {
          fail(
            "24_admin_rpc_success_and_audit",
            `ok:false ${JSON.stringify({ error: payload?.error, failed_details: payload?.failed_details })}`
          )
          console.log("failed_details:", JSON.stringify(payload?.failed_details, null, 2))
        } else {
          const { rows } = await admin.query(
            `SELECT batch_id, reversal_reason, reversed_by
             FROM public.batch_reversals WHERE batch_id = $1`,
            [disposable.batchId]
          )
          const row = rows[0]
          const trimmed = goodReason.trim()
          if (
            row &&
            row.reversal_reason === trimmed &&
            row.reversed_by === adminUser.id
          ) {
            pass("24_admin_rpc_success_and_audit", `ok:true audit reason="${trimmed}" by=${row.reversed_by}`)
          } else {
            fail(
              "24_admin_rpc_success_and_audit",
              `rpc ok but audit mismatch: ${JSON.stringify(row)}`
            )
          }
          // inventory should be reverted
          const { rows: inv } = await admin.query(
            `SELECT status, location FROM public.inventory_items WHERE id = $1`,
            [disposable.invId]
          )
          if (inv[0]?.status !== "In Stock") {
            console.warn(`  note: inventory status after reverse = ${inv[0]?.status}`)
          }
        }
      } catch (e) {
        fail("24_admin_rpc_success_and_audit", e.message)
      }
    }

    // 25. Atomicity: success then ROLLBACK → neither inventory nor batch_reversals persist
    {
      const disposable = await buildDisposableSaleBatch("c25")
      try {
        const payload = await asUserRollback(adminUser.id, async (c) =>
          callReverse(c, disposable.batchId, goodReason)
        )
        if (!payload?.ok) {
          fail(
            "25_rpc_atomicity_rollback",
            `rpc returned ok:false inside txn (cannot test rollback): ${JSON.stringify({
              error: payload?.error,
              failed_details: payload?.failed_details,
            })}`
          )
          console.log("failed_details:", JSON.stringify(payload?.failed_details, null, 2))
        } else {
          const { rows: inv } = await admin.query(
            `SELECT status FROM public.inventory_items WHERE id = $1`,
            [disposable.invId]
          )
          const { rows: br } = await admin.query(
            `SELECT batch_id FROM public.batch_reversals WHERE batch_id = $1`,
            [disposable.batchId]
          )
          const { rows: txn } = await admin.query(
            `SELECT count(*)::int AS n FROM public.transactions WHERE batch_id = $1`,
            [disposable.batchId]
          )
          const stillSold = inv[0]?.status === "Sold"
          const noAudit = br.length === 0
          const batchTxnIntact = txn[0].n === 1
          if (stillSold && noAudit && batchTxnIntact) {
            pass(
              "25_rpc_atomicity_rollback",
              "after ROLLBACK: inventory still Sold, no batch_reversals, original txn intact"
            )
          } else {
            fail(
              "25_rpc_atomicity_rollback",
              `stillSold=${stillSold} noAudit=${noAudit} batchTxnIntact=${batchTxnIntact} status=${inv[0]?.status}`
            )
          }
        }
      } catch (e) {
        fail("25_rpc_atomicity_rollback", e.message)
      }
    }
  } finally {
    console.log("\n=== Cleanup ===")
    try {
      for (const id of cleanupIds.outbound) {
        await admin.query(`DELETE FROM public.outbound_batches WHERE id = $1`, [id]).catch(() => {})
      }
      for (const id of cleanupIds.transactions) {
        await admin.query(`DELETE FROM public.transactions WHERE reverses_transaction_id = $1`, [id]).catch(() => {})
      }
      for (const batchId of cleanupIds.batches) {
        await admin.query(
          `DELETE FROM public.transactions WHERE metadata->>'reversedBatchId' = $1`,
          [batchId]
        ).catch(() => {})
        await admin.query(`DELETE FROM public.batch_reversals WHERE batch_id = $1`, [batchId]).catch(() => {})
      }
      for (const id of cleanupIds.transactions) {
        await admin.query(`DELETE FROM public.transactions WHERE id = $1`, [id]).catch(() => {})
      }
      for (const batchId of cleanupIds.batches) {
        await admin.query(`DELETE FROM public.transactions WHERE batch_id = $1`, [batchId]).catch(() => {})
      }
      for (const id of cleanupIds.inventory) {
        await admin.query(`DELETE FROM public.inventory_items WHERE id = $1`, [id]).catch(() => {})
      }
      for (const id of cleanupIds.productLines) {
        await admin.query(`DELETE FROM public.product_lines WHERE id = $1`, [id]).catch(() => {})
      }
      for (const id of cleanupIds.remediationProviders) {
        await admin.query(`DELETE FROM public.remediation_providers WHERE id = $1`, [id]).catch(() => {})
      }

      // Delete fixture auth users (cascades profiles)
      const ids = [...new Set(fixtureUserIds)]
      for (const id of ids) {
        const { error } = await supabaseAdmin.auth.admin.deleteUser(id)
        if (error) console.warn(`deleteUser(${id}): ${error.message}`)
      }
      // Sweep any remaining verify-047 emails
      await deleteFixtureUsersByEmail()
    } catch (e) {
      console.warn("Cleanup error:", e.message)
    }
    await admin.end().catch(() => {})
  }

  console.log("\n========== VERIFY 047 SUMMARY ==========")
  console.log(JSON.stringify(results, null, 2))
  console.log("========================================")

  const failed = Object.values(results).filter((r) => r.result === "FAIL")
  if (failed.length > 0) {
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
