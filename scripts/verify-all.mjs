/**
 * Run schema rules, the HTTP probe, then every harness verify script.
 * Prints a pass/fail table. Exit 1 if any fail.
 *
 * Usage: npm run verify:all
 */
import { spawn } from "child_process"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")

/** Ordered suite. Schema rules → probe → harness scripts. */
const SUITE = [
  { id: "schema-rules", file: "scripts/verify-schema-rules.mjs" },
  { id: "probe-http", file: "scripts/probe-production-http.mjs" },
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
  { id: "movement", file: "scripts/verify-movement-transitions.mjs" },
  { id: "parity", file: "scripts/verify-transition-parity.mjs" },
]

function runNode(relPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, relPath)], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    })
    let out = ""
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString()
      out += text
      process.stdout.write(text)
    })
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString()
      out += text
      process.stderr.write(text)
    })
    child.on("close", (code) => {
      resolve({ code: code ?? 1, out })
    })
  })
}

async function main() {
  console.log(`verify:all — ${SUITE.length} steps\n`)
  const table = []
  let failed = 0

  for (const step of SUITE) {
    console.log(`\n======== ${step.id} (${step.file}) ========`)
    const started = Date.now()
    const { code } = await runNode(step.file)
    const ms = Date.now() - started
    const ok = code === 0
    if (!ok) failed += 1
    table.push({ id: step.id, result: ok ? "PASS" : "FAIL", ms, code })
    console.log(`-------- ${step.id} ${ok ? "PASS" : "FAIL"} (${Math.round(ms / 1000)}s) --------`)
  }

  console.log("\n\n========== verify:all summary ==========")
  console.log("id".padEnd(16) + "result".padEnd(8) + "seconds")
  console.log("-".repeat(40))
  for (const row of table) {
    console.log(
      row.id.padEnd(16) + row.result.padEnd(8) + String(Math.round(row.ms / 1000)).padStart(6),
    )
  }
  console.log("-".repeat(40))
  console.log(`${table.length - failed} passed, ${failed} failed`)
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
