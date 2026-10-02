/**
 * Verify 061_transaction_business_dates.sql. This script does not apply the migration.
 *
 * When created_at is missing it fails the schema checks and does not rewrite live dates.
 * Fixtures use the txn-verify-061- id prefix and are removed in finally.
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL is unused; the script uses the database URL only.
 *   SUPABASE_DB_URL (or DATABASE_URL)
 *
 * Usage: node scripts/verify-061-transaction-dates.mjs
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"
import { createClient } from "@supabase/supabase-js"
import {
  businessDateToIso,
  compareBusinessDatesDesc,
  formatBusinessDate,
  formatRecordedAt,
  todayBusinessDate,
} from "../lib/business-date.mjs"

const require = createRequire(import.meta.url)
const PREFIX = "txn-verify-061-"
const LATE_UTC = "2026-09-16T22:30:00.000Z"

function loadEnvLocal() {
  const envPath = path.join(process.cwd(), ".env.local")
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value
  }
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if ([".git", ".next", "node_modules", "supabase"].includes(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(?:ts|tsx|mjs)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) out.push(full)
  }
  return out
}

async function main() {
  loadEnvLocal()
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
  if (!dbUrl) throw new Error("Missing SUPABASE_DB_URL or DATABASE_URL")

  const pg = require("pg")
  const db = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
  await db.connect()
  const service = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const results = {}
  const adminEmail = "verify-061-admin@test.local"
  let adminId = null

  function pass(name, reason) {
    results[name] = { result: "PASS", reason }
    console.log(`PASS  ${name} — ${reason}`)
  }
  function fail(name, reason) {
    results[name] = { result: "FAIL", reason }
    console.log(`FAIL  ${name} — ${reason}`)
  }

  async function cleanup() {
    await db.query(`DELETE FROM public.batch_reversals WHERE batch_id LIKE 'verify-061-%'`)
    await db.query(
      `DELETE FROM public.transactions
       WHERE id LIKE $1 OR serial_number LIKE $1 OR batch_id LIKE 'verify-061-%'`,
      [`${PREFIX}%`]
    )
    await db.query(
      `DELETE FROM public.inventory_items WHERE id LIKE $1 OR serial_number LIKE $1`,
      [`${PREFIX}%`]
    )
    const users = await db.query(`SELECT id::text AS id FROM auth.users WHERE email = $1`, [adminEmail])
    for (const row of users.rows) {
      const { error } = await service.auth.admin.deleteUser(row.id)
      if (error && !/not found/i.test(error.message)) throw error
    }
  }

  try {
    await cleanup()
    const column = await db.query(
      `SELECT column_default, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'transactions' AND column_name = 'created_at'`
    )
    const constraint = await db.query(
      `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
       WHERE conrelid = 'public.transactions'::regclass
         AND conname = 'transactions_date_iso_utc'`
    )
    const settings = await db.query(`SELECT timezone FROM public.app_settings WHERE id`)
    const timeZone = settings.rows[0]?.timezone
    const createdAt = column.rows[0]
    const constraintDef = constraint.rows[0]?.def ?? ""
    const schemaOk =
      createdAt &&
      createdAt.is_nullable === "YES" &&
      /now\(\)/i.test(createdAt.column_default ?? "") &&
      constraintDef.includes("date ~") &&
      constraintDef.includes("2020") &&
      timeZone === "Africa/Harare"

    if (!schemaOk) {
      fail(
        "1_created_at_and_midnight_dates",
        createdAt
          ? `schema present but not ready (${JSON.stringify({ createdAt, constraintDef, timeZone })})`
          : "created_at is missing; apply 061 before this verifier"
      )
      fail("2_backfill_counts", "skipped; migration not applied")
      fail("3_late_utc_business_date", "skipped; migration not applied")
      fail("4_new_movement_write", "skipped; migration not applied")
    } else {
      const { data: created, error: createError } = await service.auth.admin.createUser({
        email: adminEmail,
        email_confirm: true,
      })
      if (createError) throw new Error(`createUser: ${createError.message}`)
      adminId = created.user.id
      const updated = await db.query(
        `UPDATE public.profiles SET role = 'admin'::public.app_role, active = true WHERE id = $1`,
        [adminId]
      )
      if (updated.rowCount !== 1) throw new Error("admin profile was not updated")

      const midnight = await db.query(
        `SELECT count(*)::int AS bad
         FROM public.transactions
         WHERE id NOT LIKE $1
           AND substring(date FROM 12 FOR 12) <> '00:00:00.000'`,
        [`${PREFIX}%`]
      )
      const index = await db.query(
        `SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public' AND indexname = 'idx_transactions_created_at'`
      )
      if (midnight.rows[0].bad === 0 && index.rowCount === 1) {
        pass(
          "1_created_at_and_midnight_dates",
          "created_at nullable default now(); every date is midnight; transactions_date_iso_utc intact; index present"
        )
      } else {
        fail(
          "1_created_at_and_midnight_dates",
          JSON.stringify({ nonMidnight: midnight.rows[0].bad, index: index.rowCount, constraintDef })
        )
      }

      const counts = await db.query(
        `SELECT
           count(*) FILTER (WHERE t.created_at IS NOT NULL)::int AS non_null,
           count(*) FILTER (
             WHERE EXISTS (
               SELECT 1 FROM public.outbound_batches b
               WHERE b.id = t.batch_id AND b.created_at ~ '^\\d{4}-\\d{2}-\\d{2}T'
             )
           )::int AS outbound_matched,
           count(*) FILTER (
             WHERE EXISTS (SELECT 1 FROM public.batch_reversals r WHERE r.batch_id = t.batch_id)
               AND NOT EXISTS (SELECT 1 FROM public.outbound_batches b WHERE b.id = t.batch_id)
           )::int AS reversal_only,
           count(*) FILTER (
             WHERE t.created_at IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM public.outbound_batches b WHERE b.id = t.batch_id)
               AND NOT EXISTS (SELECT 1 FROM public.batch_reversals r WHERE r.batch_id = t.batch_id)
           )::int AS from_timed_date,
           count(*) FILTER (
             WHERE EXISTS (
               SELECT 1 FROM public.outbound_batches b
               WHERE b.id = t.batch_id
                 AND t.created_at IS DISTINCT FROM b.created_at::timestamptz
             )
           )::int AS outbound_mismatch
         FROM public.transactions t
         WHERE t.id NOT LIKE $1`,
        [`${PREFIX}%`]
      )
      const tally = counts.rows[0]
      const expected = tally.outbound_matched + tally.reversal_only + tally.from_timed_date

      const outbound = await db.query(
        `SELECT t.id, t.date, t.created_at, b.created_at AS batch_created_at
         FROM public.transactions t
         JOIN public.outbound_batches b ON b.id = t.batch_id
         WHERE t.id NOT LIKE $1
         ORDER BY t.id
         LIMIT 1`,
        [`${PREFIX}%`]
      )
      const timed = await db.query(
        `SELECT t.id, t.date, t.created_at
         FROM public.transactions t
         WHERE t.id NOT LIKE $1
           AND t.created_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM public.outbound_batches b WHERE b.id = t.batch_id)
           AND NOT EXISTS (SELECT 1 FROM public.batch_reversals r WHERE r.batch_id = t.batch_id)
         ORDER BY t.id
         LIMIT 1`,
        [`${PREFIX}%`]
      )
      const legacy = await db.query(
        `SELECT t.id, t.date, t.created_at
         FROM public.transactions t
         WHERE t.id NOT LIKE $1 AND t.created_at IS NULL
         ORDER BY t.id
         LIMIT 1`,
        [`${PREFIX}%`]
      )
      const samples = {
        outbound: outbound.rows[0] ?? null,
        timed: timed.rows[0] ?? null,
        legacy: legacy.rows[0] ?? null,
      }
      console.log("SPOT  captured before assertions", JSON.stringify(samples))

      const outboundOk =
        samples.outbound &&
        new Date(samples.outbound.created_at).getTime() === new Date(samples.outbound.batch_created_at).getTime() &&
        String(samples.outbound.date).endsWith("T00:00:00.000Z")
      const timedBusiness = samples.timed
        ? businessDateToIso(todayBusinessDate(timeZone, new Date(samples.timed.created_at)))
        : null
      const timedOk = samples.timed && samples.timed.date === timedBusiness
      const legacyOk =
        samples.legacy &&
        samples.legacy.created_at == null &&
        String(samples.legacy.date).endsWith("T00:00:00.000Z")

      if (tally.non_null === expected && tally.outbound_mismatch === 0 && outboundOk && timedOk && legacyOk) {
        pass(
          "2_backfill_counts",
          JSON.stringify({ ...tally, expected, samples })
        )
      } else {
        fail(
          "2_backfill_counts",
          JSON.stringify({ ...tally, expected, outboundOk, timedOk, timedBusiness, legacyOk, samples })
        )
      }

      const lateId = `${PREFIX}late`
      await db.query(
        `INSERT INTO public.transactions (
           id, type, serial_number, item_name, client, date, created_at
         ) VALUES ($1, 'Sale', $2, 'verify-061 late utc', 'Internal', $3, $4::timestamptz)`,
        [lateId, `${PREFIX}serial-late`, LATE_UTC, LATE_UTC]
      )
      await db.query(
        `UPDATE public.transactions AS txn
         SET date = to_char((txn.date::timestamptz) AT TIME ZONE settings.timezone, 'YYYY-MM-DD')
                    || 'T00:00:00.000Z'
         FROM public.app_settings AS settings
         WHERE settings.id AND txn.id = $1`,
        [lateId]
      )
      const late = await db.query(
        `SELECT date, created_at FROM public.transactions WHERE id = $1`,
        [lateId]
      )
      const expectedLate = businessDateToIso(todayBusinessDate("Africa/Harare", new Date(LATE_UTC)))
      const lateRow = late.rows[0]
      if (
        expectedLate === "2026-09-17T00:00:00.000Z" &&
        lateRow?.date === expectedLate &&
        new Date(lateRow.created_at).getTime() === new Date(LATE_UTC).getTime()
      ) {
        pass("3_late_utc_business_date", `${LATE_UTC} → ${lateRow.date}; created_at kept`)
      } else {
        fail("3_late_utc_business_date", JSON.stringify({ expectedLate, lateRow }))
      }

      const movementFns = await db.query(
        `SELECT p.proname, pg_get_functiondef(p.oid) AS def
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('apply_stock_movement', 'reverse_quick_scan_batch')`
      )
      const movementOmitsCreatedAt = movementFns.rows.every((row) => {
        const columnList = row.def.match(/INSERT INTO public\.transactions\s*\(([\s\S]*?)\)\s*SELECT/i)?.[1] ?? ""
        return /\bdate\b/.test(columnList) && !/\bcreated_at\b/.test(columnList)
      })
      const today = businessDateToIso(todayBusinessDate(timeZone))
      const writeId = `${PREFIX}write`
      const before = Date.now()
      await db.query(
        `INSERT INTO public.transactions (
           id, type, serial_number, item_name, client, date, client_id, invoice_number, notes,
           from_location, to_location, assigned_to, disposal_reason, authorised_by, batch_id,
           delivery_note_url, metadata, created_by
         ) VALUES (
           $1, 'Inbound', $2, 'verify-061 movement', 'Internal', $3,
           NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
         )`,
        [writeId, `${PREFIX}serial-write`, today]
      )
      const written = await db.query(
        `SELECT date, created_at FROM public.transactions WHERE id = $1`,
        [writeId]
      )
      const writtenAt = new Date(written.rows[0]?.created_at).getTime()
      const recordedSkewMs = writtenAt - Date.now()
      const writeOk =
        movementOmitsCreatedAt &&
        written.rows[0]?.date === today &&
        writtenAt >= before - 300_000 &&
        recordedSkewMs <= 300_000
      if (writeOk) {
        pass(
          "4_new_movement_write",
          `date ${written.rows[0].date}; created_at ${written.rows[0].created_at}; skew ${recordedSkewMs}ms; movement inserts omit created_at`
        )
      } else {
        fail(
          "4_new_movement_write",
          JSON.stringify({
            movementOmitsCreatedAt,
            functions: movementFns.rows.map((row) => row.proname),
            today,
            recordedSkewMs,
            written: written.rows[0] ?? null,
          })
        )
      }
    }

    const business = formatBusinessDate("2026-09-16T00:00:00.000Z")
    const businessBare = formatBusinessDate("2026-09-16")
    const catClock = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Harare",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date("2026-09-16T00:00:00.000Z"))
    const utcClock = new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date("2026-09-16T00:00:00.000Z"))
    const recorded = formatRecordedAt("2026-09-16T10:00:00.000Z", "2026-09-16", "Africa/Harare")
    const residuePatterns = [
      /new Date\(\s*(?:entry|txn|tx|t|b|a|row|viewingBatch)\.date\s*\)/,
      /new Date\(\s*[A-Za-z.]*dateOut\s*\)/,
      /formatDateDDMMYYYY\(\s*(?:txn|entry|t|row|selectedTransaction|selectedConsignment)\.date\s*\)/,
      /formatTxnDate\s*\(/,
    ]
    const hits = []
    for (const file of walk(process.cwd())) {
      if (file.endsWith(`${path.sep}scripts${path.sep}verify-061-transaction-dates.mjs`)) continue
      const text = fs.readFileSync(file, "utf8")
      for (const pattern of residuePatterns) {
        if (pattern.test(text)) hits.push(`${path.relative(process.cwd(), file)} ${pattern}`)
      }
    }
    if (
      business === "16/09/2026" &&
      businessBare === "16/09/2026" &&
      !business.includes("02:00") &&
      catClock.replace(/\s/g, "").startsWith("02:00") &&
      utcClock.replace(/\s/g, "").startsWith("00:00") &&
      recorded === "12:00" &&
      formatRecordedAt(null, "2026-09-16", "Africa/Harare") === "" &&
      hits.length === 0
    ) {
      pass(
        "5_display_helpers",
        `16/09/2026 in both zones (a Date conversion would show CAT ${catClock} and UTC ${utcClock}); recorded 10:00Z is 12:00 in Africa/Harare`
      )
    } else {
      fail(
        "5_display_helpers",
        JSON.stringify({ business, businessBare, catClock, utcClock, recorded, hits })
      )
    }

    if (!schemaOk) {
      fail("6_reversal_pairing_and_order", "skipped; migration not applied")
    } else {
      const earlyId = `${PREFIX}order-early`
      const laterId = `${PREFIX}order-late`
      const reversalId = `${PREFIX}reversal`
      await db.query(
        `INSERT INTO public.transactions (
           id, type, serial_number, item_name, client, date, batch_id, created_at
         ) VALUES
           ($1, 'Sale', $4, 'verify-061 order', 'Internal', '2026-01-02T00:00:00.000Z', 'verify-061-orig', '2026-01-02T18:00:00.000Z'),
           ($2, 'Inbound', $5, 'verify-061 order', 'Internal', '2026-01-03T00:00:00.000Z', 'verify-061-later', '2026-01-03T01:00:00.000Z'),
           ($3, 'Reversal', '(batch)', 'verify-061 order', 'Internal', '2026-01-04T00:00:00.000Z', 'verify-061-rev', '2026-01-04T08:00:00.000Z')`,
        [earlyId, laterId, reversalId, `${PREFIX}serial-early`, `${PREFIX}serial-late-order`]
      )
      await db.query(
        `UPDATE public.transactions
         SET metadata = jsonb_build_object('reversedBatchId', 'verify-061-orig', 'originalMovementType', 'Sale')
         WHERE id = $1`,
        [reversalId]
      )
      const ordered = await db.query(
        `SELECT id FROM public.transactions
         WHERE id = ANY($1::text[])
         ORDER BY date DESC`,
        [[earlyId, laterId, reversalId]]
      )
      const liveReversal = await db.query(
        `SELECT id, date, metadata->>'reversedBatchId' AS reversed_batch
         FROM public.transactions
         WHERE type = 'Reversal' AND id NOT LIKE $1
           AND metadata->>'reversedBatchId' IS NOT NULL
         LIMIT 1`,
        [`${PREFIX}%`]
      )
      const historySource = fs.readFileSync(path.join(process.cwd(), "lib", "transaction-batches.ts"), "utf8")
      const ordersByDate =
        historySource.includes("compareBusinessDatesDesc") &&
        !/sort\(\(a, b\) =>[\s\S]{0,120}createdAt/.test(historySource)
      const reversalSource = fs.readFileSync(
        path.join(process.cwd(), "lib", "quick-scan-reversal-inventory.ts"),
        "utf8"
      )
      const clientUsesServerRestore =
        reversalSource.includes("p_reason") &&
        reversalSource.includes("p_confirmed") &&
        !reversalSource.includes("p_entries")

      const trigger = await db.query(
        `SELECT pg_get_triggerdef(oid) AS def
         FROM pg_trigger
         WHERE tgrelid = 'public.transactions'::regclass
           AND tgname = 'tr_transactions_guard_quick_scan_reversal_order'
           AND NOT tgisinternal`
      )
      let sameDayNullBlocked = false
      let sameDayNullReason = ""
      let legitimateReversal = null
      let nullOriginalReversal = null
      const product = await db.query(
        `SELECT id FROM public.product_lines ORDER BY id LIMIT 1`
      )
      const admin = { rows: [{ id: adminId }] }
      const reversalFunction = await db.query(
        `SELECT pg_get_functiondef(p.oid) AS def
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'reverse_quick_scan_batch'`
      )
      const reversalDef = reversalFunction.rows[0]?.def ?? ""
      const guardDef = await db.query(
        `SELECT pg_get_functiondef(p.oid) AS def
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'guard_quick_scan_reversal_order'`
      )
      const guardSource = guardDef.rows[0]?.def ?? ""
      const keepsHistory =
        reversalDef.includes("reverses_transaction_id") &&
        !reversalDef.includes("DELETE FROM public.transactions")
      const orderGuardInFunction = reversalDef.includes("blocked by later batch")
      const deleteGuardGone = trigger.rowCount === 0 && guardSource === ""

      async function runRealReversal({
        name,
        originalCreatedAt,
        laterCreatedAt,
      }) {
        const batchId = `verify-061-${name}-batch`
        const serial = `${PREFIX}serial-${name}`
        const inventoryId = `${PREFIX}inventory-${name}`
        const originalId = `${PREFIX}original-${name}`
        const laterId = laterCreatedAt === undefined ? null : `${PREFIX}later-${name}`
        await db.query("BEGIN")
        try {
          await db.query(
            `INSERT INTO public.inventory_items (
               id, product_id, serial_number, status, date_added, location
             ) VALUES ($1, $2, $3, 'In Stock', '2026-09-16', 'Warehouse A')`,
            [inventoryId, product.rows[0].id, serial]
          )
          await db.query(
            `INSERT INTO public.transactions (
               id, type, serial_number, item_name, client, date, batch_id, created_at
             ) VALUES (
               $1, 'Inbound', $2, 'verify-061 reversal', 'Internal',
               '2026-09-16T00:00:00.000Z', $3, $4::timestamptz
             )`,
            [originalId, serial, batchId, originalCreatedAt]
          )
          if (laterId) {
            await db.query(
              `INSERT INTO public.transactions (
                 id, type, serial_number, item_name, client, date, batch_id,
                 from_location, to_location, created_at
               ) VALUES (
                 $1, 'Transfer', $2, 'verify-061 reversal', 'Internal',
                 '2026-09-16T00:00:00.000Z', $3, 'Warehouse A', 'Warehouse B', $4::timestamptz
               )`,
              [laterId, serial, `verify-061-${name}-later`, laterCreatedAt]
            )
          }
          await db.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [admin.rows[0].id])
          await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
            JSON.stringify({ sub: admin.rows[0].id, role: "authenticated" }),
          ])
          await db.query("SET LOCAL ROLE authenticated")
          const reversed = await db.query(
            `SELECT public.reverse_quick_scan_batch($1, $2, $3, '[]'::jsonb) AS result`,
            [batchId, "verify 061 legitimate reversal path", "Warehouse A"]
          )
          const body = reversed.rows[0]?.result ?? {}
          await db.query("RESET ROLE")
          const after = await db.query(
            `SELECT
               (SELECT status FROM public.inventory_items WHERE id = $1) AS status,
               (SELECT deleted_at IS NOT NULL FROM public.inventory_items WHERE id = $1) AS removed,
               (SELECT count(*)::int FROM public.transactions WHERE id = $2) AS original_left,
               (SELECT count(*)::int FROM public.transactions WHERE reverses_transaction_id = $2) AS linked,
               (SELECT count(*)::int FROM public.batch_reversals WHERE batch_id = $3) AS audit_rows`,
            [inventoryId, originalId, batchId]
          )
          return { body, after: after.rows[0] }
        } catch (error) {
          return { error: error.message }
        } finally {
          await db.query("ROLLBACK")
        }
      }

      if (product.rows[0]?.id && admin.rows[0]?.id) {
        const blocked = await runRealReversal({
          name: "blocked",
          originalCreatedAt: "2026-09-16T10:00:00.000Z",
          laterCreatedAt: "2026-09-16T18:00:00.000Z",
        })
        sameDayNullReason = blocked.error ?? JSON.stringify(blocked.body ?? null)
        sameDayNullBlocked = /blocked by later batch/i.test(sameDayNullReason)
        legitimateReversal = await runRealReversal({
          name: "clean",
          originalCreatedAt: "2026-09-16T10:00:00.000Z",
        })
        nullOriginalReversal = await runRealReversal({
          name: "null-original",
          originalCreatedAt: null,
        })
      }

      function reversalCompleted(result) {
        return Boolean(
          result &&
            !result.error &&
            result.body?.ok === true &&
            result.after?.removed === true &&
            result.after?.original_left === 1 &&
            result.after?.linked === 1 &&
            result.after?.audit_rows === 1
        )
      }
      const ids = ordered.rows.map((row) => row.id)
      const helperOrder = ["2026-01-02", "2026-01-04", "2026-01-03"].sort((a, b) =>
        compareBusinessDatesDesc(a, b)
      )
      const live = liveReversal.rows[0]
      if (
        ids[0] === reversalId &&
        ids[1] === laterId &&
        ids[2] === earlyId &&
        helperOrder[0] === "2026-01-04" &&
        ordersByDate &&
        clientUsesServerRestore &&
        keepsHistory &&
        orderGuardInFunction &&
        deleteGuardGone &&
        sameDayNullBlocked &&
        reversalCompleted(legitimateReversal) &&
        reversalCompleted(nullOriginalReversal) &&
        live?.reversed_batch &&
        String(live.date).endsWith("T00:00:00.000Z")
      ) {
        pass(
          "6_reversal_pairing_and_order",
          `fixture order ${ids.join(" > ")}; live reversal ${live.id} still points at ${live.reversed_batch}; reversal keeps the original and links a Reversal row; a later batch blocks; clean reversal and NULL-created_at original both completed`
        )
      } else {
        fail(
          "6_reversal_pairing_and_order",
          JSON.stringify({
            ids,
            helperOrder,
            ordersByDate,
            clientUsesServerRestore,
            keepsHistory,
            orderGuardInFunction,
            deleteGuardGone,
            sameDayNullBlocked,
            sameDayNullReason,
            legitimateReversal,
            nullOriginalReversal,
            live: live ?? null,
          })
        )
      }
    }
  } catch (error) {
    fail("verifier", error.message)
  } finally {
    try {
      await cleanup()
      const residue = await db.query(
        `SELECT
           (SELECT count(*)::int FROM public.transactions
            WHERE id LIKE $1 OR serial_number LIKE $1 OR batch_id LIKE 'verify-061-%') AS transactions,
           (SELECT count(*)::int FROM public.inventory_items
            WHERE id LIKE $1 OR serial_number LIKE $1) AS inventory_items,
           (SELECT count(*)::int FROM public.batch_reversals
            WHERE batch_id LIKE 'verify-061-%') AS batch_reversals,
           (SELECT count(*)::int FROM auth.users WHERE email = $2) AS users`,
        [`${PREFIX}%`, adminEmail]
      )
      const timezoneNow = await db.query(`SELECT timezone FROM public.app_settings WHERE id`)
      const residueCounts = residue.rows[0]
      if (
        residueCounts.transactions === 0 &&
        residueCounts.inventory_items === 0 &&
        residueCounts.batch_reversals === 0 &&
        residueCounts.users === 0 &&
        timezoneNow.rows[0]?.timezone === "Africa/Harare"
      ) {
        pass("7_zero_residue", "no verify-061 rows; app_settings.timezone still Africa/Harare")
      } else {
        fail("7_zero_residue", JSON.stringify({ residue: residue.rows[0], timezone: timezoneNow.rows[0] }))
      }
    } catch (error) {
      fail("7_zero_residue", error.message)
    }
    await db.end().catch(() => {})
  }

  console.log("\n========== VERIFY 061 SUMMARY ==========")
  console.log(JSON.stringify(results, null, 2))
  console.log("========================================\n")
  if (Object.values(results).some((result) => result.result === "FAIL")) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error("VERIFY 061 FAILED:", error)
  process.exitCode = 1
})
