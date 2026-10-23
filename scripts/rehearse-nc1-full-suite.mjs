/**
 * NC1 rehearsal — apply migration inside BEGIN…ROLLBACK, then run every harness
 * verify script in the same transaction (schema-rules + HTTP probe excluded).
 *
 *   node scripts/rehearse-nc1-full-suite.mjs
 *   node scripts/rehearse-nc1-full-suite.mjs --production   # ROLLBACK-only on prod
 *
 * Default DB: TEST_DATABASE_URL from .env.test.
 */
import fs from "fs"
import path from "path"
import { pathToFileURL } from "url"
import { withHarness, printVerifySummary } from "./verify-harness.mjs"
import { resetHarnessSession } from "./verify-harness-fixtures.mjs"

import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")
const MIGRATION = path.join(root, "supabase/migrations/20261015120000_nc1_client_complete.sql")
const MIGRATION_NC1F = path.join(root, "supabase/migrations/20261023150000_nc1f_multi_email.sql")

/** Same harness entries as verify-all.mjs (no schema-rules, no probe-http). */
const HARNESS_SCRIPTS = [
  { id: "065", file: "scripts/verify-065-client-transaction-resolution.mjs" },
  { id: "067", file: "scripts/verify-067-previous-status.mjs" },
  { id: "068", file: "scripts/verify-068-reversal-keeps-history.mjs" },
  { id: "069", file: "scripts/verify-069-exact-reverse-restore.mjs" },
  { id: "070", file: "scripts/verify-070-cancel-holding-extension.mjs" },
  { id: "071", file: "scripts/verify-071-stock-pools.mjs" },
  { id: "072", file: "scripts/verify-072-rental-rules.mjs" },
  { id: "073", file: "scripts/verify-073-kit-cases.mjs" },
  { id: "074", file: "scripts/verify-074-rental-to-sale.mjs" },
  { id: "075", file: "scripts/verify-075-batch-invoices.mjs" },
  { id: "076", file: "scripts/verify-076-bulk-resolve-holdings.mjs" },
  { id: "077", file: "scripts/verify-077-kit-history.mjs" },
  { id: "078", file: "scripts/verify-078-returns-report.mjs" },
  { id: "079", file: "scripts/verify-079-audit-log.mjs" },
  { id: "080", file: "scripts/verify-080-p36-movement-payload.mjs" },
  { id: "081", file: "scripts/verify-081-rq1-requests.mjs" },
  { id: "082", file: "scripts/verify-082-rq2-roles.mjs" },
  { id: "083", file: "scripts/verify-083-rq3-preview-scan.mjs" },
  { id: "084", file: "scripts/verify-084-au1-audit-trail.mjs" },
  { id: "085", file: "scripts/verify-085-lg1-set-user-access.mjs" },
  { id: "086", file: "scripts/verify-086-fb1-problem-reports.mjs" },
  { id: "087", file: "scripts/verify-087-rh1-stock-availability.mjs" },
  { id: "088", file: "scripts/verify-088-hf1-requester-flow.mjs" },
  { id: "089", file: "scripts/verify-089-mv1-archive-movement.mjs" },
  { id: "090", file: "scripts/verify-090-rq7-batch-request-context.mjs" },
  { id: "091", file: "scripts/verify-091-rq7b-batch-drawer-timeline.mjs" },
  { id: "092", file: "scripts/verify-092-rq7c-batch-request-context-lockdown.mjs" },
  { id: "093", file: "scripts/verify-093-nt1-notifications-live.mjs" },
  { id: "094", file: "scripts/verify-094-nt1c-issue-lock-advisory.mjs" },
  { id: "095", file: "scripts/verify-095-at1-atlas-outage.mjs" },
  { id: "096", file: "scripts/verify-096-nc1-client-complete.mjs" },
  { id: "movement", file: "scripts/verify-movement-transitions.mjs" },
]

async function loadAllMarkers() {
  const markers = []
  for (const entry of HARNESS_SCRIPTS) {
    const abs = path.join(root, entry.file)
    const mod = await import(pathToFileURL(abs).href)
    if (Array.isArray(mod.MARKERS)) markers.push(...mod.MARKERS)
  }
  if (markers.length === 0) {
    return [{ label: "rehearsal_noop", sql: "SELECT 0::int AS n", params: [] }]
  }
  return markers
}

async function main() {
  if (!fs.existsSync(MIGRATION)) {
    throw new Error(`Missing migration: ${MIGRATION}`)
  }
  if (!fs.existsSync(MIGRATION_NC1F)) {
    throw new Error(`Missing migration: ${MIGRATION_NC1F}`)
  }
  const sql = fs.readFileSync(MIGRATION, "utf8")
  const sqlNc1f = fs.readFileSync(MIGRATION_NC1F, "utf8")
  const markers = await loadAllMarkers()

  const { ok, passed, failed } = await withHarness(
    { markers, timeoutMs: 1_800_000, label: "nc1-full-rehearse" },
    async (ctx) => {
      console.log(`REHEARSE  applying ${path.basename(MIGRATION)} inside transaction…`)
      await ctx.db.query(sql)
      ctx.pass("nc1_migration_sql", "applied inside transaction")
      console.log(`REHEARSE  applying ${path.basename(MIGRATION_NC1F)} inside transaction…`)
      await ctx.db.query(sqlNc1f)
      ctx.pass("nc1f_migration_sql", "applied inside transaction")

      for (const entry of HARNESS_SCRIPTS) {
        console.log(`\n=== harness ${entry.id} (${entry.file}) ===`)
        const abs = path.join(root, entry.file)
        const mod = await import(pathToFileURL(abs).href)
        if (typeof mod.runChecks !== "function") {
          ctx.fail(`suite_${entry.id}`, "missing runChecks export")
          continue
        }
        const sp = `suite_${entry.id.replace(/[^a-z0-9]/gi, "_")}`
        await ctx.db.query(`SAVEPOINT ${sp}`)
        await resetHarnessSession(ctx.db)
        try {
          await mod.runChecks(ctx)
          await ctx.db.query(`RELEASE SAVEPOINT ${sp}`)
        } catch (error) {
          await ctx.db.query(`ROLLBACK TO SAVEPOINT ${sp}`)
          const msg = error instanceof Error ? error.message : String(error)
          ctx.fail(`suite_${entry.id}_throw`, msg)
        }
        await resetHarnessSession(ctx.db)
      }
    },
  )

  printVerifySummary(ok, passed, failed)
  process.exitCode = ok && failed === 0 && passed > 0 ? 0 : 1
}

main().catch((error) => {
  console.error(error)
  printVerifySummary(false, 0, 1)
  process.exitCode = 1
})
