/**
 * Rebuild the TEST database from scratch:
 *   clone-schema → refresh → bootstrap
 *
 *   npm run test-db:reset
 *
 * Never touches production.
 */
import { spawnSync } from "child_process"
import path from "path"
import { fileURLToPath } from "url"
import { createRequire } from "module"

const require = createRequire(import.meta.url)
const { loadVerifyEnv, resolveHarnessDbUrl, PRODUCTION_SUPABASE_REF } = require("./verify-env.cjs")

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

loadVerifyEnv({ production: false })
const { production, ref } = resolveHarnessDbUrl(false)
if (production || ref === PRODUCTION_SUPABASE_REF) {
  throw new Error("test-db-reset refuses production")
}

const steps = [
  "scripts/test-db-clone-schema.mjs",
  "scripts/test-db-refresh.mjs",
  "scripts/test-db-bootstrap.mjs",
]

console.log(`test-db:reset → ref=${ref}`)
for (const script of steps) {
  console.log(`\n======== ${script} ========`)
  const r = spawnSync(
    process.execPath,
    ["--require", "./scripts/dev/tls-classic.cjs", script],
    { cwd: root, stdio: "inherit", env: process.env },
  )
  if (r.status !== 0) {
    console.error(`test-db:reset failed at ${script} (exit ${r.status})`)
    process.exit(r.status ?? 1)
  }
}
console.log(`\ntest-db:reset complete for ${ref}`)
