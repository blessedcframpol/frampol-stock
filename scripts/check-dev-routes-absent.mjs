/**
 * After `next build`, prove development-only routes are not in the output.
 * Usage: node scripts/check-dev-routes-absent.mjs
 */
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const NEXT = path.join(ROOT, ".next")
const NEEDLE = "rq3-issue-preview"

if (!fs.existsSync(NEXT)) {
  console.error("FAIL  .next missing — run next build first")
  process.exit(1)
}

const hits = []

function walk(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      // Skip Next caches and leftover `next dev` output — only production artifacts count.
      if (entry.name === "cache" || entry.name === "node_modules" || entry.name === "dev") continue
      if (entry.name.includes(NEEDLE)) hits.push(full)
      walk(full)
    } else if (entry.name.includes(NEEDLE)) {
      hits.push(full)
    }
  }
}

// Prefer production app paths; still walk .next skipping the `dev` cache folder.
const serverApp = path.join(NEXT, "server", "app")
if (fs.existsSync(serverApp)) walk(serverApp)
else walk(NEXT)

if (hits.length > 0) {
  console.error(`FAIL  found ${NEEDLE} in production build output:`)
  for (const h of hits.slice(0, 20)) console.error(`  ${path.relative(ROOT, h)}`)
  process.exit(1)
}

console.log(`PASS  ${NEEDLE} absent from .next build output`)
